/**
 * Leonardo.Ai sound-effect generation.
 *
 * ── VERIFICATION CAVEAT ────────────────────────────────────────────────────
 * The REQUEST contract below is quoted from Leonardo's published Sound Effects
 * v2 guide: `model`, `prompt` (max 9999 chars), `duration` (whole seconds,
 * 1..22, default 2), `prompt_influence` (0..1, default 0.7), `loop`,
 * `quantity` (1..4), `public`.
 *
 * The RESPONSE shape and the retrieval mechanism are NOT documented. This
 * client therefore reads the generation id and the audio URLs from several
 * plausible locations and, when none match, throws with the raw payload
 * attached rather than returning an empty success. The first live call will
 * settle it; until then this provider is unverified and says so.
 *
 * Note the endpoint is **v2** — distinct from the v1 `/generations` the image
 * provider uses. They are different APIs that happen to share a path segment.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { requestJson } from '../../util/http.js';
import { AssetPipelineError, invalidInput } from '../../util/errors.js';
import type {
  AudioGenerationHandle,
  AudioGenerationResult,
  AudioProvider,
  GenerateSoundEffectOptions,
  GeneratedAudio,
} from './types.js';

const DEFAULT_BASE_URL = 'https://cloud.leonardo.ai/api/rest';

/** Documented model id for sound effects. */
export const LEONARDO_SOUND_EFFECTS_MODEL = 'sound-effects-v2';

/** Documented bounds. Values outside these are refused, not silently clamped. */
export const SOUND_EFFECT_MIN_SECONDS = 1;
export const SOUND_EFFECT_MAX_SECONDS = 22;
export const SOUND_EFFECT_MAX_QUANTITY = 4;
export const SOUND_EFFECT_MAX_PROMPT = 9999;

export interface LeonardoAudioOptions {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
}

/** Pull the first string at any of the given dotted paths. */
function pick(payload: unknown, paths: string[]): string | undefined {
  for (const dotted of paths) {
    let cursor: unknown = payload;
    for (const key of dotted.split('.')) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === 'string' && cursor.length > 0) return cursor;
  }
  return undefined;
}

/** Collect audio URLs from whichever array shape the provider used. */
function collectAudio(payload: unknown): GeneratedAudio[] {
  const found: GeneratedAudio[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of ['url', 'audioUrl', 'audio_url', 'generated_audio_url', 'motionMP4URL']) {
      const value = record[key];
      // Only accept things that actually look like audio, so a preview image
      // URL cannot be mistaken for the asset.
      if (typeof value === 'string' && /\.(wav|mp3|ogg|flac|m4a|aac)(\?|$)/i.test(value)) {
        if (!seen.has(value)) {
          seen.add(value);
          const id = record.id;
          const duration = record.duration ?? record.durationSeconds;
          found.push({
            url: value,
            ...(typeof id === 'string' ? { providerAudioId: id } : {}),
            ...(typeof duration === 'number' ? { durationSeconds: duration } : {}),
          });
        }
      }
    }
    for (const value of Object.values(record)) visit(value, depth + 1);
  };

  visit(payload, 0);
  return found;
}

export class LeonardoAudioProvider implements AudioProvider {
  readonly name = 'leonardo';
  readonly defaultModel = LEONARDO_SOUND_EFFECTS_MODEL;
  private readonly baseUrl: string;

  constructor(private readonly options: LeonardoAudioOptions) {
    this.baseUrl = (options.baseUrl ?? process.env.LEONARDO_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      '',
    );
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}` };
  }

  async generateSoundEffect(options: GenerateSoundEffectOptions): Promise<AudioGenerationHandle> {
    const prompt = options.prompt.trim();
    if (prompt.length === 0) throw invalidInput('sound-effect prompt is empty');
    if (prompt.length > SOUND_EFFECT_MAX_PROMPT) {
      throw invalidInput(`prompt exceeds ${SOUND_EFFECT_MAX_PROMPT} characters`);
    }

    // Refuse out-of-range values rather than clamping: a caller who asked for a
    // 60-second loop and silently received 22 would ship the wrong asset.
    const duration = options.durationSeconds;
    if (duration !== undefined) {
      if (!Number.isInteger(duration) || duration < SOUND_EFFECT_MIN_SECONDS || duration > SOUND_EFFECT_MAX_SECONDS) {
        throw invalidInput(
          `duration must be a whole number of seconds between ${SOUND_EFFECT_MIN_SECONDS} and ${SOUND_EFFECT_MAX_SECONDS}`,
          { received: duration },
        );
      }
    }
    const quantity = options.quantity;
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > SOUND_EFFECT_MAX_QUANTITY)) {
      throw invalidInput(`quantity must be between 1 and ${SOUND_EFFECT_MAX_QUANTITY}`, {
        received: quantity,
      });
    }
    const influence = options.promptInfluence;
    if (influence !== undefined && (!Number.isFinite(influence) || influence < 0 || influence > 1)) {
      throw invalidInput('promptInfluence must be between 0 and 1', { received: influence });
    }

    // retries: 0 — this SPENDS CREDITS. A retry after the server accepted the
    // request would generate and bill twice.
    const response = await requestJson<unknown>(`${this.baseUrl}/v2/generations`, {
      method: 'POST',
      headers: this.headers(),
      timeoutMs: this.options.timeoutMs,
      retries: 0,
      body: {
        model: LEONARDO_SOUND_EFFECTS_MODEL,
        prompt,
        ...(duration !== undefined ? { duration } : {}),
        ...(influence !== undefined ? { prompt_influence: influence } : {}),
        ...(options.loop !== undefined ? { loop: options.loop } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
        public: false,
      },
    });

    const generationId = pick(response.data, [
      'sdGenerationJob.generationId',
      'generationId',
      'id',
      'data.id',
      'generation.id',
    ]);
    if (!generationId) {
      throw new AssetPipelineError(
        'PROVIDER_MALFORMED_RESPONSE',
        'Leonardo accepted the sound-effect request but no generation id was found in the response. ' +
          'The v2 response shape is undocumented; report this payload shape so the client can be corrected.',
        { details: { keys: shallowKeys(response.data) } },
      );
    }
    return { providerGenerationId: generationId };
  }

  /** Poll. Idempotent, so transient failures may retry. */
  async getGeneration(providerGenerationId: string): Promise<AudioGenerationResult> {
    const response = await requestJson<unknown>(
      `${this.baseUrl}/v1/generations/${encodeURIComponent(providerGenerationId)}`,
      { headers: this.headers(), timeoutMs: this.options.timeoutMs, retries: 3 },
    );

    const rawStatus = pick(response.data, [
      'generations_by_pk.status',
      'status',
      'generation.status',
    ]) ?? 'PENDING';

    const audio = collectAudio(response.data);
    const failed = rawStatus.toUpperCase() === 'FAILED';

    return {
      providerGenerationId,
      rawStatus,
      audio,
      // A provider-side failure is a RESULT, not an exception: the caller needs
      // its job record updated, not a thrown error it must guess about.
      ...(failed
        ? { errorMessage: `Leonardo reported status ${rawStatus} for ${providerGenerationId}` }
        : {}),
      raw: response.data,
    };
  }
}

function shallowKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>).slice(0, 20);
}
