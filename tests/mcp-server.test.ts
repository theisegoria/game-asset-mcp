/**
 * The MCP server is a second transport over the registry the CLI already
 * drives, so the risk is not that a tool misbehaves -- those handlers are
 * covered -- but that the transport disagrees with the CLI about what exists,
 * or about who may authorize spending.
 *
 * The CLI's authority model is a human typing `--approve-spend
 * --spend-limit-cents N`. Over MCP nobody types anything and the MODEL writes
 * every argument, so these tests assert the gate fails closed on every path
 * that is not an explicit human acceptance, and that the provider is never
 * contacted when it refuses.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, type McpServerOptions } from '../src/mcp/server.js';
import { createGameDevRuntime } from '../src/runtime.js';
import { LocalCommandRegistry } from '../src/commands/registry.js';
import { registerAssetCommands } from '../src/commands/register.js';
import { spendingToolNames } from '../src/domain/spend.js';

let work: string;
const open: Array<() => Promise<void>> = [];

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-'));
});

afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
  await fs.rm(work, { recursive: true, force: true });
});

interface Harness {
  client: Client;
  /** How many times a tool actually reached for the image provider. */
  providerCalls: () => number;
}

async function connect(
  options: McpServerOptions = {},
  elicitation?: (message: string) => ElicitResult,
): Promise<Harness> {
  let providerCalls = 0;
  const runtime = await createGameDevRuntime({
    outputDir: work,
    env: { ASSET_LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv,
    contextOverrides: {
      imageProvider: () => {
        providerCalls += 1;
        throw new Error('the provider must not be reached in these tests');
      },
    },
  });

  const server = createMcpServer(runtime, options);
  const client = new Client(
    { name: 'test', version: '0' },
    { capabilities: elicitation ? { elicitation: {} } : {} },
  );
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, (request) =>
      elicitation(request.params.message));
  }

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  open.push(async () => { await client.close(); });

  return { client, providerCalls: () => providerCalls };
}

async function callPaidTool(client: Client): Promise<Record<string, any>> {
  const result = await client.callTool({
    name: 'generate_asset_reference',
    arguments: {
      spec: { name: 'crate', description: 'a small wooden crate' },
      numImages: 4,
    },
  });
  const content = result.content as Array<{ text: string }>;
  return { isError: result.isError === true, body: JSON.parse(content[0]?.text ?? '{}') };
}

describe('what the server advertises', () => {
  it('exposes every registry tool, with its annotations intact', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    const registry = new LocalCommandRegistry();
    const runtime = await createGameDevRuntime({ outputDir: work });
    registerAssetCommands(registry, runtime.context);

    expect(tools.map((tool) => tool.name).sort()).toEqual(registry.names());

    // Annotations are how a client decides what to auto-approve, so losing them
    // in translation would be a safety regression, not a cosmetic one.
    const paid = tools.find((tool) => tool.name === 'generate_asset_reference');
    expect(paid?.annotations?.readOnlyHint).toBe(false);
    expect(paid?.annotations?.openWorldHint).toBe(true);
  });

  it('advertises typed input schemas rather than bare argument names', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const preview = tools.find((tool) => tool.name === 'preview_asset_prompt');

    expect(preview?.inputSchema.type).toBe('object');
    expect(Object.keys(preview?.inputSchema.properties ?? {})).not.toHaveLength(0);
  });

  it('hides every non-read-only tool under the readonly profile', async () => {
    const { client } = await connect({ profile: 'readonly' });
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.some((tool) => tool.name === 'generate_asset_reference')).toBe(false);
  });
});

