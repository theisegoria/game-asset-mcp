/**
 * Structured logging to stderr.
 *
 * stdout belongs to the MCP protocol — writing anything there corrupts the
 * transport, so every log line goes to stderr.
 *
 * Secrets are redacted centrally rather than at each call site, because the
 * one call site that forgets is the one that leaks.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** Substrings that mark a key as secret-bearing, matched case-insensitively. */
const SECRET_HINTS = ['key', 'token', 'secret', 'password', 'authorization', 'auth', 'credential'];

function looksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Replace secret-looking values with a length-preserving marker. Recurses into
 * plain objects and arrays; leaves other types alone.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = looksSecret(key) ? '[redacted]' : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor(private readonly level: LogLevel) {}

  private write(level: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[this.level] < LEVEL_RANK[level]) return;
    const line: Record<string, unknown> = {
      level,
      msg: message,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    try {
      process.stderr.write(`${JSON.stringify(line)}\n`);
    } catch {
      // A field that cannot be serialised (a BigInt credit count, a cycle)
      // must not take down the operation the log was reporting on.
      process.stderr.write(`${JSON.stringify({ level, msg: message, note: 'fields unserialisable' })}\n`);
    }
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  // `Object.hasOwn`, not `in`: `'constructor' in LEVEL_RANK` is true, and that
  // value is a Function, so every rank comparison became NaN-false and ALL
  // levels logged — turning ASSET_LOG_LEVEL=constructor into silent full debug.
  if (raw && Object.hasOwn(LEVEL_RANK, raw)) return raw as LogLevel;
  return 'info';
}
