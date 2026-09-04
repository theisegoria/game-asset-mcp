import type { ToolResult } from '../tools/context.js';
import type { ElicitApproval } from './spend-gate.js';

/**
 * Tools that run code the harness did not write.
 *
 * Kept as an explicit set rather than inferred from an annotation, because
 * `readOnlyHint: false` is true of many harmless local writes and this list
 * must mean exactly one thing: this call starts a process.
 */
export const EXECUTION_TOOLS: ReadonlySet<string> = new Set(['run_scenario']);

export interface ExecutionGateOptions {
  /** Absent when the connected client declared no elicitation capability. */
  canElicit?: (() => boolean) | undefined;
  elicit?: ElicitApproval | undefined;
}

function refusal(tool: string, reason: string): ToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'APPROVAL_REQUIRED',
        message: 'Running a project executable requires a human to approve this specific run.',
        tool,
        reason,
        approval: {
          transport: 'mcp',
          note:
            'The CLI requires --confirm on every scenario run. Launch-time authority alone would ' +
            'be weaker than that, so the run is also confirmed per call.',
        },
      }, null, 2),
    }],
  };
}

/**
 * Require a per-call human confirmation before a scenario executes.
 *
 * The handler already refuses without launch-time authority
 * (GAME_DEV_MCP_ALLOW_EXECUTION and friends), and that is what protects
 * `game-dev tool call`. This is the second half: the CLI asks a human to type
 * --confirm on EVERY invocation, and a standing environment variable is not
 * that. Without this, MCP would be strictly more permissive than the CLI for
 * the same action.
 */
export class ExecutionGate {
  constructor(private readonly options: ExecutionGateOptions) {}

  wrap<A>(
    name: string,
    handler: (args: A) => Promise<ToolResult>,
  ): (args: A) => Promise<ToolResult> {
    if (!EXECUTION_TOOLS.has(name)) return handler;

    return async (args: A): Promise<ToolResult> => {
      if (!this.options.elicit || !(this.options.canElicit?.() ?? true)) {
        return refusal(name, 'this MCP client cannot ask you to confirm a run');
      }

      const scenario = (args as { scenario?: unknown })?.scenario;
      const project = (args as { project?: unknown })?.project;
      const accepted = await this.options
        .elicit(
          `Run scenario "${String(scenario)}" from the project at ${String(project)}?\n\n` +
          'This starts an executable that the project declares, in a contained process, and ' +
          'seals whatever it produces into a run bundle.\n\n' +
          'Confirm this run?',
        )
        // A throw, a transport error or a timeout is not consent.
        .catch(() => false);

      if (!accepted) return refusal(name, 'the run was not confirmed');
      return handler(args);
    };
  }
}
