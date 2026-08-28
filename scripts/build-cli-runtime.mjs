#!/usr/bin/env node

import { buildRuntimePayload, parseBuildArguments } from './cli-runtime-payload.mjs';

function usage() {
  return 'Usage: node scripts/build-cli-runtime.mjs --output <GameDevelopmentStudioRuntime> [--source <repository-root>] [--node <node-binary>]';
}

async function main() {
  const options = parseBuildArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await buildRuntimePayload(options);
  console.log(JSON.stringify({
    ...result,
    schema: 'game_dev.cli_runtime_stage.v1',
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
