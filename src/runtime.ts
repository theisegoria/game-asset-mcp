import path from 'node:path';
import { configuredProviders, loadConfig, type Config } from './config.js';
import { LocalCommandRegistry } from './commands/registry.js';
import { registerAssetCommands } from './commands/register.js';
import { JobStore } from './storage/jobs.js';
import { SpendLedger } from './storage/spend.js';
import { createToolContext, type ToolContext } from './tools/context.js';
import { Logger } from './util/logging.js';
import { DurableJobStore } from './jobs/durable.js';

export interface GameDevRuntime {
  config: Config;
  context: ToolContext;
  registry: LocalCommandRegistry;
  providers: { image: string[]; model3d: string[] };
  durableJobs: DurableJobStore;
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
  const store = await JobStore.open(config.jobsDir);
  const spend = await SpendLedger.open(config.jobsDir, config.spendLimitCents);
  const durableJobs = await DurableJobStore.open(config.durableJobsDir);
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
  };
}
