/**
 * Shared plumbing for every tool.
 *
 * Providers are resolved lazily through accessor functions rather than being
 * constructed at startup. That is what lets the server run with only one
 * provider configured: a user who only wants 3D generation never needs an
 * image-provider account, and the image tools report a clear CONFIG_MISSING
 * instead of the process refusing to boot.
 */

import type { Config } from '../config.js';
import { requireLeonardoKey, requireTripoKey } from '../config.js';
import type { Logger } from '../util/logging.js';
import type { JobStore } from '../storage/jobs.js';
import type { ImageProvider } from '../providers/image/types.js';
import type { Model3DProvider } from '../providers/model3d/types.js';
import type { AudioProvider } from '../providers/audio/types.js';
import { LeonardoProvider } from '../providers/image/leonardo.js';
import { LeonardoAudioProvider } from '../providers/audio/leonardo.js';
import { TripoProvider } from '../providers/model3d/tripo.js';
import { describeError } from '../util/errors.js';

export interface ToolContext {
  config: Config;
  logger: Logger;
  store: JobStore;
  imageProvider(): ImageProvider;
  model3dProvider(): Model3DProvider;
  audioProvider(): AudioProvider;
}

export function createToolContext(params: {
  config: Config;
  logger: Logger;
  store: JobStore;
}): ToolContext {
  const { config, logger, store } = params;

  // Memoised so repeated tool calls reuse one client, but still constructed on
  // first use rather than at startup.
  let image: ImageProvider | undefined;
  let model3d: Model3DProvider | undefined;
  let audio: AudioProvider | undefined;

  return {
    config,
    logger,
    store,
    imageProvider(): ImageProvider {
      if (!image) {
        image = new LeonardoProvider({
          apiKey: requireLeonardoKey(config),
          timeoutMs: config.httpTimeoutMs,
        });
      }
      return image;
    },
    model3dProvider(): Model3DProvider {
      if (!model3d) {
        model3d = new TripoProvider({
          apiKey: requireTripoKey(config),
          timeoutMs: config.httpTimeoutMs,
        });
      }
      return model3d;
    },
    audioProvider(): AudioProvider {
      if (!audio) {
        // Same credential as the image provider — one Leonardo account, two
        // modalities — so a user who configured images gets audio for free.
        audio = new LeonardoAudioProvider({
          apiKey: requireLeonardoKey(config),
          timeoutMs: config.httpTimeoutMs,
        });
      }
      return audio;
    },
  };
}

/** MCP tool result shape. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function fail(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/**
 * Wrap a handler so a thrown error becomes a structured, machine-readable tool
 * result rather than a transport-level exception.
 *
 * An agent can act on `{error: 'CONFIG_MISSING'}`; it cannot act on a stack
 * trace, and a crashed transport ends the session entirely.
 */
export function guard<A>(
  logger: Logger,
  toolName: string,
  handler: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      const described = describeError(err);
      logger.error(`tool ${toolName} failed`, described);
      return fail({ tool: toolName, ...described });
    }
  };
}
