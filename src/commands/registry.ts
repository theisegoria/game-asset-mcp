import { z, type ZodRawShape } from 'zod';
import type { ToolResult } from '../tools/context.js';

export interface CommandAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface CommandDefinition<Shape extends ZodRawShape = ZodRawShape> {
  title?: string;
  description?: string;
  inputSchema: Shape;
  annotations?: CommandAnnotations;
}

export interface CommandCapability {
  name: string;
  title: string;
  description: string;
  arguments: string[];
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

type CommandHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Shared so every registrar rejects the same names. Duplicating the literal is
 * how a transport quietly starts accepting a name the others refuse.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

interface RegisteredCommand {
  definition: CommandDefinition;
  handler: CommandHandler;
}

/**
 * Framework-neutral registry for local game-development operations.
 *
 * The original project registered these handlers on an MCP server. Keeping a
 * tiny local registry preserves the well-tested handlers and their Zod input
 * contracts while making the CLI process the only transport boundary.
 */
export class LocalCommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();

  registerTool<Shape extends ZodRawShape>(
    name: string,
    definition: CommandDefinition<Shape>,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ): void {
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`invalid command name: ${name}`);
    }
    if (this.commands.has(name)) {
      throw new Error(`command already registered: ${name}`);
    }
    this.commands.set(name, {
      definition,
      handler: handler as CommandHandler,
    });
  }

  names(): string[] {
    return [...this.commands.keys()].sort();
  }

  capabilities(): CommandCapability[] {
    return [...this.commands.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => ({
        name,
        title: command.definition.title ?? name,
        description: command.definition.description ?? '',
        arguments: Object.keys(command.definition.inputSchema).sort(),
        readOnly: command.definition.annotations?.readOnlyHint === true,
        destructive: command.definition.annotations?.destructiveHint === true,
        idempotent: command.definition.annotations?.idempotentHint === true,
        openWorld: command.definition.annotations?.openWorldHint === true,
      }));
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const command = this.commands.get(name);
    if (!command) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'NOT_FOUND',
            message: `unknown local command: ${name}`,
            available: this.names(),
          }, null, 2),
        }],
      };
    }

    const validation = z.object(command.definition.inputSchema).safeParse(args ?? {});
    if (!validation.success) {
      const issues = validation.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'INVALID_INPUT',
            message: `input validation failed: ${issues.map((issue) => `${issue.path || 'request'} ${issue.message}`).join('; ')}`,
            retryable: false,
            details: { issues },
          }, null, 2),
        }],
      };
    }
    return command.handler(validation.data);
  }
}

/** Structural type consumed by the retained operation registration modules. */
export interface ToolRegistrar {
  registerTool<Shape extends ZodRawShape>(
    name: string,
    definition: CommandDefinition<Shape>,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ): void;
}
