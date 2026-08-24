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
import { inspectGltf } from '../inspection/gltf.js';
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
      if (args.outputPath === undefined) {
        // The source's own directory, which exists by definition.
        await fs.mkdir(outputDir, { recursive: true });
      } else {
        // An explicit destination's parent must ALREADY exist. This used to
        // mkdir -p before any validation, so a mistyped path silently built a
        // directory tree anywhere the process could write: outputPath
        // "~/out.glb" is not expanded by the shell here and created a literal
        // "~" directory in the server's working directory. Refusing is both
        // safer and a better diagnosis — a missing parent is nearly always a
        // typo or an unexpanded variable.
        let parentIsDirectory = false;
        try {
          parentIsDirectory = (await fs.stat(outputDir)).isDirectory();
        } catch {
          parentIsDirectory = false;
        }
        if (!parentIsDirectory) {
          throw invalidInput(
            `the directory for outputPath does not exist: ${outputDir}. Create it first, or omit ` +
            'outputPath to write beside the source. Note that a leading ~ is NOT expanded here and ' +
            'a relative path resolves against the server\'s working directory, not yours.',
            { outputPath: path.resolve(args.outputPath), outputDir },
          );
        }
      }

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
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'EEXIST') return false;
              if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
                throw invalidInput(
                  `cannot write to outputPath (${code}): the directory is not writable by this ` +
                  'process. Choose a destination you own, or omit outputPath to write beside the source.',
                  { code },
                );
              }
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
          // Only remove what is still OUR placeholder. The reservation is a
          // zero-byte file; a Blender run takes minutes, and in that window
          // another call holding overwrite:true can legitimately rename a real
          // mesh onto this path. Unconditional rm deleted that call's verified
          // output — leaving it holding a receipt with a byte count and SHA-256
          // for bytes that no longer existed anywhere. The exclusive create
          // fixed the race to CLAIM the name; this is the race to RELEASE it.
          const standing = await fs.stat(output).catch(() => null);
          if (standing === null) return true;
          if (standing.size !== 0) return true;
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
      // A four-byte magic check is not verification. A 12-byte file beginning
      // "glTF" passed it, atomically replaced a reviewed 91,088-byte mesh, and
      // came back readyToTexture:true — staging made that WORSE, because the
      // replacement is now atomic. The repository already owns the real check
      // and batch_prepare_meshes already uses it: parse the thing.
      // The RESULT is bound. It used to be `await inspectGltf(staging);` with no
      // assignment — a try/catch masquerading as a verification, while every
      // geometry fact reported still came from Blender's receipt. A run that
      // welded a 94,208-byte mesh down to 500 bytes reported trianglesAfter: 0
      // and readyToTexture: true in the same object, and the reviewed
      // destination was replaced atomically.
      let produced;
      try {
        produced = await inspectGltf(staging);
      } catch (err) {
        await discardStaging();
        await releaseReservation();
        throw invalidState(
          `Blender produced a file that does not parse as glTF: ` +
          `${err instanceof Error ? err.message : String(err)}. The destination ${output} is unchanged.`,
        );
      }

      // BEFORE the rename. This check used to run after it, so the destination
      // was atomically replaced by a husk and the caller was then told "The
      // destination is unchanged" — a false reassurance, which is worse than no
      // check at all because nobody re-checks. Measured 70,492 bytes to 224.
      if (produced.triangleCount === 0) {
        await discardStaging();
        await releaseReservation();
        throw invalidState(
          'normalization produced a file with no drawable geometry (0 triangles). Common causes: ' +
          'mergeDistance too large for this mesh, or a mesh whose parts are smaller than the ' +
          `degenerate-face threshold. The destination ${output} is unchanged.`,
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

      // The receipt is spread FIRST so measured values win. It used to come
      // last, so Blender's claim overrode the bytes actually read back — a stub
      // claiming outputBytes 999999999 was reported verbatim for a 91,088-byte
      // file, and the same spread could overwrite schema, sourcePath and
      // outputPath. The whole point of reading the file is that the subprocess
      // is a claim and the bytes are the evidence; letting the claim land last
      // discarded the evidence after computing it.
      //
      // The receipt's own `input`/`output` are dropped: they name the STAGING
      // path, which has been renamed away and no longer exists. Every
      // successful response was returning a key called `output` pointing at a
      // deleted temporary file.
      const { input: _receiptInput, output: _receiptOutput, ...receiptFields } = receipt;

      return ok({
        ...receiptFields,
        schema: 'org.gamedebug.mesh_normalize.v1',
        sourcePath: source,
        outputPath: output,
        outputBytes: bytes.byteLength,
        outputSHA256: sha256(bytes),
        /**
         * MEASURED from the produced file, never taken from the receipt.
         * It was `Number(receipt.objectsMissingUVsAfter ?? 0) === 0`, so a
         * receipt that simply omitted the field turned UNKNOWN into zero into
         * "ready" — a silent fallback on the most load-bearing field in the
         * response.
         */
        readyToTexture: produced.hasUVs && produced.triangleCount > 0,
        trianglesMeasured: produced.triangleCount,
        hasUVsMeasured: produced.hasUVs,
        /**
         * Whether Blender's stdout exceeded the capture cap.
         *
         * Computed correctly in blender.ts and, until now, read by nothing
         * outside its own unit test — so no caller could learn that output had
         * been dropped. That matters here specifically: the receipt is the LAST
         * line of stdout, and a dropped tail is exactly how a forged receipt
         * near byte 0 wins. Surfaced so a truncated run is visibly different
         * from a quiet one.
         */
        stdoutTruncated: result.stdoutTruncated,
        nextStep: produced.hasUVs
          ? uvsBefore > 0
            ? `Generated UVs for ${uvsBefore} object(s); the mesh can now be textured.`
            : 'Mesh already had UVs; geometry and materials were normalized.'
          : 'The result still has no UVs and cannot be textured.',
      });
    }),
  );
}

/** Exposed so a status surface can report whether the optional dependency is present. */
export function blenderAvailability(): { available: boolean; path?: string } {
  const found = findBlender();
  return found ? { available: true, path: found } : { available: false };
}
