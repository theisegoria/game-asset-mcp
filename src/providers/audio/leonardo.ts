/**
 * Leonardo.Ai sound-effect generation.
 *
 * ── VERIFICATION CAVEAT ────────────────────────────────────────────────────
 * The REQUEST contract below is quoted from Leonardo's published Sound Effects
 * v2 guide: top-level `model` and `public`, plus a `parameters` object carrying
 * `prompt` (max 9999 chars), `duration` (whole seconds, 1..22, default 2),
 * `prompt_influence` (0..1, default 0.7), `loop`, and `quantity` (1..4).
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

import { assertHttps, requestJson } from '../../util/http.js';
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

const AUDIO_EXTENSION = /\.(wav|mp3|ogg|flac|m4a|aac)(\?|$)/i;
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|svg)(\?|$)/i;
/** Keys whose very name says the value is audio, whatever the URL looks like. */
const AUDIO_KEYS = new Set([
  'audiourl',
  'audio_url',
  'generated_audio_url',
  'generatedaudiourl',
  'soundurl',
  'sound_url',
  'sfxurl',
]);
/** Containers that hold audio, so a bare `url` inside one is audio too. */
const AUDIO_CONTAINERS = new Set([
  'audio',
  'audios',
  'generated_audio',
  'generatedaudio',
  'sound',
  'sounds',
  'soundeffects',
  'sound_effects',
]);

/**
 * Collect audio URLs from whichever shape the provider used.
 *
 * Two rules, because either alone is wrong. Extension-only would REJECT a valid
 * signed CDN URL that carries no extension — common, and it would look exactly
 * like an eternal pending. Key-name-only would ACCEPT a preview image sitting
 * under a generic `url`. So a URL qualifies if its key or its container names
 * audio, or if it simply ends in an audio extension — and an image extension
 * disqualifies it either way.
 */
function collectAudio(payload: unknown): GeneratedAudio[] {
  const found: GeneratedAudio[] = [];
  const seen = new Set<string>();

  const consider = (value: unknown, key: string, container: string, record: Record<string, unknown>): void => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (!/^https?:\/\//i.test(value)) return;
    if (IMAGE_EXTENSION.test(value)) return;

    const named = AUDIO_KEYS.has(key.toLowerCase());
    const contained = AUDIO_CONTAINERS.has(container.toLowerCase()) && key.toLowerCase() === 'url';
    if (!named && !contained && !AUDIO_EXTENSION.test(value)) return;
    if (seen.has(value)) return;

    seen.add(value);
    const id = record.id;
    const duration = record.duration ?? record.durationSeconds ?? record.duration_seconds;
    found.push({
      url: value,
      ...(typeof id === 'string' ? { providerAudioId: id } : {}),
      ...(typeof duration === 'number' ? { durationSeconds: duration } : {}),
    });
  };

  const visit = (node: unknown, depth: number, container: string): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, container);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      consider(value, key, container, record);
      // Descend with this key as the container name, so a bare `url` nested in
      // `generated_audio` is recognised by where it lives.
      visit(value, depth + 1, key);
    }
  };

  visit(payload, 0, '');
  return found;
}

export class LeonardoAudioProvider implements AudioProvider {
  readonly name = 'leonardo';
  readonly defaultModel = LEONARDO_SOUND_EFFECTS_MODEL;
  private readonly baseUrl: string;

  constructor(private readonly options: LeonardoAudioOptions) {
    const configuredBase = (options.baseUrl ?? process.env.LEONARDO_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      '',
    );
    // Validated at construction, matching the Tripo client: a misconfigured
    // base must not be able to reach a request carrying the API key. The
    // shared HTTP layer would refuse it later anyway; failing here makes the
    // reason obvious instead of surfacing at the first call.
    assertHttps(configuredBase);
    this.baseUrl = configuredBase;
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
        public: false,
        parameters: {
          prompt,
          ...(duration !== undefined ? { duration } : {}),
          ...(influence !== undefined ? { prompt_influence: influence } : {}),
          ...(options.loop !== undefined ? { loop: options.loop } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
        },
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

  /**
   * Poll. Idempotent, so transient failures may retry.
   *
   * The generation was created on v2, so v2 is tried first; but the only
   * retrieval endpoint Leonardo actually documents is v1, so a 404 falls back
   * rather than failing. Whichever answered is reported, so the first live run
   * tells us which is correct instead of leaving it a guess forever.
   */
  async getGeneration(providerGenerationId: string): Promise<AudioGenerationResult> {
    const id = encodeURIComponent(providerGenerationId);
    let data: unknown;
    let servedBy = 'v2';
    try {
      const response = await requestJson<unknown>(`${this.baseUrl}/v2/generations/${id}`, {
        headers: this.headers(),
        timeoutMs: this.options.timeoutMs,
        retries: 3,
      });
      data = response.data;
    } catch (err) {
      const status = (err as AssetPipelineError).details?.status;
      if (status !== 404 && status !== 405) throw err;
      const response = await requestJson<unknown>(`${this.baseUrl}/v1/generations/${id}`, {
        headers: this.headers(),
        timeoutMs: this.options.timeoutMs,
        retries: 3,
      });
      data = response.data;
      servedBy = 'v1';
    }

    const rawStatus =
      pick(data, ['generations_by_pk.status', 'status', 'generation.status', 'data.status']) ??
      'PENDING';
    const audio = collectAudio(data);
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
      // When the provider says COMPLETE but nothing parsed, surface the shape so
      // a user can report it — silence here reads as an eternal pending.
      ...(!failed && audio.length === 0 && rawStatus.toUpperCase() === 'COMPLETE'
        ? {
            errorMessage:
              `Leonardo reported COMPLETE but no audio URL was recognised (served by ${servedBy}). ` +
              `Top-level keys: ${shallowKeys(data).join(', ') || '(none)'}. ` +
              'Please report this payload shape so the client can be corrected.',
          }
        : {}),
      raw: data,
    };
  }
}

function shallowKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>).slice(0, 20);
}
