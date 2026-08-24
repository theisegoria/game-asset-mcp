#!/usr/bin/env node
/**
 * game-asset-mcp — MCP server entry point.
 *
 * Startup deliberately does NOT require credentials. A user with only a 3D
 * provider configured gets a working server whose image tools report a clear
 * CONFIG_MISSING; refusing to boot instead would make a partially-configured
 * setup look broken rather than partially capable.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuredProviders, loadConfig } from './config.js';
import { Logger } from './util/logging.js';
import { JobStore } from './storage/jobs.js';
import { SpendLedger } from './storage/spend.js';
import { createToolContext } from './tools/context.js';
import { registerReferenceTools } from './tools/references.js';
import { registerAsset3DTools } from './tools/assets3d.js';
import { registerTextureTools } from './tools/textures.js';
import { registerJobTools } from './tools/jobs.js';
import { registerDownloadTools } from './tools/downloads.js';
import { registerInspectionTools } from './tools/inspection.js';
import { registerPbrTools } from './tools/pbr.js';
import { registerAudioTools } from './tools/audio.js';
import { registerNormalizeTools } from './tools/normalize.js';
import { registerSpendTools } from './tools/spend.js';
import { registerValidateTools } from './tools/validate.js';
import { registerAnimationTools } from './tools/animation.js';
import { registerBatchTools } from './tools/batch.js';
import { registerWorkflowTools } from './tools/workflows.js';

const SERVER_NAME = 'game-asset-mcp';
const SERVER_VERSION = '0.3.1';

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  // A relative ASSET_OUTPUT_DIR resolves against the SERVER's working
  // directory, and an MCP client picks that directory, not the user. Claude
  // Desktop and others spawn from `/`, where "assets/generated" becomes
  // "/assets" and mkdir fails with EACCES or ENOENT. The raw errno reaches the
  // client as nothing at all — the process exits and the client reports only
  // "connection closed" — so the one configuration mistake everybody makes is
  // also the one with no diagnosis. Name it here instead.
  let store: JobStore;
  let spend: SpendLedger;
  try {
    store = await JobStore.open(config.jobsDir);
    spend = await SpendLedger.open(config.jobsDir, config.spendLimitCents);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    // ENOTDIR: the path, or a component of it, is a file. ELOOP: a symlink
    // cycle. ENAMETOOLONG: an over-long component. All produced a bare errno
    // that reached the client as "connection closed" and nothing else.
    const WORKSPACE_ERRNOS = new Set([
      'ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'ENOSPC',
    ]);
    if (WORKSPACE_ERRNOS.has(code)) {
      const supplied = process.env.ASSET_OUTPUT_DIR?.trim();
      throw new Error(
        `cannot create the asset workspace at ${config.outputDir} (${code}). ` +
        (code === 'ENOTDIR'
          ? 'Something on that path is a file, not a directory — ASSET_OUTPUT_DIR must name a ' +
            'directory the server may create. '
          : '') +
        (supplied && !path.isAbsolute(supplied)
          ? `ASSET_OUTPUT_DIR is "${supplied}", a RELATIVE path, resolved against this server's ` +
            `working directory "${process.cwd()}" — which the MCP client chose, not you. ` +
            `Set ASSET_OUTPUT_DIR to an absolute path.`
          : `Set ASSET_OUTPUT_DIR to an absolute path this process may write to.`),
        { cause: err },
      );
    }
    throw err;
  }
  const ctx = createToolContext({ config, logger, store, spend });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerWorkflowTools(server, ctx);
  registerReferenceTools(server, ctx);
  registerAsset3DTools(server, ctx);
  registerTextureTools(server, ctx);
  registerJobTools(server, ctx);
  registerDownloadTools(server, ctx);
  registerInspectionTools(server, ctx);
  registerPbrTools(server, ctx);
  registerAudioTools(server, ctx);
  registerNormalizeTools(server, ctx);
  registerSpendTools(server, ctx);
  registerValidateTools(server, ctx);
  registerAnimationTools(server, ctx);
  registerBatchTools(server, ctx);

  const providers = configuredProviders(config);
  logger.info('game-asset-mcp starting', {
    version: SERVER_VERSION,
    outputDir: config.outputDir,
    imageProviders: providers.image,
    model3dProviders: providers.model3d,
  });
  if (providers.image.length === 0) {
    logger.warn('no image provider configured — image tools will report CONFIG_MISSING', {
      hint: 'set LEONARDO_API_KEY',
    });
  }
  if (providers.model3d.length === 0) {
    logger.warn('no 3D provider configured — 3D tools will report CONFIG_MISSING', {
      hint: 'set TRIPO_API_KEY',
    });
  }

  await server.connect(new StdioServerTransport());
  logger.info('game-asset-mcp connected on stdio');
}

// Only run when executed directly, so tests can import this module freely.
//
// Two ways this comparison silently fails, both observed rather than imagined:
//
//  1. Any space or non-ASCII character in the install path is percent-encoded
//     in import.meta.url but literal in argv, so string-building a file:// URL
//     never matches. Hence fileURLToPath.
//  2. An npm-installed package is launched through node_modules/.bin, which is
//     a SYMLINK. Node resolves import.meta.url to the real file but leaves
//     argv[1] as the symlink, so the paths differ and main() never runs — the
//     server starts, exits instantly, and the client reports only "connection
//     closed". Hence realpath on both sides.
//
// Both failures are invisible in development, where the real path is invoked
// directly, and fatal for anyone who installs the package.
function canonical(target: string): string {
  try {
    return realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

const invokedPath = process.argv[1] ? canonical(process.argv[1]) : undefined;
if (invokedPath && canonical(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'fatal', error: err instanceof Error ? err.message : String(err) })}\n`,
    );
    process.exit(1);
  });
}
