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
import { registerWorkflowTools } from './tools/workflows.js';

const SERVER_NAME = 'game-asset-mcp';
const SERVER_VERSION = '0.2.0';

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const store = await JobStore.open(config.jobsDir);
  const spend = await SpendLedger.open(config.jobsDir, config.spendLimitCents);
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
// Compared via fileURLToPath rather than string-building a file:// URL: any
// space or non-ASCII character in the install path is percent-encoded in
// import.meta.url but literal in argv, so the naive comparison silently fails
// and the server exits without ever starting.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'fatal', error: err instanceof Error ? err.message : String(err) })}\n`,
    );
    process.exit(1);
  });
}
