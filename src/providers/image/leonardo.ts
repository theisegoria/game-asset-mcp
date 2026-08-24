/**
 * Leonardo.Ai image provider.
 *
 * Two-step surface: `POST /generations` accepts the request and returns only an
 * id, then `GET /generations/{id}` is polled until the images exist. The create
 * call is the one that SPENDS CREDITS, so everything about it is deliberately
 * un-clever — no retries, no hidden defaults that could multiply cost.
 *
 * ── THE NULL-PK TRAP ───────────────────────────────────────────────────────
 * `generations_by_pk` comes back `null` for a short window after create, while
 * the row is still being materialized. Treating that as an error aborts a
 * perfectly healthy generation the caller already paid for; treating it as
 * success reports an asset that does not exist. It is neither — it is PENDING.
 *
 * The cost of that choice: a genuinely unknown generation id returns the same
 * `null`, so it is indistinguishable from a not-yet-created one. Polling must
 * therefore be bounded by the CALLER, which is where the deadline belongs
 * anyway — this client has no idea how long the caller is willing to wait.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { assertHttps, requestJson } from '../../util/http.js';
import { AssetPipelineError, invalidInput } from '../../util/errors.js';
import { fromLeonardoStatus } from '../../domain/status.js';
import type {
  GeneratedImage,
  GenerateImageOptions,
  ImageGenerationHandle,
  ImageGenerationResult,
  ImageProvider,
} from './types.js';

const DEFAULT_BASE_URL = 'https://cloud.leonardo.ai/api/rest/v1';

/**
 * Known platform model ids.
 *
 * These are opaque provider ids, not stable API surface — Leonardo retires and
 * re-versions models, so any id here can stop resolving. `GET /platformModels`
 * is the authority. Every entry is overridable per call via
 * `GenerateImageOptions.modelId`, and the default is overridable process-wide
 * with `LEONARDO_MODEL_ID`, so a stale constant here is never a dead end.
 *
 * ⚠ Transcribed from Leonardo's published model list at authoring time and NOT
 * verified against a live account. A wrong id surfaces as an HTTP 400 that
 * reads like a malformed request body — check these values FIRST when a create
 * call 400s with an otherwise valid payload.
 */
export const LEONARDO_MODEL_IDS = {
  /** Current flagship. Strong prompt adherence and clean backgrounds, which is what reconstruction references need. */
  lucidOrigin: '7b592283-089a-42a9-a0bb-2c7bb0d1b6f4',
  phoenix10: 'de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3',
  fluxDev: 'b2614463-296c-462a-9586-aafdb8f00e36',
  kinoXL: 'aa77f04e-3eec-4034-9c07-d0f619684628',
  lightningXL: 'b24e16ff-06e3-43eb-8d33-4416c2d75876',
  albedoBaseXL: '2067ae52-33fd-4a82-bb92-c2c55e7d2786',
} as const;

export const LEONARDO_DEFAULT_MODEL_ID: string = LEONARDO_MODEL_IDS.lucidOrigin;

/**
 * Latent-space geometry, not a stylistic preference: the diffusion latent is
 * 1/8 the pixel size, so a dimension that is not a multiple of 8 has no exact
 * latent and the API rejects it. Both bounds below are themselves multiples of
 * 8, so snapping a clamped value can never push it back out of range.
 */
const DIMENSION_MULTIPLE = 8;
const MIN_DIMENSION = 32;
const MAX_DIMENSION = 1536;
const DEFAULT_DIMENSION = 1024;

/** Documented ceiling. The effective limit is lower for some model/size combinations, so the provider still has final say. */
const MAX_IMAGES_PER_GENERATION = 8;

interface LeonardoCreateResponse {
  sdGenerationJob?: {
    generationId?: string | null;
    apiCreditCost?: number | null;
  } | null;
}

interface LeonardoImagePayload {
  id?: string | null;
  url?: string | null;
}

