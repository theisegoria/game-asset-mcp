/**
 * Writes into the user's project, exposed to MCP behind authority.
 *
 * Installing an adapter manifest or the probe SDK writes files OUTSIDE the
 * tool's workspace, into a game project. On the CLI that is a --confirm
 * action. Over MCP the model writes every argument, so confirmation cannot be
 * an argument: authority comes from GAME_DEV_MCP_ALLOW_PROJECT_WRITE=1 in the
 * launch environment -- which a human wrote and a model cannot reach -- and
 * the transport adds a per-call confirmation on top.
 *
 * The environment check lives HERE, in the handler, not only in the MCP
 * transport, because registering a tool also exposes it through
 * `game-dev tool call`, and a gate one entry point walks around is not a gate.
 *
 * Each write has a free plan_* twin that needs no authority and writes
 * nothing, so a model can always see what would happen before asking.
 */

import { z } from 'zod';
import type { ToolRegistrar } from '../commands/registry.js';
import { installProbeSdk } from '../harness/probe-install.js';
import { installAdapterTemplate, listAdapterTemplates } from '../harness/templates.js';
import { invalidInput } from '../util/errors.js';
import { guard, ok, type ToolContext } from './context.js';

const PROJECT_WRITE_ENV = 'GAME_DEV_MCP_ALLOW_PROJECT_WRITE';

export function assertProjectWriteAuthority(): void {
  if (process.env[PROJECT_WRITE_ENV]?.trim() === '1') return;
  throw invalidInput('writing into a project requires authority this process was not given', {
    missingGrants: ['project-write'],
    grantBySetting: [`${PROJECT_WRITE_ENV}=1`],
    note:
      'Set this in the server configuration a human controls, then restart. It is deliberately ' +
      'not a tool argument: an argument the caller writes cannot authorize the caller. The plan_* ' +
      'tools show what would be written and need no authority.',
  });
}

const projectPath = z.string().min(1).describe('Path to the game project.');

export function registerProjectWriteTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'plan_probe_install',
    {
      title: 'Plan installing the probe SDK into a project',
      description:
        'FREE, local, writes nothing. Reports exactly which files `install_probe_sdk` would write, ' +
        'where, with their hashes, and whether identical copies already exist. Refuses if the ' +
        'project holds a changed copy, so you learn that before anything is touched.',
      inputSchema: {
        project: projectPath,
        destination: z.string().min(1).optional()
          .describe('Project-relative directory. Defaults to third_party/gdprobe.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'plan_probe_install', async (args) =>
      ok(await installProbeSdk({ projectRoot: args.project, destination: args.destination, confirm: false }))),
  );

  server.registerTool(
    'install_probe_sdk',
    {
      title: 'Install the probe SDK sources into a project',
      description:
        'Writes gdprobe.h and gdprobe.c into the project so its build can compile them in. ' +
        'Requires GAME_DEV_MCP_ALLOW_PROJECT_WRITE=1 in the server environment plus a ' +
        'confirmation; call plan_probe_install first. Never overwrites a copy that differs.',
      inputSchema: {
        project: projectPath,
        destination: z.string().min(1).optional()
          .describe('Project-relative directory. Defaults to third_party/gdprobe.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'install_probe_sdk', async (args) => {
      assertProjectWriteAuthority();
      return ok(await installProbeSdk({ projectRoot: args.project, destination: args.destination, confirm: true }));
    }),
  );

  server.registerTool(
    'list_adapter_templates',
    {
      title: 'List the packaged capture adapter templates',
      description: 'FREE, local. The declarative adapter manifests this package ships, by id.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'list_adapter_templates', async () => ok({ templates: await listAdapterTemplates() })),
  );

  server.registerTool(
    'plan_adapter_install',
    {
      title: 'Plan installing an adapter template into a project',
      description:
        'FREE, local, writes nothing. Reports where the manifest would go and which scenarios it ' +
        'declares. Refuses if the project already has a different .game-dev/adapter.json.',
      inputSchema: { project: projectPath, template: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'plan_adapter_install', async (args) =>
      ok(await installAdapterTemplate({ templateId: args.template, projectRoot: args.project, confirm: false }))),
  );

  server.registerTool(
    'install_adapter_template',
    {
      title: 'Install an adapter template into a project',
      description:
        'Writes .game-dev/adapter.json from a packaged template. It executes no project command. ' +
        'Requires GAME_DEV_MCP_ALLOW_PROJECT_WRITE=1 in the server environment plus a ' +
        'confirmation; call plan_adapter_install first.',
      inputSchema: { project: projectPath, template: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'install_adapter_template', async (args) => {
      assertProjectWriteAuthority();
      return ok(await installAdapterTemplate({ templateId: args.template, projectRoot: args.project, confirm: true }));
    }),
  );
}
