import os from 'node:os';
import path from 'node:path';

export const MCP_CLIENTS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'gemini',
  'generic',
] as const;

export type McpClient = (typeof MCP_CLIENTS)[number];

export function isMcpClient(value: string): value is McpClient {
  return (MCP_CLIENTS as readonly string[]).includes(value);
}

export interface McpConfigRequest {
  client: McpClient;
  /** Must already be absolute; the caller resolves it. */
  outputDir: string;
  /** Omitted means paid tools stay disabled. */
  spendLimitCents?: number | undefined;
  command?: string;
}

export interface McpConfigTemplate {
  client: McpClient;
  /** Where this client reads its configuration, for the human to paste into. */
  configPath: string;
  format: 'json' | 'toml';
  /** Ready to paste, already carrying the resolved absolute paths. */
  snippet: string;
  paidToolsEnabled: boolean;
  notes: string[];
}

function environment(request: McpConfigRequest): Record<string, string> {
  // ASSET_OUTPUT_DIR is always absolute here. A relative value resolves against
  // the working directory the CLIENT chose -- Claude Desktop spawns from `/` --
  // which is the single most common way this server fails to start.
  const env: Record<string, string> = { ASSET_OUTPUT_DIR: request.outputDir };
  if (request.spendLimitCents !== undefined) {
    env.ASSET_SPEND_LIMIT_CENTS = String(request.spendLimitCents);
    env.GAME_DEV_MCP_SPEND = 'elicit';
  }
  return env;
}

function toToml(name: string, command: string, env: Record<string, string>): string {
  const lines = [`[mcp_servers.${name}]`, `command = ${JSON.stringify(command)}`, 'args = []'];
  lines.push(`env = { ${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }`);
  return lines.join('\n');
}

export function buildMcpConfig(request: McpConfigRequest): McpConfigTemplate {
  const command = request.command ?? 'game-dev-mcp';
  const env = environment(request);
  const paidToolsEnabled = request.spendLimitCents !== undefined;

  const notes = paidToolsEnabled
    ? [
      'Paid tools are enabled. Every charge still requires you to approve an elicitation ' +
      'prompt in your client; the ceiling is a refusal guard, not an invoice.',
      'Do not add the paid tools to an always-allow list. Approving them once would approve ' +
      'every future charge.',
    ]
    : [
      'Paid tools are disabled: no ASSET_SPEND_LIMIT_CENTS was supplied. They still appear in ' +
      'the tool list and explain how to enable them, so a model can tell you what it cannot do ' +
      'instead of inventing a workaround.',
      'Re-run with --spend-limit-cents N to enable them.',
    ];

  const home = os.homedir();
  switch (request.client) {
    case 'claude-code':
      return {
        client: request.client,
        configPath: 'run the command below; Claude Code stores this itself',
        format: 'json',
        paidToolsEnabled,
        snippet: [
          `claude mcp add game-dev --scope user -- ${command}`,
          ...Object.entries(env).map(([key, value]) => `claude mcp update game-dev --env ${key}=${JSON.stringify(value)}`),
        ].join('\n'),
        notes: [...notes, 'Use --scope local instead of --scope user to limit it to one project.'],
      };
    case 'claude-desktop':
      return {
        client: request.client,
        configPath: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        format: 'json',
        paidToolsEnabled,
        snippet: JSON.stringify({ mcpServers: { 'game-dev': { command, args: [], env } } }, null, 2),
        notes: [...notes, 'Restart Claude Desktop after editing the file.'],
      };
    case 'codex':
      return {
        client: request.client,
        configPath: path.join(home, '.codex', 'config.toml'),
        format: 'toml',
        paidToolsEnabled,
        snippet: toToml('game_dev', command, env),
        notes: [
          ...notes,
          'The Codex plugin shipped by this project is skills-only. This MCP server is a ' +
          'separate thing you configure yourself; the two do not interact.',
        ],
      };
    case 'gemini':
      return {
        client: request.client,
        configPath: path.join(home, '.gemini', 'settings.json'),
        format: 'json',
        paidToolsEnabled,
        snippet: JSON.stringify({ mcpServers: { 'game-dev': { command, args: [], env } } }, null, 2),
        notes,
      };
    case 'generic':
    default:
      return {
        client: 'generic',
        configPath: 'your client\'s MCP server configuration',
        format: 'json',
        paidToolsEnabled,
        snippet: JSON.stringify({ command, args: [], env, transport: 'stdio' }, null, 2),
        notes: [
          ...notes,
          'Any MCP client that can launch a stdio server works: point it at the command above ' +
          'with the environment shown.',
        ],
      };
  }
}
