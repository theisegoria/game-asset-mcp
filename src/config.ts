/**
 * Configuration.
 *
 * Credentials are resolved LAZILY. The local harness must start with only one
 * provider configured so a user who only wants 3D generation is not forced to
 * hold an image-provider account; the tools that need a missing key fail with
 * a clear CONFIG_MISSING error at call time instead of preventing startup.
 */

import path from 'node:path';
import { parseLogLevel, type LogLevel } from './util/logging.js';
import { configMissing, invalidInput } from './util/errors.js';

export interface Config {
  dataRoot: string;
  outputDir: string;
  jobsDir: string;
  durableJobsDir: string;
  packagesDir: string;
  runsDir: string;
  catalogPath: string;
  maxDownloadBytes: number;
  httpTimeoutMs: number;
  /**
   * Session spend ceiling in US cents, or undefined for no limit.
   *
   * Cents rather than "credits" because two providers bill in two different
   * units — Tripo in $0.01 credits, Leonardo in USD — and a ceiling mixing them
   * would be meaningless.
   */
  spendLimitCents?: number;
  logLevel: LogLevel;
  tripoApiKey?: string;
  leonardoApiKey?: string;
}

/**
 * Parse a positive integer from the environment, or refuse loudly.
 *
 * `Number.parseInt` is far too forgiving here: "1e9" parses as 1, which would
 * silently set a one-byte download ceiling, and "256MB" parses as 256. Both
 * look like working configuration and neither is. A digits-only check turns a
 * typo into an error the user can see instead of a cap they cannot explain.
 */
function positiveIntFromEnv(raw: string | undefined, fallback: number, varName: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) {
    throw invalidInput(
      `${varName} must be a plain positive integer (digits only), received "${trimmed}"`,
      { variable: varName },
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidInput(`${varName} must be a positive integer within the safe range`, {
      variable: varName,
    });
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const outputDir = path.resolve(env.ASSET_OUTPUT_DIR?.trim() || path.join(process.cwd(), 'assets', 'generated'));
  const dataRoot = path.resolve(env.GAME_DEV_DATA_ROOT?.trim() || path.join(outputDir, '.game-dev'));
  return {
    dataRoot,
    outputDir,
    // Job records live beside the assets but in a dot-directory, so a user
    // browsing their asset workspace sees assets, not bookkeeping.
    jobsDir: path.join(outputDir, '.jobs'),
    durableJobsDir: path.join(dataRoot, 'jobs'),
    packagesDir: path.join(dataRoot, 'packages'),
    runsDir: path.join(dataRoot, 'runs'),
    catalogPath: path.join(dataRoot, 'catalog.sqlite3'),
    maxDownloadBytes: positiveIntFromEnv(
      env.ASSET_MAX_DOWNLOAD_BYTES,
      256 * 1024 * 1024,
      'ASSET_MAX_DOWNLOAD_BYTES',
    ),
    httpTimeoutMs: positiveIntFromEnv(env.ASSET_HTTP_TIMEOUT_MS, 60_000, 'ASSET_HTTP_TIMEOUT_MS'),
    ...(env.ASSET_SPEND_LIMIT_CENTS?.trim()
      ? {
          spendLimitCents: positiveIntFromEnv(
            env.ASSET_SPEND_LIMIT_CENTS,
            0,
            'ASSET_SPEND_LIMIT_CENTS',
          ),
        }
      : {}),
    logLevel: parseLogLevel(env.ASSET_LOG_LEVEL),
    ...(env.TRIPO_API_KEY?.trim() ? { tripoApiKey: env.TRIPO_API_KEY.trim() } : {}),
    ...(env.LEONARDO_API_KEY?.trim() ? { leonardoApiKey: env.LEONARDO_API_KEY.trim() } : {}),
  };
}

export function requireTripoKey(config: Config): string {
  if (!config.tripoApiKey) throw configMissing('TRIPO_API_KEY', 'Tripo');
  return config.tripoApiKey;
}

export function requireLeonardoKey(config: Config): string {
  if (!config.leonardoApiKey) throw configMissing('LEONARDO_API_KEY', 'Leonardo.Ai');
  return config.leonardoApiKey;
}

/** Which providers are usable right now — surfaced by capability discovery. */
export function configuredProviders(config: Config): { image: string[]; model3d: string[] } {
  return {
    image: config.leonardoApiKey ? ['leonardo'] : [],
    model3d: config.tripoApiKey ? ['tripo'] : [],
  };
}
