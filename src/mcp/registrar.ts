import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';
import {
  TOOL_NAME_PATTERN,
  type CommandCapability,
  type CommandDefinition,
  type ToolRegistrar,
} from '../commands/registry.js';
import type { ToolResult } from '../tools/context.js';
import type { SpendGate } from './spend-gate.js';

/**
 * Which tools a server instance exposes, chosen at launch.
 *
 * `visual` is deliberately absent: the harness commands still live in the CLI
 * dispatch tree rather than the registry, so a profile naming them would
 * advertise an empty set. It arrives when they move.
 */
export type ToolProfile = 'readonly' | 'all';

interface RegisteredEntry {
  definition: CommandDefinition;
  tool: RegisteredTool;
}

/**
 * Adapts the retained registration modules onto an `McpServer`.
 *
 * `McpServer` is NOT passed directly where `ToolRegistrar` is expected. It
 * would probably typecheck -- method-syntax bivariance papers over required vs
 * optional `inputSchema`, one-argument vs two-argument handlers, and `void` vs
 * `RegisteredTool` -- but that is four coincidences deep and would break on an
 * SDK minor bump with an inscrutable error. An adapter is needed regardless, as
 * the one place the spend gate and profile filter can intercept every tool.
 */
export class McpToolRegistrar implements ToolRegistrar {
  private readonly entries = new Map<string, RegisteredEntry>();

  constructor(
    private readonly server: McpServer,
    private readonly gate: SpendGate,
    private readonly profile: ToolProfile = 'all',
  ) {}

  registerTool<Shape extends ZodRawShape>(
    name: string,
    definition: CommandDefinition<Shape>,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ): void {
    if (!TOOL_NAME_PATTERN.test(name)) throw new Error(`invalid command name: ${name}`);
    if (this.entries.has(name)) throw new Error(`command already registered: ${name}`);

    const gated = this.gate.wrap(name, handler);

    // The input schema is advertised so a client sees real types rather than
    // guessing from a name. One consequence worth stating: the SDK validates
    // against it and answers bad input with a JSON-RPC -32602, whereas the CLI
    // returns a structured INVALID_INPUT result. The messages agree; the
    // envelopes do not. Discovery is worth more than that cosmetic divergence.
    const tool = this.server.registerTool(
      name,
      {
        ...(definition.title !== undefined ? { title: definition.title } : {}),
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        inputSchema: definition.inputSchema,
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
      },
      // `ToolCallback<Shape>` is a conditional type over a generic parameter, so
      // TypeScript defers it and cannot verify assignability structurally. The
      // cast asserts exactly the alias the SDK declares for this position.
      (async (args: unknown): Promise<CallToolResult> => {
        const result = await gated(args as z.infer<z.ZodObject<Shape>>);
        return {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        };
      }) as ToolCallback<Shape>,
    );

    // Registering then disabling, rather than skipping, keeps the tool present
    // so a profile change can enable it live via tools/listChanged.
    if (!this.permitted(definition)) tool.disable();

    this.entries.set(name, { definition: definition as CommandDefinition, tool });
  }

  private permitted(definition: CommandDefinition): boolean {
    if (this.profile === 'all') return true;
    return definition.annotations?.readOnlyHint === true;
  }

  names(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * Deliberately mirrors `LocalCommandRegistry.capabilities()` field for field,
   * so a test can assert the two are identical and catch drift between what the
   * CLI advertises and what MCP advertises.
   */
  capabilities(): CommandCapability[] {
    return [...this.entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => ({
        name,
        title: entry.definition.title ?? name,
        description: entry.definition.description ?? '',
        arguments: Object.keys(entry.definition.inputSchema).sort(),
        readOnly: entry.definition.annotations?.readOnlyHint === true,
        destructive: entry.definition.annotations?.destructiveHint === true,
        idempotent: entry.definition.annotations?.idempotentHint === true,
        openWorld: entry.definition.annotations?.openWorldHint === true,
      }));
  }
}