interface LeonardoGenerationPayload {
  id?: string | null;
  status?: string | null;
  generated_images?: (LeonardoImagePayload | null)[] | null;
  prompt?: string | null;
  seed?: number | null;
  imageHeight?: number | null;
  imageWidth?: number | null;
  modelId?: string | null;
}

interface LeonardoGenerationResponse {
  generations_by_pk?: LeonardoGenerationPayload | null;
}

export interface LeonardoClientOptions {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
}

/**
 * Snap a requested dimension onto the provider's grid.
 *
 * Rounding rather than rejecting, because the multiple-of-8 rule is a mechanical
 * property of the model — not something the caller expressed an opinion about.
 * Failing a request over a 4-pixel difference would surface an implementation
 * detail as a user error. Counts, by contrast, ARE a caller decision and are
 * rejected below rather than quietly adjusted.
 */
function snapDimension(value: number | undefined, label: string): number {
  if (value === undefined) return DEFAULT_DIMENSION;
  if (!Number.isFinite(value) || value <= 0) {
    throw invalidInput(`${label} must be a positive number`, { [label]: value });
  }
  const clamped = Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(value)));
  return Math.round(clamped / DIMENSION_MULTIPLE) * DIMENSION_MULTIPLE;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export class LeonardoProvider implements ImageProvider {
  readonly name = 'leonardo';
  readonly defaultModelId: string;
  private readonly baseUrl: string;

  constructor(private readonly options: LeonardoClientOptions) {
    const configuredBase = (options.baseUrl ?? process.env.LEONARDO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    // Validated at construction, matching the Tripo client: a misconfigured
    // base must not be able to reach a request carrying the API key. The
    // shared HTTP layer would refuse it later anyway; failing here makes the
    // reason obvious instead of surfacing at the first call.
    assertHttps(configuredBase);
    this.baseUrl = configuredBase;
    // Env override exists so a retired model id can be worked around without a
    // release, since model ids churn faster than this package will.
    this.defaultModelId = process.env.LEONARDO_MODEL_ID?.trim() || LEONARDO_DEFAULT_MODEL_ID;
  }

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
    };
  }

  /**
   * Start a generation.
   *
   * `retries: 0` is load-bearing, not an oversight — this call SPENDS CREDITS.
   * A network error after Leonardo accepted the request is indistinguishable
   * from one before it, so an automatic retry can silently double-charge the
   * user and orphan the first generation.
   */
  async generate(options: GenerateImageOptions): Promise<ImageGenerationHandle> {
    const prompt = options.prompt.trim();
    if (prompt.length === 0) {
      throw invalidInput('generate requires a non-empty prompt');
    }
    if (options.numImages !== undefined) {
      if (!Number.isInteger(options.numImages) || options.numImages < 1) {
        throw invalidInput('numImages must be a positive integer', { numImages: options.numImages });
      }
      if (options.numImages > MAX_IMAGES_PER_GENERATION) {
        throw invalidInput(
          `numImages exceeds Leonardo's per-generation limit of ${MAX_IMAGES_PER_GENERATION}`,
          { numImages: options.numImages, limit: MAX_IMAGES_PER_GENERATION },
        );
      }
    }
    if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0)) {
      throw invalidInput('seed must be a non-negative integer', { seed: options.seed });
    }
    if (options.initStrength !== undefined && options.initImageId === undefined) {
      throw invalidInput('initStrength only applies alongside initImageId');
    }

    const body: Record<string, unknown> = {
      prompt,
      modelId: options.modelId ?? this.defaultModelId,
      width: snapDimension(options.width, 'width'),
      height: snapDimension(options.height, 'height'),
      // Sent explicitly rather than inheriting a provider-side default, because
      // credit cost scales directly with this number.
      num_images: options.numImages ?? 1,
      ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
      ...(options.guidanceScale !== undefined ? { guidance_scale: options.guidanceScale } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.initImageId ? { init_image_id: options.initImageId } : {}),
      ...(options.initStrength !== undefined ? { init_strength: options.initStrength } : {}),
    };
    // `alchemy` and `contrast` are deliberately NOT sent. They are coupled —
    // enabling alchemy forces a minimum contrast on several models — and the
    // ImageProvider contract gives the caller no way to set either, so guessing
    // a pair here would silently change both cost and look.

    const response = await requestJson<LeonardoCreateResponse>(`${this.baseUrl}/generations`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      timeoutMs: this.options.timeoutMs,
      retries: 0,
    });

    const generationId = response.data?.sdGenerationJob?.generationId;
    if (!generationId) {
      throw new AssetPipelineError(
        'PROVIDER_MALFORMED_RESPONSE',
        'Leonardo accepted the generation but returned no generationId',
        { details: { keys: Object.keys(response.data ?? {}) } },
      );
    }

    // No rawStatus: the create response carries no status field, and inventing
    // one would be reporting a provider state we were never told. The reported
    // `apiCreditCost` is likewise dropped — the handle contract has no field
    // for it — so cost accounting has to come from the account, not from here.
    return { providerGenerationId: generationId };
  }

  /** Poll a generation. Idempotent and free, so transient failures retry. */
  async getGeneration(providerGenerationId: string): Promise<ImageGenerationResult> {
    if (providerGenerationId.trim().length === 0) {
      throw invalidInput('getGeneration requires a generation id');
    }

    const response = await requestJson<LeonardoGenerationResponse>(
      `${this.baseUrl}/generations/${encodeURIComponent(providerGenerationId)}`,
      {
        headers: this.authHeaders(),
        timeoutMs: this.options.timeoutMs,
        retries: 3,
      },
    );

    // The whole envelope is kept as `raw`, not just the inner object, because
    // the still-pending case has no inner object to keep.
    const payload = response.data?.generations_by_pk;
    if (payload === null || payload === undefined) {
      return {
        providerGenerationId,
        rawStatus: 'PENDING',
        images: [],
        raw: response.data,
      };
    }

    const rawStatus = payload.status ?? 'PENDING';
    const mapped = fromLeonardoStatus(rawStatus);

    // Generation-level facts: Leonardo reports one seed and one size for the
    // whole batch, not per image. Recorded on each image anyway because the
    // seed plus the index is what actually reproduces a given result.
    const seed = isFiniteNumber(payload.seed) ? payload.seed : undefined;
    const width = isFiniteNumber(payload.imageWidth) ? payload.imageWidth : undefined;
    const height = isFiniteNumber(payload.imageHeight) ? payload.imageHeight : undefined;

    const returned = payload.generated_images ?? [];
    const images: GeneratedImage[] = [];
    for (const image of returned) {
      if (!image?.url) continue;
      images.push({
        url: image.url,
        ...(image.id ? { providerImageId: image.id } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      });
    }

    // Entries that exist but carry no url are a shape we do not understand —
    // that is a malformed response, not a content outcome, and swallowing it
    // would report an empty success.
    if (returned.length > 0 && images.length === 0) {
      throw new AssetPipelineError(
        'PROVIDER_MALFORMED_RESPONSE',
        `Leonardo returned ${returned.length} image entries with no usable url`,
        { details: { generationId: providerGenerationId, status: rawStatus } },
      );
    }

    // A provider-side failure is reported, not thrown: the caller owns a job
    // record that has to be moved to `failed` with a reason attached, and an
    // exception would destroy the status it needs to write. Leonardo's
    // documented payload carries no error field, so the message is synthesized
    // from the status — the account's generation history holds the real cause.
    let errorMessage: string | undefined;
    if (mapped === 'failed') {
      errorMessage = `Leonardo reported status ${rawStatus} for generation ${providerGenerationId}`;
    } else if (mapped === 'reference_ready' && images.length === 0) {
      errorMessage = 'Leonardo completed the generation with zero images (content moderation is the usual cause)';
    }

    return {
      providerGenerationId: payload.id ?? providerGenerationId,
      rawStatus,
      images,
      ...(errorMessage ? { errorMessage } : {}),
      raw: response.data,
    };
  }
}
