/**
 * Structured errors.
 *
 * Every error carries a machine-readable `error` field so an agent can decide what to
 * do next without parsing prose, and a `retryable` flag so callers never retry
 * something that would double-charge the user.
 */

export type ErrorCode =
  | 'CONFIG_MISSING'
  | 'PROVIDER_HTTP'
  | 'PROVIDER_TASK_FAILED'
  | 'PROVIDER_MALFORMED_RESPONSE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_INPUT'
  | 'DOWNLOAD_TOO_LARGE'
  | 'UNSUPPORTED_PROTOCOL'
  | 'PATH_ESCAPE'
  | 'TIMEOUT'
  | 'INSPECTION_FAILED'
  | 'SPEND_LIMIT_EXCEEDED';

export class AssetPipelineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AssetPipelineError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}

export function configMissing(envVar: string, provider: string): AssetPipelineError {
  return new AssetPipelineError(
    'CONFIG_MISSING',
    `${provider} is not configured: set ${envVar} in the environment. ` +
      `Other providers remain usable.`,
    { details: { envVar, provider } },
  );
}

export function notFound(what: string, id: string): AssetPipelineError {
  return new AssetPipelineError('NOT_FOUND', `${what} not found: ${id}`, { details: { id } });
}

export function invalidState(message: string, details?: Record<string, unknown>): AssetPipelineError {
  return new AssetPipelineError('INVALID_STATE', message, { details: details ?? {} });
}

export function invalidInput(message: string, details?: Record<string, unknown>): AssetPipelineError {
  return new AssetPipelineError('INVALID_INPUT', message, { details: details ?? {} });
}

/** Normalize anything thrown into a reportable shape. */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof AssetPipelineError) return err.toJSON();
  if (err instanceof Error) return { error: 'UNKNOWN', message: err.message, retryable: false };
  return { error: 'UNKNOWN', message: String(err), retryable: false };
}
