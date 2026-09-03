import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  decodeImage,
  encodePNG,
  resizeImage,
  sniffImageFormat,
} from '../inspection/image.js';
import type { ToolContentBlock, ToolResult, VisualAttachment } from '../tools/context.js';

export interface VisualBudget {
  /** Largest raster inlined without resampling. */
  maxInlineBytes: number;
  maxImages: number;
  maxTotalBytes: number;
  /** Longest side after a downscale. */
  maxDimension: number;
}

export const DEFAULT_VISUAL_BUDGET: VisualBudget = {
  maxInlineBytes: 1_500_000,
  maxImages: 6,
  maxTotalBytes: 8_000_000,
  maxDimension: 1024,
};

interface Delivered {
  blocks: ToolContentBlock[];
  downscaled: number;
  omitted: number;
  inlined: number;
}

function fitWithin(width: number, height: number, longest: number): [number, number] {
  const scale = Math.min(1, longest / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function renderOne(
  visual: VisualAttachment,
  budget: VisualBudget,
  remaining: number,
): Promise<{ block: ToolContentBlock; used: number; downscaled: boolean } | undefined> {
  const bytes = await readFile(visual.path);

  // Sniff, never trust the extension. A glTF can and does declare image/png
  // over JPEG bytes, and an inline block with the wrong mimeType renders as a
  // broken image with no error anywhere.
  const format = sniffImageFormat(bytes);
  if (!format) return undefined;

  if (bytes.byteLength <= Math.min(budget.maxInlineBytes, remaining)) {
    return {
      block: { type: 'image', data: bytes.toString('base64'), mimeType: `image/${format}` },
      used: bytes.byteLength,
      downscaled: false,
    };
  }

  const decoded = decodeImage(bytes);
  const [width, height] = fitWithin(decoded.width, decoded.height, budget.maxDimension);
  // srgb:false for data channels. Averaging a normal or roughness map through
  // a gamma curve produces a picture that looks plausible and misrepresents
  // the very defect the caller is trying to see.
  const resized = resizeImage(decoded, width, height, { srgb: visual.colorimetry === 'srgb' });
  const encoded = Buffer.from(encodePNG(resized));
  if (encoded.byteLength > remaining) return undefined;

  return {
    block: { type: 'image', data: encoded.toString('base64'), mimeType: 'image/png' },
    used: encoded.byteLength,
    downscaled: true,
  };
}

async function collect(
  visuals: readonly VisualAttachment[],
  budget: VisualBudget,
): Promise<Delivered> {
  const blocks: ToolContentBlock[] = [];
  let remaining = budget.maxTotalBytes;
  let downscaled = 0;
  let omitted = 0;
  let inlined = 0;

  for (const visual of visuals) {
    if (inlined >= budget.maxImages) {
      omitted += 1;
      continue;
    }
    let rendered;
    try {
      rendered = await renderOne(visual, budget, remaining);
    } catch {
      // An unreadable or undecodable file must not fail the tool call: the JSON
      // body is still correct and useful without the picture.
      rendered = undefined;
    }
    if (!rendered) {
      omitted += 1;
      // Still tell the caller the file exists and where.
      blocks.push({
        type: 'resource_link',
        uri: `file://${visual.path}`,
        name: path.basename(visual.path),
        mimeType: visual.mimeType,
        description: `${visual.label} (not inlined)`,
      });
      continue;
    }
    blocks.push(rendered.block);
    remaining -= rendered.used;
    inlined += 1;
    if (rendered.downscaled) downscaled += 1;
  }

  return { blocks, downscaled, omitted, inlined };
}

/**
 * Render a result's declared visuals into inline image blocks for a client
 * whose model can actually look at them.
 *
 * `content[0]` -- the canonical JSON -- is preserved and only ever annotated,
 * never replaced, so an MCP caller parses exactly what a CLI caller parses.
 */
export async function deliverVisuals(
  result: ToolResult,
  budget: VisualBudget = DEFAULT_VISUAL_BUDGET,
): Promise<ToolResult> {
  const visuals = result.visuals;
  if (!visuals?.length) return result;

  const { blocks, downscaled, omitted, inlined } = await collect(visuals, budget);
  if (blocks.length === 0) return result;

  const [first, ...rest] = result.content;
  let head = first;
  if (head?.type === 'text') {
    try {
      const parsed: unknown = JSON.parse(head.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        head = {
          type: 'text',
          text: JSON.stringify({
            ...(parsed as Record<string, unknown>),
            // A model that has been handed a 512px re-encode must not reason as
            // though it inspected the original. Saying so is cheaper than being
            // wrong about a texture defect.
            visualDelivery: {
              pixelsDeliveredToModel: inlined > 0,
              imagesInlined: inlined,
              imagesDownscaledForTransport: downscaled,
              imagesOmitted: omitted,
              fullResolutionDelivered: downscaled === 0 && omitted === 0,
              humanVisualReviewPerformed: false,
            },
          }, null, 2),
        };
      }
    } catch {
      // Not JSON: leave the block exactly as the handler wrote it.
    }
  }

  return {
    ...result,
    content: [...(head ? [head] : []), ...rest, ...blocks],
  };
}
