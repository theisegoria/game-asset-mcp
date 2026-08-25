/**
 * Call a tool the way a client actually calls it.
 *
 * WHY THIS EXISTS. Before this harness, no test in the suite invoked a tool
 * through its registered handler — the suite tested domain helpers and the
 * Blender subprocess and stopped at the tool boundary. That gap has a specific,
 * repeated signature: a value is computed correctly and then dropped on its way
 * into the response.
 *
 *   - `weldSkipped` was computed by the normalizer and dropped by the batch.
 *   - `factorApplied` was accepted in a signature, declared on the receipt type,
 *     passed by two call sites, headlined in a release note, and never copied
 *     into the object — so every consumer read `undefined`.
 *   - `stdoutTruncated` was set correctly and reached no tool response at all.
 *
 * Every one of those is invisible to a helper-level test by construction: the
 * helper is right. Only a caller reading the actual response can see it. And
 * optional-property typing means `tsc` reports nothing.
 *
 * This connects a real MCP Client to a real McpServer over an in-memory
 * transport, so the assertions run against the same JSON a client receives —
 * no subprocess, no build step, no network.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '../../src/util/logging.js';
import { JobStore } from '../../src/storage/jobs.js';
import { SpendLedger } from '../../src/storage/spend.js';
import { createToolContext } from '../../src/tools/context.js';
import { loadConfig } from '../../src/config.js';
import type { ToolContext } from '../../src/tools/context.js';

export interface ToolClient {
  /** Calls a tool and returns its parsed JSON payload plus the error flag. */
  call(name: string, args: Record<string, unknown>): Promise<{
    isError: boolean;
    payload: Record<string, unknown>;
    text: string;
  }>;
  close(): Promise<void>;
}

/**
 * @param register  the tool-registration function under test
 * @param workspace an existing directory to use as ASSET_OUTPUT_DIR
 */
export async function connectTools(
  register: (server: McpServer, ctx: ToolContext) => void,
  workspace: string,
  /**
   * Overrides applied to the context before the tools are registered.
   *
   * Exists so a provider-backed tool can be exercised END TO END without a
   * credential or a network call — stub the provider, keep everything else
   * real. Without it those tools are only ever tested at the provider layer,
   * which is exactly the boundary where this repo keeps losing values.
   */
  overrides: Partial<ToolContext> = {},
): Promise<ToolClient> {
  // Build the config from a real env so the tools see the same shape they do in
  // production, rather than a hand-written object that could drift from it.
  const config = loadConfig({
    ...process.env,
    ASSET_OUTPUT_DIR: workspace,
  } as NodeJS.ProcessEnv);
  const logger = new Logger('error');
  const store = await JobStore.open(config.jobsDir);
  const spend = await SpendLedger.open(config.jobsDir, config.spendLimitCents);
  const ctx = Object.assign(createToolContext({ config, logger, store, spend }), overrides);

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  register(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'harness', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      const text = result.content?.[0]?.text ?? '';
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // Left empty deliberately: a non-JSON body is a finding, and the raw
        // text is returned so the test can say so rather than crashing here.
      }
      return { isError: result.isError === true, payload, text };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
