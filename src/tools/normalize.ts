/**
 * Making a mesh usable.
 *
 * Generated and marketplace meshes routinely arrive in a state that blocks the
 * next step entirely: no UV coordinates (so nothing can texture them),
 * degenerate triangles, unnamed materials, blend modes that make a solid object
 * render see-through. Every one of those is mechanical to fix and tedious by
 * hand, and each one silently stops a pipeline.
 *
 * Blender is an OPTIONAL dependency. Without it this tool refuses by name with
 * install instructions; it never quietly returns the mesh unchanged.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findBlender, packagedScript, runBlenderScript } from '../util/blender.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { MESH_EXTENSIONS } from '../util/local-file.js';
import { sha256, uniqueFilePath } from '../storage/filesystem.js';
import { resolveNormalizeTarget } from '../domain/normalize-target.js';
import { guard, ok, type ToolContext } from './context.js';

export function registerNormalizeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'normalize_mesh',
    {
      title: 'Repair a mesh so it can be textured and shipped',
      description:
        'FREE and fully local: no network call, no credits. Requires a local Blender install ' +
        '(optional dependency; the tool refuses with instructions if absent). Repairs a mesh for ' +
        'downstream use: generates UV coordinates for objects that have NONE — the single most ' +
        'common reason a mesh cannot be textured — welds coincident vertices, dissolves degenerate ' +
        'triangles, gives every material a stable non-empty name, forces opaque blending, and ' +
        'optionally decimates to a triangle budget. Existing UV layouts are never overwritten. ' +
        'Exports GLB and returns a receipt with before/after counts so the change is measurable.',
      inputSchema: {
        modelPath: z.string().optional().describe('Absolute path to a local mesh (.glb/.gltf/.obj/.fbx/.stl).'),
        assetJobId: z.string().optional().describe('A downloaded job whose model should be normalized.'),
        outputPath: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Where to write the GLB. Must end in .glb, or have no extension (in which case .glb ' +
            'is appended) — the exporter rewrites the extension, so a .gltf path would silently ' +
            'become .glb and could land on a different file. Refused if it resolves onto the ' +
            'input mesh, by filesystem identity, so symlinks, hardlinks and case-insensitive ' +
            'volumes all count. Use an ABSOLUTE path: a relative one resolves against the ' +
            'SERVER\'s working directory, which your MCP client chose, and a leading ~ is not ' +
            'expanded. Naming an existing directory writes a sibling file beside it, not inside ' +
            'it. Defaults to <input>_normalized.glb beside the source.',
          ),
        overwrite: z
          .boolean()
          .default(false)
          .describe(
            'Allow an explicit outputPath to replace an existing file. Off by default: a silent ' +
            'overwrite destroys a result you may already have reviewed. Never permits writing ' +
            'over the input mesh.',
          ),
        unwrapMissingUVs: z
          .boolean()
          .default(true)
          .describe('Generate UVs for objects that have none. Never touches an existing layout.'),
        cleanGeometry: z
          .boolean()
          .default(true)
          .describe('Weld coincident vertices, dissolve degenerate faces, make normals consistent.'),
        mergeDistance: z
          .number()
          .min(0)
          .max(1)
          .default(0.0001)
          .describe('Weld threshold in scene units. Larger values will change the silhouette.'),
        targetTriangles: z
          .number()
          .int()
          .positive()
          .max(10_000_000)
          .optional()
          .describe('Decimate down to roughly this many triangles. Omit to leave density alone.'),
        normalizeMaterials: z
          .boolean()
          .default(true)
          .describe('Name every material slot and force opaque blending.'),
        angleLimitDegrees: z.number().min(1).max(89).default(66).describe('Smart-project angle limit.'),
        islandMargin: z.number().min(0).max(0.5).default(0.002).describe('UV island padding.'),
        timeoutSeconds: z.number().int().min(10).max(900).default(300),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(ctx.logger, 'normalize_mesh', async (args) => {
      if (Boolean(args.modelPath) === Boolean(args.assetJobId)) {
        throw invalidInput('provide exactly one of modelPath or assetJobId');
      }

      let source: string;
      if (args.modelPath) {
        source = path.resolve(args.modelPath);
      } else {
        const job = await ctx.store.get(args.assetJobId as string);
        const model = job.files.find((file) => file.kind === 'model');
        if (!model) {
          throw invalidState(`job ${job.id} has no downloaded model — call download_asset first`, {
            status: job.status,
          });
        }
        source = model.path;
      }

      const actualExt = path.extname(source);
      const ext = actualExt.toLowerCase();
      if (!MESH_EXTENSIONS.has(ext)) {
        throw invalidInput(`unsupported mesh type "${ext}"`, { allowed: [...MESH_EXTENSIONS] });
      }
      try {
        await fs.access(source);
      } catch {
        throw invalidInput(`file not found: ${source}`);
      }

      const outputDir = args.outputPath
        ? path.dirname(path.resolve(args.outputPath))
        : path.dirname(source);
      await fs.mkdir(outputDir, { recursive: true });

      const resolved = await resolveNormalizeTarget(
        {
          source,
          sourceExtension: actualExt,
          outputDir,
          outputPath: args.outputPath,
          overwrite: args.overwrite,
        },
        {
          // stat, not lstat: the question is which file a write would land on,
          // so symlinks must be followed. A missing path aliases nothing.
          fileIdentity: async (target) => {
            try {
              const info = await fs.stat(target);
              return { dev: info.dev, ino: info.ino };
            } catch {
              return null;
            }
          },
          reserve: (dir, fileName) => uniqueFilePath(dir, fileName),
          // O_EXCL, so winning the create is atomic. A stat-then-write let two
          // concurrent calls both believe the path was free.
          claimExclusive: async (target) => {
            try {
              const handle = await fs.open(target, 'wx');
              await handle.close();
              return true;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
              throw err;
            }
          },
        },
      );
      const output = resolved.target;

      // The reservation CREATED the file to claim the name, and nothing released
      // it when the work failed — so three failed calls left three zero-byte
      // .glb files, the canonical name permanently taken by an empty one that
      // sorts first in any glob, and the caller never told a file was written.
      // mesh-batch.ts documents and fixes exactly this; the single-mesh tool
      // shares the same reservation primitive and did not.
      // Taken from the resolver, not recomputed. Deriving it here as
      // `args.outputPath === undefined` disagreed with the resolver's
      // `!request.outputPath` for outputPath: "" — which took the reserve
      // branch, created a file, and leaked it because the tool believed it held
      // nothing. One fact, one place.
      let reservationHeld = resolved.reserved;
      const releaseReservation = async (): Promise<boolean> => {
        if (!reservationHeld) return true;
        reservationHeld = false;
        try {
          await fs.rm(output, { force: true });
          return true;
        } catch {
          return false; // Reported, never thrown: it must not displace the cause.
        }
      };

      // Blender writes to a STAGING path, never to the destination.
      //
      // Writing straight to the destination made the read-back — this module's
      // whole evidence primitive, "the bytes on disk are the evidence" — unable
      // to tell "Blender wrote this" from "the file that was already there".
      // With overwrite:true onto an existing file, a Blender that wrote nothing
      // produced a SUCCESS carrying the old file's size and hash, readyToTexture
      // true, and "Generated UVs for 3 object(s)" — handing a downstream texture
      // step the unrepaired mesh with an affirmative go-ahead. It is reachable
      // with real Blender: blender_normalize.py discards the export operator's
      // result, and a CANCELLED operator does not raise.
      //
      // Staging also means a failed run cannot damage the destination at all,
      // which previously happened whenever overwrite:true was granted and the
      // run then failed: the file was replaced and the caller was told the call
      // had FAILED.
      const staging = await uniqueFilePath(outputDir, `.${path.basename(output)}.staging.glb`);
      const discardStaging = async (): Promise<void> => {
        try {
          await fs.rm(staging, { force: true });
        } catch {
          // Never displaces the cause.
        }
      };

      let result;
      try {
        result = await runBlenderScript(
        packagedScript('blender_normalize.py'),
        {
          input: source,
          output: staging,
          unwrapMissingUVs: args.unwrapMissingUVs,
          cleanGeometry: args.cleanGeometry,
          mergeDistance: args.mergeDistance,
          normalizeMaterials: args.normalizeMaterials,
          angleLimitDegrees: args.angleLimitDegrees,
          islandMargin: args.islandMargin,
          ...(args.targetTriangles !== undefined ? { targetTriangles: args.targetTriangles } : {}),
        },
        { timeoutMs: args.timeoutSeconds * 1000 },
        );
      } catch (err) {
        await discardStaging();
        const cleaned = await releaseReservation();
        if (!cleaned) {
          throw invalidState(
            `${err instanceof Error ? err.message : String(err)} ` +
            `(a zero-byte placeholder was left at ${output}; the cleanup itself failed)`,
          );
        }
        throw err;
      }

      // The bytes on disk are the evidence — and because they are at a path
      // only this run could have written, they are evidence about THIS run.
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await fs.readFile(staging));
      } catch {
        await discardStaging();
        await releaseReservation();
        throw invalidState(
          `Blender reported success but wrote nothing. The destination ${output} is unchanged.`,
        );
      }
      if (bytes.byteLength === 0) {
        await discardStaging();
        await releaseReservation();
        throw invalidState(
          `Blender reported success but produced an empty file. The destination ${output} is unchanged.`,
        );
      }
      if (Buffer.from(bytes.subarray(0, 4)).toString('utf8') !== 'glTF') {
        await discardStaging();
        await releaseReservation();
        throw invalidState(
          `Blender produced a file that is not a GLB. The destination ${output} is unchanged.`,
        );
      }

      // Verified, so it may now replace the destination. rename is atomic
      // within a filesystem: a reader sees the old file or the new one, never a
      // half-written one, and a crash here cannot leave a truncated mesh.
      try {
        await fs.rename(staging, output);
      } catch (err) {
        await discardStaging();
        await releaseReservation();
        throw invalidState(
          `normalization succeeded but the result could not be moved into place at ${output}: ` +
          `${err instanceof Error ? err.message : String(err)}. The destination is unchanged.`,
        );
      }
      reservationHeld = false;

      const receipt = result.receipt as Record<string, number | string>;
      const uvsBefore = Number(receipt.objectsMissingUVsBefore ?? 0);
      const uvsAfter = Number(receipt.objectsMissingUVsAfter ?? 0);

      return ok({
        schema: 'org.gamedebug.mesh_normalize.v1',
        sourcePath: source,
        outputPath: output,
        outputBytes: bytes.byteLength,
        outputSHA256: sha256(bytes),
        ...receipt,
        /** True only when nothing is left that would block texturing. */
        readyToTexture: uvsAfter === 0,
        nextStep:
          uvsAfter === 0
            ? uvsBefore > 0
              ? `Generated UVs for ${uvsBefore} object(s); the mesh can now be textured.`
              : 'Mesh already had UVs; geometry and materials were normalized.'
            : `${uvsAfter} object(s) still have no UVs and cannot be textured.`,
      });
    }),
  );
}

/** Exposed so a status surface can report whether the optional dependency is present. */
export function blenderAvailability(): { available: boolean; path?: string } {
  const found = findBlender();
  return found ? { available: true, path: found } : { available: false };
}
