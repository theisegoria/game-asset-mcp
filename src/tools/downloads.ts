/**
 * Bringing a finished asset onto disk.
 *
 * Provider model URLs are short-lived — commonly signed and expiring within
 * hours. A job that reports `ready` is therefore not a job that is safe to
 * leave alone: this tool is what turns a perishable URL into bytes we own.
 *
 * Textures are also EXTRACTED out of the container here. A GLB with embedded
 * images is fine for a viewer but useless to a material pipeline that wants
 * base colour, normal and roughness as separate files, and the extraction is
 * cheap once the bytes are local.
 */

import path from 'node:path';
import { z } from 'zod';
import { NodeIO } from '@gltf-transform/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssetJob, DownloadedFile } from '../domain/asset-job.js';
import { summarizeAssetJob } from '../domain/asset-job.js';
import { invalidState } from '../util/errors.js';
import { downloadFile } from '../util/http.js';
import { assertExistingDirectory, reserveWorkspace, safeJoin, sanitizeFileName, uniqueFilePath, writeFileAtomic, writeJsonAtomic } from '../storage/filesystem.js';
import { guard, ok, type ToolContext } from './context.js';
import { refreshAssetJob } from './jobs.js';

/** Map a content-type to an extension when the URL has none worth trusting. */
function extensionFor(contentType: string | undefined, fallback: string): string {
  if (!contentType) return fallback;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const table: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'model/gltf-binary': '.glb',
    'model/gltf+json': '.gltf',
    'application/octet-stream': fallback,
  };
  return table[type] ?? fallback;
}

async function fetchInto(
  ctx: ToolContext,
  job: AssetJob,
  url: string,
  dir: string,
  baseName: string,
  kind: DownloadedFile['kind'],
): Promise<DownloadedFile> {
  const result = await downloadFile(url, {
    timeoutMs: ctx.config.httpTimeoutMs,
    maxBytes: ctx.config.maxDownloadBytes,
  });
  const ext = path.extname(new URL(url).pathname) || extensionFor(result.contentType, '.bin');
  const target = await uniqueFilePath(dir, sanitizeFileName(`${baseName}${ext}`, `${baseName}.bin`));
  const digest = await writeFileAtomic(target, result.bytes);

  const file: DownloadedFile = {
    path: target,
    bytes: result.bytes.byteLength,
    sha256: digest,
    kind,
    ...(result.contentType ? { contentType: result.contentType } : {}),
  };
  job.files.push(file);
  return file;
}

/**
 * Write each embedded image out as its own file.
 *
 * Named by the texture's own name where it has one, falling back to an index,
 * so a material pipeline can tell base colour from normal without opening them.
 */
/**
 * Files actually written, and the textures that could not be.
 *
 * Both halves are returned because this used to throw out of the middle of the
 * loop. The caller's `catch` wrapped the WHOLE loop, so a failure on texture 3
 * of 5 discarded the record of textures 1 and 2 — which were already on disk,
 * via writeFileAtomic. `job.files.push(...)` never ran and `asset.json`, the
 * provenance document, omitted them. The response then said `textureCount: 0`,
 * indistinguishable from "this model has no embedded textures", while the
 * files sat there unrecorded.
 */
interface TextureExtraction {
  written: DownloadedFile[];
  failures: string[];
}

