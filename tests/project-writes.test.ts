/**
 * Installing the probe SDK or an adapter manifest writes into the user's
 * project -- outside the tool's workspace. On the CLI that is --confirm. Over
 * MCP the model writes every argument, so confirmation cannot be an argument.
 *
 * Two layers, tested separately because they defend different doors. The
 * handler refuses without GAME_DEV_MCP_ALLOW_PROJECT_WRITE, and that layer is
 * what protects `game-dev tool call`. The transport then asks a human per call,
 * because a standing environment variable is not a per-invocation act.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createGameDevRuntime } from '../src/runtime.js';
import { listAdapterTemplates } from '../src/harness/templates.js';
import { registerProjectWriteTools } from '../src/tools/project-writes.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

const ENV = 'GAME_DEV_MCP_ALLOW_PROJECT_WRITE';
let work: string;
let project: string;
let savedEnv: string | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'project-writes-'));
  project = path.join(work, 'engine');
  await fs.mkdir(project);
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
  while (closers.length > 0) await closers.pop()?.();
  await fs.rm(work, { recursive: true, force: true });
});

const sdkHeader = () => path.join(project, 'third_party', 'gdprobe', 'gdprobe.h');

describe('the handler layer, which is what `tool call` reaches', () => {
  let tools: ToolClient;
  beforeEach(async () => { tools = await connectTools(registerProjectWriteTools, work); });
  afterEach(async () => { await tools.close(); });

  it('plans with no authority and writes nothing', async () => {
    const { isError, payload } = await tools.call('plan_probe_install', { project });

    expect(isError).toBe(false);
    expect(payload.dryRun).toBe(true);
    await expect(fs.access(sdkHeader())).rejects.toThrow();
  });

  it('refuses the write without authority, naming the setting to grant', async () => {
    const { isError, payload } = await tools.call('install_probe_sdk', { project });

    expect(isError).toBe(true);
    expect((payload.details as { grantBySetting: string[] }).grantBySetting).toEqual([`${ENV}=1`]);
    await expect(fs.access(sdkHeader())).rejects.toThrow();
  });

  it('cannot be authorized by an argument the caller writes', async () => {
    const { isError } = await tools.call('install_probe_sdk', { project, confirm: true, allow: true } as never);

    expect(isError).toBe(true);
    await expect(fs.access(sdkHeader())).rejects.toThrow();
  });

  it('writes once authority is granted in the environment', async () => {
    process.env[ENV] = '1';
    const { isError, payload } = await tools.call('install_probe_sdk', { project });

    expect(isError).toBe(false);
    expect(payload.dryRun).toBe(false);
    await expect(fs.access(sdkHeader())).resolves.toBeUndefined();
  });

  it('gates adapter installation the same way', async () => {
    const [template] = await listAdapterTemplates();
    const id = template?.id as string;
    expect(id).toBeTruthy();

    const refused = await tools.call('install_adapter_template', { project, template: id });
    expect(refused.isError).toBe(true);
    await expect(fs.access(path.join(project, '.game-dev', 'adapter.json'))).rejects.toThrow();

    process.env[ENV] = '1';
    const written = await tools.call('install_adapter_template', { project, template: id });
    expect(written.isError).toBe(false);
    await expect(fs.access(path.join(project, '.game-dev', 'adapter.json'))).resolves.toBeUndefined();
  });
});

describe('the transport layer, which asks a human each time', () => {
  async function connect(elicitation?: (message: string) => ElicitResult): Promise<Client> {
    const runtime = await createGameDevRuntime({ outputDir: work, env: { ASSET_LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv });
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: elicitation ? { elicitation: {} } : {} });
    if (elicitation) client.setRequestHandler(ElicitRequestSchema, (request) => elicitation(request.params.message));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    closers.push(async () => { await client.close(); });
    return client;
  }

  async function install(client: Client) {
    const result = await client.callTool({ name: 'install_probe_sdk', arguments: { project } });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '{}';
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  }

  it('refuses when the client cannot ask a human, even with environment authority', async () => {
    process.env[ENV] = '1';
    const { isError, body } = await install(await connect());

    expect(isError).toBe(true);
    expect(body.error).toBe('APPROVAL_REQUIRED');
    await expect(fs.access(sdkHeader())).rejects.toThrow();
  });

  it('refuses a declined confirmation and writes nothing', async () => {
    process.env[ENV] = '1';
    const { isError } = await install(await connect(() => ({ action: 'decline' })));

    expect(isError).toBe(true);
    await expect(fs.access(sdkHeader())).rejects.toThrow();
  });

  it('says what is being confirmed: a write, not a run', async () => {
    process.env[ENV] = '1';
    const prompts: string[] = [];
    await install(await connect((message) => { prompts.push(message); return { action: 'decline' }; }));

    expect(prompts[0]).toContain('Write files into the project');
    expect(prompts[0]).toContain('install_probe_sdk');
    expect(prompts[0]).not.toContain('Run scenario');
  });

  it('writes only when a human accepts and the environment agrees', async () => {
    process.env[ENV] = '1';
    const { isError } = await install(await connect(() => ({ action: 'accept', content: { confirm: true } })));

    expect(isError).toBe(false);
    await expect(fs.access(sdkHeader())).resolves.toBeUndefined();
  });

  it('is still refused by the handler when a human accepts but the environment does not', async () => {
    // The elicitation alone is not enough: both layers must agree.
    const { isError, body } = await install(await connect(() => ({ action: 'accept', content: { confirm: true } })));

    expect(isError).toBe(true);
    expect((body.details as { grantBySetting: string[] }).grantBySetting).toEqual([`${ENV}=1`]);
    await expect(fs.access(sdkHeader())).rejects.toThrow();
  });
});
