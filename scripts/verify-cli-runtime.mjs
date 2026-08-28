#!/usr/bin/env node

import { parseVerifyArguments, verifyRuntimePayload } from './cli-runtime-payload.mjs';

function usage() {
  return 'Usage: node scripts/verify-cli-runtime.mjs --runtime <GameDevelopmentStudioRuntime>';
}

async function main() {
  const options = parseVerifyArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  console.log(JSON.stringify(await verifyRuntimePayload(options.runtimeRoot)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