// Exported for tests. The behaviour that matters — that a failure on texture 3
// of 5 does not erase the record of textures 1 and 2 — is only observable from
// the return value, and reaching it through download_asset would require a
// completed job and a live provider.
export async function extractTextures(
  modelPath: string,
  texturesDir: string,
): Promise<TextureExtraction> {
  const io = new NodeIO();
  // Deliberately OUTSIDE the per-texture guard: if the container itself cannot
  // be opened there are no textures to be partial about, and that is the
  // caller's existing "warn, keep the download" case.
  const document = await io.read(modelPath);
  const written: DownloadedFile[] = [];
  const failures: string[] = [];

  const textures = document.getRoot().listTextures();
  for (const [index, texture] of textures.entries()) {
    const image = texture.getImage();
    if (!image) continue;
    const mime = texture.getMimeType();
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const base = sanitizeFileName(texture.getName() || `texture_${index + 1}`, `texture_${index + 1}`);
    const stem = path.basename(base, path.extname(base));
    // Per texture. One unwritable image (ENOSPC, EACCES, EIO) must not erase
    // the record of the ones that already landed.
    try {
      const target = await uniqueFilePath(texturesDir, `${stem}${ext}`);
      const bytes = new Uint8Array(image);
      const digest = await writeFileAtomic(target, bytes);
      written.push({
        path: target,
        bytes: bytes.byteLength,
        sha256: digest,
        kind: 'texture',
        contentType: mime,
      });
    } catch (err) {
      failures.push(`${stem}${ext}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { written, failures };
}

export function registerDownloadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'download_asset',
    {
      title: 'Download a finished asset into the workspace',
      description:
        'FREE: no credits. Downloads a completed asset job into a local workspace folder — the model, ' +
        'any PBR variant, the provider preview, the source reference image — and EXTRACTS embedded ' +
        'textures into textures/ as separate files. Also writes asset.json with complete provenance. ' +
        'Call this as soon as get_asset_job reports "ready": provider URLs expire. ' +
        'Never overwrites an existing workspace; a repeat download gets a new suffixed folder.',
      inputSchema: {
        assetJobId: z.string(),
        destination: z.string().min(1).optional()
          .describe('Override the output root. Defaults to ASSET_OUTPUT_DIR.'),
        extractTextures: z
          .boolean()
          .default(true)
          .describe('Write embedded glTF images out as separate texture files.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'download_asset', async (args) => {
      let job = await ctx.store.get(args.assetJobId);
      job = await refreshAssetJob(ctx, job);

      const modelUrl = job.model3d?.pbrModelUrl ?? job.model3d?.modelUrl;
      if (!modelUrl) {
        throw invalidState(
          `job ${job.id} has no model to download (status: ${job.status})`,
          { status: job.status, providerStatus: job.providerStatus },
        );
      }

      const root = args.destination ? path.resolve(args.destination) : ctx.config.outputDir;
      if (args.destination) await assertExistingDirectory(root, 'destination');
      const workspace = await reserveWorkspace(root, job.slug);
      job.workspacePath = workspace.dir;

      const modelFile = await fetchInto(
        ctx,
        job,
        modelUrl,
        safeJoin(workspace.dir, 'model'),
        'model',
        'model',
      );

      // Fetch the untextured base too when the provider exposes both, so a
      // pipeline that wants to author its own materials still has the geometry.
      if (job.model3d?.pbrModelUrl && job.model3d.modelUrl && job.model3d.modelUrl !== modelUrl) {
        await fetchInto(ctx, job, job.model3d.modelUrl, safeJoin(workspace.dir, 'model'), 'model_base', 'model');
      }

      if (job.model3d?.renderedImageUrl) {
        await fetchInto(
          ctx,
          job,
          job.model3d.renderedImageUrl,
          safeJoin(workspace.dir, 'previews'),
          'render',
          'preview',
        );
      }

      const selected = job.candidates.find((candidate) => candidate.id === job.selectedCandidateId);
      if (selected) {
        const reference = await fetchInto(
          ctx,
          job,
          selected.url,
          safeJoin(workspace.dir, 'source'),
          'reference',
          'reference',
        );
        selected.localPath = reference.path;
      }

      let textureFiles: DownloadedFile[] = [];
      let textureFailures: string[] = [];
      if (args.extractTextures && /\.(glb|gltf)$/i.test(modelFile.path)) {
        try {
          const extraction = await extractTextures(
            modelFile.path,
            safeJoin(workspace.dir, 'textures'),
          );
          textureFiles = extraction.written;
          textureFailures = extraction.failures;
          // Pushed before any failure is considered, so provenance always
          // describes what is actually on disk.
          job.files.push(...textureFiles);
          if (textureFailures.length > 0) {
            ctx.logger.warn('some textures could not be written', {
              assetJobId: job.id,
              written: textureFiles.length,
              failed: textureFailures.length,
            });
          }
        } catch (err) {
          // A container we cannot open is a real finding, but the model itself
          // downloaded fine — surface it as a warning rather than discarding a
          // successful download.
          ctx.logger.warn('texture extraction failed', {
            assetJobId: job.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);
      await writeJsonAtomic(safeJoin(workspace.dir, 'asset.json'), job);

      return ok({
        ...summarizeAssetJob(job),
        workspacePath: workspace.dir,
        modelPath: modelFile.path,
        textureCount: textureFiles.length,
        // Named, not just logged. A stderr warning is invisible to the caller,
        // so a partial extraction used to be indistinguishable from a complete
        // one — the number alone cannot say "and four more were expected".
        ...(textureFailures.length > 0 ? { textureFailures } : {}),
        files: job.files.map((file) => ({ path: file.path, bytes: file.bytes, kind: file.kind })),
        nextStep: 'Call inspect_asset with this assetJobId to verify the mesh and textures are usable.',
      });
    }),
  );
}