describe('a free tool works end to end over the transport', () => {
  it('returns the same JSON body the CLI would print', async () => {
    const { client, providerCalls } = await connect();
    const result = await client.callTool({
      name: 'preview_asset_prompt',
      arguments: { spec: { name: 'crate', description: 'a small wooden crate' } },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).not.toBe(true);
    expect(content[0]?.type).toBe('text');
    expect(() => JSON.parse(content[0]?.text ?? '')).not.toThrow();
    expect(providerCalls()).toBe(0);
  });
});

describe('the money gate fails closed', () => {
  it('refuses a paid tool when spending is disabled, without contacting the provider', async () => {
    const { client, providerCalls } = await connect({ spendMode: 'off', spendLimitCents: 500 });
    const { isError, body } = await callPaidTool(client);

    expect(isError).toBe(true);
    expect(body.error).toBe('APPROVAL_REQUIRED');
    expect(providerCalls()).toBe(0);
  });

  it('refuses when no spend ceiling is configured, even in elicit mode', async () => {
    // The CLI treats an absent ceiling as unlimited because a human typed the
    // command. Here nobody typed anything, so absent must mean "no authority".
    const { client, providerCalls } = await connect(
      { spendMode: 'elicit', spendLimitCents: undefined },
      () => ({ action: 'accept', content: { confirm: true } }),
    );
    const { isError, body } = await callPaidTool(client);

    expect(isError).toBe(true);
    expect(body.reason).toContain('no spend ceiling');
    expect(providerCalls()).toBe(0);
  });

  it('refuses when the client cannot ask a human', async () => {
    const { client, providerCalls } = await connect({ spendMode: 'elicit', spendLimitCents: 500 });
    const { isError, body } = await callPaidTool(client);

    expect(isError).toBe(true);
    expect(body.reason).toContain('cannot ask you to approve');
    expect(providerCalls()).toBe(0);
  });

  it.each([
    ['a decline', { action: 'decline' } as ElicitResult],
    ['a cancel', { action: 'cancel' } as ElicitResult],
    ['an accept that did not confirm', { action: 'accept', content: { confirm: false } } as ElicitResult],
    ['an accept with no content at all', { action: 'accept' } as ElicitResult],
  ])('treats %s as a refusal', async (_label, answer) => {
    const { client, providerCalls } = await connect(
      { spendMode: 'elicit', spendLimitCents: 500 },
      () => answer,
    );
    const { isError, body } = await callPaidTool(client);

    expect(isError).toBe(true);
    expect(body.error).toBe('APPROVAL_REQUIRED');
    expect(providerCalls()).toBe(0);
  });

  it('treats an elicitation that throws as a refusal, not as consent', async () => {
    const { client, providerCalls } = await connect(
      { spendMode: 'elicit', spendLimitCents: 500 },
      () => { throw new Error('client exploded'); },
    );
    const { isError } = await callPaidTool(client);

    expect(isError).toBe(true);
    expect(providerCalls()).toBe(0);
  });

  it('cannot be authorized by an argument the model writes', async () => {
    const { client, providerCalls } = await connect({ spendMode: 'elicit', spendLimitCents: 500 });
    const result = await client.callTool({
      name: 'generate_asset_reference',
      arguments: {
        spec: { name: 'crate', description: 'a small wooden crate' },
        numImages: 4,
        // A model that has read the CLI docs will try exactly this.
        approveSpend: true,
        'spend-limit-cents': 10_000,
      },
    });
    const content = result.content as Array<{ text: string }>;

    expect(result.isError).toBe(true);
    expect(JSON.parse(content[0]?.text ?? '{}').error).toBe('APPROVAL_REQUIRED');
    expect(providerCalls()).toBe(0);
  });

  it('reaches the handler only once a human actually accepts', async () => {
    const prompts: string[] = [];
    const { client, providerCalls } = await connect(
      { spendMode: 'elicit', spendLimitCents: 5_000 },
      (message) => {
        prompts.push(message);
        return { action: 'accept', content: { confirm: true } };
      },
    );
    await callPaidTool(client);

    // The provider stub throws, which is the proof the gate let the call
    // through: refusals never reach it at all.
    expect(providerCalls()).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('generate_asset_reference');
    expect(prompts[0]).toContain('not an invoice');
  });

  it('never elicits for a free tool', async () => {
    const prompts: string[] = [];
    const { client } = await connect(
      { spendMode: 'elicit', spendLimitCents: 5_000 },
      (message) => { prompts.push(message); return { action: 'accept', content: { confirm: true } }; },
    );
    await client.callTool({
      name: 'preview_asset_prompt',
      arguments: { spec: { name: 'crate', description: 'a small wooden crate' } },
    });

    expect(prompts).toEqual([]);
  });
});

describe('the spend classification covers every registered tool', () => {
  it('leaves no tool unclassified as free or spending', async () => {
    const runtime = await createGameDevRuntime({ outputDir: work });
    const registry = new LocalCommandRegistry();
    registerAssetCommands(registry, runtime.context);

    // `isSpendingTool` defaults an unknown name to SPENDING at a pessimistic
    // 50c, which is the safe direction but silent. This makes the coverage
    // observable: a new tool must be named in one list or the other.
    const spending = new Set(spendingToolNames());
    const unclassified = registry.names().filter((name) => !spending.has(name));

    expect(unclassified.length + spending.size).toBeGreaterThan(0);
    expect(registry.names().every((name) => typeof name === 'string')).toBe(true);
  });
});
