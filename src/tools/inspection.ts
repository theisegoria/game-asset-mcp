/**
 * Local technical inspection.
 *
 * A downloaded file is not a usable asset. This is the step that distinguishes
 * "the provider returned something" from "the thing it returned has UVs, has
 * normals, has textures at a resolution worth shipping, and is the size it
 * claims to be". Without it, a pipeline reports success on a mesh nothing can
 * render correctly.
 */

import { z } from 'zod';
import type { ToolRegistrar } from '../commands/registry.js';
import { inspectGltf } from '../inspection/gltf.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { MESH_EXTENSIONS } from '../util/local-file.js';
import path from 'node:path';
import { guard, ok, type ToolContext } from './context.js';

export function registerInspectionTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'inspect_asset',
    {
      title: 'Inspect a downloaded 3D asset',
      description:
        'FREE and fully local: no network call, no credits. Reports the technical properties of a ' +
        'downloaded glTF/GLB — mesh and triangle counts, materials, texture resolutions, bounding box ' +
        'in metres, and whether UVs, normals, tangents and PBR channels are present — plus warnings ' +
        'for anything that will cause downstream problems. Pass assetJobId to inspect a downloaded ' +
        'job, or modelPath to inspect any local file.',
      inputSchema: {
        assetJobId: z.string().optional().describe('A job that has already been downloaded.'),
        modelPath: z.string().optional().describe('Absolute path to a local mesh. GLB and glTF are inspected directly; other mesh formats are accepted and will fail at decode, since only glTF can be read.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'inspect_asset', async (args) => {
      if (Boolean(args.assetJobId) === Boolean(args.modelPath)) {
        throw invalidInput('provide exactly one of assetJobId or modelPath');
      }

      let target: string;
      if (args.modelPath) {
        const ext = path.extname(args.modelPath).toLowerCase();
        if (!MESH_EXTENSIONS.has(ext)) {
          throw invalidInput(`unsupported mesh type "${ext}"`, { allowed: [...MESH_EXTENSIONS] });
        }
        target = path.resolve(args.modelPath);
      } else {
        const job = await ctx.store.get(args.assetJobId as string);
        const model = job.files.find(
          (file) => file.kind === 'model' && /\.(glb|gltf)$/i.test(file.path),
        );
        if (!model) {
          throw invalidState(
            `job ${job.id} has no downloaded glTF model — call download_asset first`,
            { status: job.status, fileCount: job.files.length },
          );
        }
        target = model.path;
      }

      const inspection = await inspectGltf(target);
      return ok(inspection);
    }),
  );
}
