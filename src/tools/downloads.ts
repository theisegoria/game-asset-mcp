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
async function extractTextures(modelPath: string, texturesDir: string): Promise<DownloadedFile[]> {
  const io = new NodeIO();
  const document = await io.read(modelPath);
  const written: DownloadedFile[] = [];

  const textures = document.getRoot().listTextures();
  for (const [index, texture] of textures.entries()) {
    const image = texture.getImage();
    if (!image) continue;
    const mime = texture.getMimeType();
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const base = sanitizeFileName(texture.getName() || `texture_${index + 1}`, `texture_${index + 1}`);
    const stem = path.basename(base, path.extname(base));
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
  }
  return written;
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
        destination: z
          .string()
          .optional()
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
      if (args.extractTextures && /\.(glb|gltf)$/i.test(modelFile.path)) {
        try {
          textureFiles = await extractTextures(modelFile.path, safeJoin(workspace.dir, 'textures'));
          job.files.push(...textureFiles);
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
        files: job.files.map((file) => ({ path: file.path, bytes: file.bytes, kind: file.kind })),
        nextStep: 'Call inspect_asset with this assetJobId to verify the mesh and textures are usable.',
      });
    }),
  );
}
