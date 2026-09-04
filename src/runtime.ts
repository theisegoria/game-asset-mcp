import path from 'node:path';
import { configuredProviders, loadConfig, type Config } from './config.js';
import { LocalCommandRegistry } from './commands/registry.js';
import { registerAssetCommands } from './commands/register.js';
import { JobStore } from './storage/jobs.js';
import { SpendLedger } from './storage/spend.js';
import { createToolContext, type ToolContext } from './tools/context.js';
import { Logger } from './util/logging.js';
import { DurableJobStore } from './jobs/durable.js';
import { describeWorkspaceFailure } from './util/workspace-diagnostics.js';

export interface GameDevRuntime {
  config: Config;
  context: ToolContext;
  registry: LocalCommandRegistry;
  providers: { image: string[]; model3d: string[] };
  durableJobs: DurableJobStore;
  /** Exposed so a transport can gate spending without reaching through context. */
  spend: SpendLedger;
  logger: Logger;
}

export async function createGameDevRuntime(options: {
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  contextOverrides?: Partial<ToolContext>;
} = {}): Promise<GameDevRuntime> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    ...(options.outputDir ? { ASSET_OUTPUT_DIR: path.resolve(options.outputDir) } : {}),
  };
  const config = loadConfig(env);
  const logger = new Logger(config.logLevel);
  // A workspace that cannot be opened used to surface as a bare errno. Under
  // MCP that reached the client as "connection closed" and nothing else, so the
  // diagnosis lives here, where both transports pass through it.
  let store: JobStore;
  let spend: SpendLedger;
  let durableJobs: DurableJobStore;
  try {
    store = await JobStore.open(config.jobsDir);
    spend = await SpendLedger.open(config.jobsDir, config.spendLimitCents);
    durableJobs = await DurableJobStore.open(config.durableJobsDir);
  } catch (error) {
    const explanation = describeWorkspaceFailure(error, config.outputDir, env);
    if (explanation) throw new Error(explanation, { cause: error });
    throw error;
  }
  const context = Object.assign(
    createToolContext({ config, logger, store, spend }),
    options.contextOverrides ?? {},
  );
  const registry = new LocalCommandRegistry();
  registerAssetCommands(registry, context);
  return {
    config,
    context,
    registry,
    providers: configuredProviders(config),
    durableJobs,
    spend,
    logger,
  };
}
