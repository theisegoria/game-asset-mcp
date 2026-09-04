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
import type { SpendLedger } from '../storage/spend.js';
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
  spend: SpendLedger;
  /**
   * Charge the session ceiling for one upcoming provider call, or refuse.
   *
   * MUST be awaited immediately before the request is sent. Charging after the
   * fact would let a crash or a concurrent call slip past the limit, which is
   * precisely the situation the ceiling exists to prevent.
   */
  charge(
    tool: string,
    options?: { units?: number; assetJobId?: string },
  ): Promise<{ entryId: string; estimatedCents: number }>;
  /** Enforce the ceiling before any provider contact, recording nothing. */
  assertHeadroom(tool: string, units?: number): void;
}

export function createToolContext(params: {
  config: Config;
  logger: Logger;
  store: JobStore;
  spend: SpendLedger;
}): ToolContext {
  const { config, logger, store, spend } = params;

  // Memoised so repeated tool calls reuse one client, but still constructed on
  // first use rather than at startup.
  let image: ImageProvider | undefined;
  let model3d: Model3DProvider | undefined;
  let audio: AudioProvider | undefined;

  return {
    config,
    logger,
    store,
    spend,
    assertHeadroom(tool, units) {
      spend.assertHeadroom(tool, units);
    },
    async charge(tool, options) {
      const reservation = await spend.reserve({
        tool,
        ...(options?.units !== undefined ? { units: options.units } : {}),
        ...(options?.assetJobId !== undefined ? { assetJobId: options.assetJobId } : {}),
      });
      logger.info('charged session spend ceiling', {
        tool,
        estimatedCents: reservation.estimatedCents,
        spentCents: spend.spentCents(),
        limitCents: spend.limit,
      });
      return reservation;
    },
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

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string };

/** What a picture is FOR, so a transport can decide how hard to try to show it. */
export type VisualRole =
  | 'reference_candidate'
  | 'render_preview'
  | 'capture_frame'
  | 'diff_heatmap'
  | 'texture_plane'
  | 'thumbnail';

/**
 * A picture a caller may want to look at, described rather than embedded.
 *
 * Deferred on purpose. A handler that eagerly base64-encoded every raster
 * would make the CLI build megabytes it immediately discards, and the CLI test
 * harness caps a command's output at 16 MiB. So the handler declares what
 * exists and where, and each transport decides delivery: the CLI prints paths,
 * MCP inlines the bytes for a model that can actually see them.
 */
export interface VisualAttachment {
  /** Absolute path on disk. */
  path: string;
  mimeType: string;
  role: VisualRole;
  /** What this picture IS, for a client that can only render text. */
  label: string;
  /**
   * Whether the pixels are colour or data. Load-bearing, not decoration:
   * downscaling a normal map through a gamma curve bends the vectors and
   * darkens the surface, producing a thumbnail that looks fine and misleads
   * the viewer about the exact defect they were asked to diagnose.
   */
  colorimetry: 'srgb' | 'data';
  bytes?: number;
  width?: number;
  height?: number;
}

/**
 * Transport-neutral local command result shape.
 *
 * INVARIANT: `content[0]` is always the canonical JSON text block. Images are
 * appended after it. Every existing reader takes `content[0].text` and parses
 * it, so holding this makes multimodal results free for them.
 */
export interface ToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
  visuals?: VisualAttachment[];
  [key: string]: unknown;
}

/** Narrow to the canonical JSON block without assuming what follows it. */
export function resultText(result: ToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '{}';
}

export function ok(payload: unknown, visuals?: readonly VisualAttachment[]): ToolResult {
  // The descriptors go into the JSON as well as onto the result, so the CLI
  // reports exactly the images MCP renders. One call site, two consumers, and
  // no way for the two transports to disagree about what exists.
  const body = visuals?.length && payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), visuals }
    : payload;
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    ...(visuals?.length ? { visuals: [...visuals] } : {}),
  };
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
