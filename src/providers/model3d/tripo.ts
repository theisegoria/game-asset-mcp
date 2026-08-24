/**
 * Tripo 3D provider.
 *
 * ── ENDPOINT CAVEAT ────────────────────────────────────────────────────────
 * Tripo's public documentation describes the v3 surface in two ways: a generic
 * task endpoint (`POST /task` + `GET /task/{id}`) and per-operation paths
 * (`POST /generation/text-to-model`). Both appear in current docs. This client
 * implements the TASK form, which matches the observable behaviour that every
 * generation returns a `task_id` for polling, and exposes `TRIPO_BASE_URL` so
 * a user can retarget without a code change.
 *
 * The paths below are the FIRST thing the live smoke test verifies. They are
 * marked here rather than silently assumed, because a wrong path fails with a
 * 404 that looks exactly like a bad key.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * All Tripo responses share an envelope: `{ code, data, message }` where a
 * non-zero `code` is a failure even when the HTTP status is 200. Treating
 * HTTP 200 as success here would report a failed generation as a success —
 * so the envelope is checked on every call.
 */

import { requestJson } from '../../util/http.js';
import { AssetPipelineError } from '../../util/errors.js';
import type {
  GenerateFromImageOptions,
  GenerateFromTextOptions,
  Model3DProvider,
  Model3DTaskHandle,
  Model3DTaskResult,
  TextureExistingOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://openapi.tripo3d.ai/v3';

/** Model version used when the caller does not pin one. */
export const TRIPO_DEFAULT_MODEL_VERSION = 'v3.0-20250812';

interface TripoEnvelope<T> {
  code: number;
  data: T;
  message?: string;
}

interface TripoTaskCreated {
  task_id: string;
}

interface TripoTaskState {
  task_id: string;
  type?: string;
  status: string;
  progress?: number;
  input?: Record<string, unknown>;
  output?: {
    model?: string;
    pbr_model?: string;
    rendered_image?: string;
    base_model?: string;
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string };
  /** Tripo reports consumed credits on some task types. */
  credits?: number;
}

interface TripoUploaded {
  image_token?: string;
  file_token?: string;
  /** Some responses use `token`. Accepted so an upload is not lost to naming. */
  token?: string;
}

export interface TripoClientOptions {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
}

export class TripoProvider implements Model3DProvider {
  readonly name = 'tripo';
  private readonly baseUrl: string;

  constructor(private readonly options: TripoClientOptions) {
    this.baseUrl = (options.baseUrl ?? process.env.TRIPO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}` };
  }

  /** Unwrap Tripo's envelope, turning a non-zero `code` into a real error. */
  private unwrap<T>(envelope: TripoEnvelope<T> | undefined, context: string): T {
    if (!envelope || typeof envelope !== 'object') {
      throw new AssetPipelineError(
        'PROVIDER_MALFORMED_RESPONSE',
        `Tripo returned an empty response for ${context}`,
      );
    }
    if (envelope.code !== 0) {
      throw new AssetPipelineError(
        'PROVIDER_HTTP',
        `Tripo rejected ${context}: code=${envelope.code}${envelope.message ? ` ${envelope.message}` : ''}`,
        { details: { code: envelope.code, context } },
      );
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new AssetPipelineError(
        'PROVIDER_MALFORMED_RESPONSE',
        `Tripo returned code=0 but no data for ${context}`,
      );
    }
    return envelope.data;
  }

  private async upload(bytes: Uint8Array, fileName: string, context: string): Promise<string> {
    const form = new FormData();
    // Copy into a fresh ArrayBuffer: a Uint8Array view may be a window onto a
    // larger pooled buffer, and Blob would otherwise capture the whole pool.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append('file', new Blob([copy]), fileName);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/upload/sts`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new AssetPipelineError(
          'PROVIDER_HTTP',
          `Tripo ${context} upload failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
          { details: { status: response.status } },
        );
      }
      let parsed: TripoEnvelope<TripoUploaded>;
      try {
        parsed = JSON.parse(text) as TripoEnvelope<TripoUploaded>;
      } catch {
        throw new AssetPipelineError(
          'PROVIDER_MALFORMED_RESPONSE',
          `Tripo ${context} upload returned non-JSON: ${text.slice(0, 200)}`,
        );
      }
      const data = this.unwrap(parsed, `${context} upload`);
      const token = data.image_token ?? data.file_token ?? data.token;
      if (!token) {
        throw new AssetPipelineError(
          'PROVIDER_MALFORMED_RESPONSE',
          `Tripo ${context} upload returned no token`,
          { details: { keys: Object.keys(data) } },
        );
      }
      return token;
    } finally {
      clearTimeout(timer);
    }
  }

  async uploadImage(bytes: Uint8Array, fileName: string): Promise<string> {
    return this.upload(bytes, fileName, 'image');
  }

  async uploadModel(bytes: Uint8Array, fileName: string): Promise<string> {
    return this.upload(bytes, fileName, 'model');
  }

  /**
   * Create a task.
   *
   * `retries: 0` is not an oversight — this call SPENDS CREDITS. A network
   * error after Tripo accepted the request is indistinguishable from one
   * before, so an automatic retry can double-charge the user.
   */
  private async createTask(body: Record<string, unknown>): Promise<Model3DTaskHandle> {
    const response = await requestJson<TripoEnvelope<TripoTaskCreated>>(`${this.baseUrl}/task`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      timeoutMs: this.options.timeoutMs,
      retries: 0,
    });
    const data = this.unwrap(response.data, `task ${String(body.type)}`);
    if (!data.task_id) {
      throw new AssetPipelineError('PROVIDER_MALFORMED_RESPONSE', 'Tripo returned no task_id');
    }
    return { providerTaskId: data.task_id };
  }

  async generateFromImage(options: GenerateFromImageOptions): Promise<Model3DTaskHandle> {
    if (!options.imageToken && !options.imageUrl) {
      throw new AssetPipelineError('INVALID_INPUT', 'generateFromImage needs imageToken or imageUrl');
    }
    if (options.imageToken && options.imageUrl) {
      throw new AssetPipelineError(
        'INVALID_INPUT',
        'generateFromImage accepts imageToken OR imageUrl, not both',
      );
    }
    return this.createTask({
      type: 'image_to_model',
      model_version: options.modelVersion ?? TRIPO_DEFAULT_MODEL_VERSION,
      file: options.imageToken ? { file_token: options.imageToken } : { url: options.imageUrl },
      ...(options.pbr !== undefined ? { pbr: options.pbr } : {}),
      ...(options.texture !== undefined ? { texture: options.texture } : {}),
      ...(options.textureQuality ? { texture_quality: options.textureQuality } : {}),
      ...(options.faceLimit !== undefined ? { face_limit: options.faceLimit } : {}),
      ...(options.quad !== undefined ? { quad: options.quad } : {}),
      ...(options.seed !== undefined ? { model_seed: options.seed } : {}),
      ...(options.autoSize !== undefined ? { auto_size: options.autoSize } : {}),
      ...(options.imageAutofix !== undefined ? { auto_fix: options.imageAutofix } : {}),
    });
  }

  async generateFromText(options: GenerateFromTextOptions): Promise<Model3DTaskHandle> {
    return this.createTask({
      type: 'text_to_model',
      model_version: options.modelVersion ?? TRIPO_DEFAULT_MODEL_VERSION,
      prompt: options.prompt,
      ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
      ...(options.pbr !== undefined ? { pbr: options.pbr } : {}),
      ...(options.texture !== undefined ? { texture: options.texture } : {}),
      ...(options.textureQuality ? { texture_quality: options.textureQuality } : {}),
      ...(options.faceLimit !== undefined ? { face_limit: options.faceLimit } : {}),
      ...(options.quad !== undefined ? { quad: options.quad } : {}),
      ...(options.seed !== undefined ? { model_seed: options.seed } : {}),
    });
  }

  async textureExisting(options: TextureExistingOptions): Promise<Model3DTaskHandle> {
    if (!options.originalModelTaskId && !options.modelToken) {
      throw new AssetPipelineError(
        'INVALID_INPUT',
        'textureExisting needs originalModelTaskId (a prior Tripo task) or modelToken (an uploaded mesh)',
      );
    }
    if (options.prompt && options.imageToken) {
      throw new AssetPipelineError(
        'INVALID_INPUT',
        'texture direction accepts a text prompt OR an image, not both',
      );
    }

    const texturePrompt: Record<string, unknown> = {};
    if (options.prompt) texturePrompt.text = options.prompt;
    if (options.imageToken) texturePrompt.image = { file_token: options.imageToken };
    if (options.styleImageToken) texturePrompt.style_image = { file_token: options.styleImageToken };

    return this.createTask({
      type: 'texture_model',
      model_version: options.modelVersion ?? TRIPO_DEFAULT_MODEL_VERSION,
      ...(options.originalModelTaskId
        ? { original_model_task_id: options.originalModelTaskId }
        : { file: { file_token: options.modelToken } }),
      ...(Object.keys(texturePrompt).length > 0 ? { texture_prompt: texturePrompt } : {}),
      texture: true,
      ...(options.pbr !== undefined ? { pbr: options.pbr } : { pbr: true }),
      ...(options.textureQuality ? { texture_quality: options.textureQuality } : {}),
      ...(options.textureAlignment ? { texture_alignment: options.textureAlignment } : {}),
      ...(options.textureSeed !== undefined ? { texture_seed: options.textureSeed } : {}),
      ...(options.bake !== undefined ? { bake: options.bake } : {}),
    });
  }

  /** Poll a task. Idempotent, so transient failures retry. */
  async getTask(providerTaskId: string): Promise<Model3DTaskResult> {
    const response = await requestJson<TripoEnvelope<TripoTaskState>>(
      `${this.baseUrl}/task/${encodeURIComponent(providerTaskId)}`,
      {
        headers: this.authHeaders(),
        timeoutMs: this.options.timeoutMs,
        retries: 3,
      },
    );
    const data = this.unwrap(response.data, `task ${providerTaskId}`);
    const output = data.output ?? {};

    return {
      providerTaskId: data.task_id ?? providerTaskId,
      rawStatus: data.status,
      ...(output.model || output.base_model
        ? { modelUrl: output.model ?? output.base_model }
        : {}),
      ...(output.pbr_model ? { pbrModelUrl: output.pbr_model } : {}),
      ...(output.rendered_image ? { renderedImageUrl: output.rendered_image } : {}),
      ...(data.progress !== undefined ? { progress: data.progress } : {}),
      ...(data.credits !== undefined ? { creditCost: data.credits } : {}),
      ...(data.error?.message ? { errorMessage: data.error.message } : {}),
      raw: data,
    };
  }
}
