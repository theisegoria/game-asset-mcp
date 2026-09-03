#!/usr/bin/env node
/**
 * Game Development Studio -- MCP server entry point.
 *
 * Startup deliberately does NOT require credentials. A user with only a 3D
 * provider configured gets a working server whose image tools report a clear
 * CONFIG_MISSING; refusing to boot instead would make a partially-configured
 * setup look broken rather than partially capable.
 *
 * This is a second transport over the same registry the CLI drives, not a
 * second implementation. Every handler, Zod contract and evidence ceiling is
 * the one `game-dev` already uses.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAssetCommands } from '../commands/register.js';
import { createGameDevRuntime, type GameDevRuntime } from '../runtime.js';
import { isDirectInvocation } from '../util/entrypoint.js';
import { GAME_DEV_NAME, GAME_DEV_VERSION } from '../version.js';
import { McpToolRegistrar, type ToolProfile } from './registrar.js';
import { SpendGate, type SpendMode } from './spend-gate.js';

export interface McpServerOptions {
  profile?: ToolProfile;
  spendMode?: SpendMode;
  spendLimitCents?: number | undefined;
}

function readProfile(env: NodeJS.ProcessEnv): ToolProfile {
  return env.GAME_DEV_MCP_PROFILE?.trim() === 'readonly' ? 'readonly' : 'all';
}

function readSpendMode(env: NodeJS.ProcessEnv): SpendMode {
  return env.GAME_DEV_MCP_SPEND?.trim() === 'elicit' ? 'elicit' : 'off';
}

/**
 * Builds the server without choosing a transport and without touching
 * `process.exit`, so tests can drive it over an in-memory pair.
 */
export function createMcpServer(
  runtime: GameDevRuntime,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: GAME_DEV_NAME, version: GAME_DEV_VERSION });

  const gate = new SpendGate({
    mode: options.spendMode ?? 'off',
    limitCents: options.spendLimitCents,
    // Resolved per call rather than at construction: capabilities are only
    // known after the client initializes, which happens after this returns.
    canElicit: () => server.server.getClientCapabilities()?.elicitation !== undefined,
    elicit: async (message: string): Promise<boolean> => {
      const answer = await server.server.elicitInput({
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Authorize this charge',
              description: 'Only an explicit yes authorizes provider spending.',
            },
          },
          required: ['confirm'],
        },
      });
      return answer.action === 'accept' && answer.content?.confirm === true;
    },
  });

  const registrar = new McpToolRegistrar(server, gate, options.profile ?? 'all');
  registerAssetCommands(registrar, runtime.context);
  return server;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = await createGameDevRuntime();
  const spendMode = readSpendMode(env);
  const server = createMcpServer(runtime, {
    profile: readProfile(env),
    spendMode,
    spendLimitCents: runtime.config.spendLimitCents,
  });

  // stdout is the JSON-RPC channel. Every diagnostic goes to stderr, which the
  // logger already guarantees.
  runtime.logger.info('game-development-studio MCP starting', {
    version: GAME_DEV_VERSION,
    outputDir: runtime.config.outputDir,
    profile: readProfile(env),
    paidTools: spendMode === 'elicit' && runtime.config.spendLimitCents !== undefined
      ? 'enabled, per-call human approval required'
      : 'disabled',
    imageProviders: runtime.providers.image,
    model3dProviders: runtime.providers.model3d,
  });
  if (runtime.providers.image.length === 0) {
    runtime.logger.warn('no image provider configured — image tools will report CONFIG_MISSING', {
      hint: 'set LEONARDO_API_KEY',
    });
  }
  if (runtime.providers.model3d.length === 0) {
    runtime.logger.warn('no 3D provider configured — 3D tools will report CONFIG_MISSING', {
      hint: 'set TRIPO_API_KEY',
    });
  }

  await server.connect(new StdioServerTransport());
  runtime.logger.info('game-development-studio MCP connected on stdio');
}

if (isDirectInvocation(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      msg: 'fatal',
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exit(1);
  });
}
