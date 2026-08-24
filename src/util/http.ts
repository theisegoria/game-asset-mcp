/**
 * HTTP with timeouts, bounded retries, and safe downloads.
 *
 * Two invariants here are MECHANISMS, not comments, because both were once
 * comments and both were violated:
 *
 *   1. A non-GET request may never be retried automatically. A network error
 *      after the server accepted the request is indistinguishable from one
 *      before it, so a retry can silently double-charge. Passing retries > 0
 *      with a non-GET method is refused outright rather than trusted.
 *
 *   2. Every URL we touch must be https — including every hop of a redirect
 *      chain. Validating only the first URL let a provider CDN downgrade the
 *      transport to cleartext without any signal, so redirects are followed
 *      manually and re-checked at each hop.
 */

import { AssetPipelineError, invalidInput } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Retries for transient failures. Refused for non-GET methods — see invariant 1. */
  retries?: number;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_REDIRECTS = 5;

function backoffMs(attempt: number): number {
  // Deterministic (no jitter): one client polling one task gains nothing from
  // jitter, and determinism makes the behaviour testable.
  return Math.min(400 * 2 ** attempt, 8_000);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpResponse<T> {
  status: number;
  /** Undefined for an empty body — callers must handle it rather than trust a cast. */
  data: T | undefined;
}

/** A URL safe to log: no credentials, no query string (signed URLs carry tokens there). */
export function safeUrlForLogs(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

/** Reject non-HTTPS URLs. Provider payloads are untrusted input. */
export function assertHttps(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AssetPipelineError('UNSUPPORTED_PROTOCOL', 'not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new AssetPipelineError(
      'UNSUPPORTED_PROTOCOL',
      `refusing non-HTTPS URL (${parsed.protocol}): transport is restricted to https`,
      { details: { url: safeUrlForLogs(url) } },
    );
  }
  return parsed;
}

/** Normalise the retry budget; a NaN or negative value must not mean "make no request". */
function normalizeRetries(raw: number | undefined, method: string): number {
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0) {
    throw invalidInput(`retries must be a non-negative integer, received ${String(raw)}`);
  }
  if (raw > 0 && method !== 'GET') {
    throw invalidInput(
      `refusing to auto-retry a ${method} request: a retry can double-charge a credit-consuming call`,
      { method, retries: raw },
    );
  }
  return raw;
}

/** Link an external signal to our controller, honouring one that already fired. */
function linkSignal(controller: AbortController, external: AbortSignal | undefined): () => void {
  if (!external) return () => {};
  // An already-aborted signal never fires the event, so check it directly —
  // otherwise a cancelled operation still reaches the provider and still bills.
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = (): void => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/**
 * Fetch following redirects manually so every hop is https-checked.
 */
async function fetchHttpsOnly(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let current = assertHttps(url).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual', signal });
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    // NEVER follow a redirect on a non-GET request. A 307/308 re-sends the
    // body verbatim, so following even one hop can deliver the same
    // credit-consuming request twice — and a chain could deliver it six times.
    // Refusing is safe: no supported provider redirects a create call, so this
    // only fires on something genuinely unexpected.
    if (init.method && init.method !== 'GET') {
      throw new AssetPipelineError(
        'PROVIDER_HTTP',
        `refusing to follow a redirect on a ${init.method} request: re-delivering the body can double-charge`,
        { details: { status: response.status, url: safeUrlForLogs(current) } },
      );
    }

    const next = new URL(location, current).toString();
    // Re-check on every hop: this is the whole point of manual redirects.
    assertHttps(next);

    // Strip credentials when the origin changes. The redirect target is chosen
    // by the responding server, not by us, so forwarding Authorization hands
    // our provider key to whatever host it names.
    if (new URL(next).origin !== new URL(current).origin) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'authorization' || lower === 'cookie') delete headers[key];
      }
      init = { ...init, headers };
    }

    current = next;
  }

  throw new AssetPipelineError('PROVIDER_HTTP', `too many redirects (>${MAX_REDIRECTS})`, {
    details: { url: safeUrlForLogs(url) },
  });
}

export async function requestJson<T>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
  const method = options.method ?? 'GET';
  const retries = normalizeRetries(options.retries, method);
  // Enforce the transport rule on the credential path too, not just downloads.
  assertHttps(url);

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const unlink = linkSignal(controller, options.signal);

    try {
      const response = await fetchHttpsOnly(
        url,
        {
          method,
          headers: {
            accept: 'application/json',
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        },
        controller.signal,
      );

      const text = await response.text();

      if (!response.ok) {
        const retryable = RETRYABLE_STATUS.has(response.status);
        const error = new AssetPipelineError(
          response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_HTTP',
          `provider returned HTTP ${response.status}: ${text.slice(0, 400)}`,
          { retryable, details: { status: response.status, url: safeUrlForLogs(url) } },
        );
        if (retryable && attempt < retries) {
          lastError = error;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      }

      if (text.length === 0) return { status: response.status, data: undefined };

      try {
        return { status: response.status, data: JSON.parse(text) as T };
      } catch {
        throw new AssetPipelineError(
          'PROVIDER_MALFORMED_RESPONSE',
          `provider returned non-JSON body: ${text.slice(0, 200)}`,
          { details: { url: safeUrlForLogs(url) } },
        );
      }
    } catch (err) {
      if (err instanceof AssetPipelineError && !err.retryable) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      const wrapped = aborted
        ? new AssetPipelineError('TIMEOUT', `request timed out after ${options.timeoutMs}ms`, {
            retryable: true,
            details: { url: safeUrlForLogs(url) },
          })
        : err;
      lastError = wrapped;
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw wrapped;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new AssetPipelineError('PROVIDER_HTTP', 'request failed before any attempt was made');
}

export interface DownloadResult {
  bytes: Uint8Array;
  contentType?: string;
}

/**
 * Download a remote file with a hard size ceiling.
 *
 * The cap is enforced while streaming, not after: a server that omits or lies
 * about Content-Length would otherwise exhaust memory before we ever looked.
 */
export async function downloadFile(
  url: string,
  options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const unlink = linkSignal(controller, options.signal);

  try {
    const response = await fetchHttpsOnly(url, {}, controller.signal);
    if (!response.ok) {
      throw new AssetPipelineError('PROVIDER_HTTP', `download failed with HTTP ${response.status}`, {
        retryable: RETRYABLE_STATUS.has(response.status),
        details: { status: response.status, url: safeUrlForLogs(url) },
      });
    }

    const declaredHeader = response.headers.get('content-length');
    const declared = declaredHeader === null ? Number.NaN : Number.parseInt(declaredHeader, 10);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new AssetPipelineError(
        'DOWNLOAD_TOO_LARGE',
        `declared size ${declared} exceeds limit ${options.maxBytes}`,
        { details: { declared, limit: options.maxBytes } },
      );
    }

    const contentType = response.headers.get('content-type');
    const chunks: Uint8Array[] = [];
    let total = 0;

    if (response.body) {
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.byteLength;
          if (total > options.maxBytes) {
            controller.abort();
            throw new AssetPipelineError(
              'DOWNLOAD_TOO_LARGE',
              `download exceeded limit ${options.maxBytes} bytes`,
              { details: { limit: options.maxBytes } },
            );
          }
          chunks.push(chunk);
        }
      } catch (err) {
        if (err instanceof AssetPipelineError) throw err;
        // A dropped connection mid-download is transient, and provider URLs
        // expire — telling the caller not to retry would lose the asset.
        throw new AssetPipelineError(
          'PROVIDER_HTTP',
          `download interrupted: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, details: { url: safeUrlForLogs(url) }, cause: err },
        );
      }
    } else {
      const buffered = new Uint8Array(await response.arrayBuffer());
      if (buffered.byteLength > options.maxBytes) {
        throw new AssetPipelineError(
          'DOWNLOAD_TOO_LARGE',
          `download exceeded limit ${options.maxBytes}`,
          { details: { limit: options.maxBytes } },
        );
      }
      total = buffered.byteLength;
      chunks.push(buffered);
    }

    // A server that over-delivers against its own Content-Length is returning
    // something other than what it promised; accepting a truncation silently
    // would hand the caller a corrupt model that still hashes "successfully".
    if (Number.isFinite(declared) && total !== declared) {
      throw new AssetPipelineError(
        'PROVIDER_MALFORMED_RESPONSE',
        `download size ${total} does not match declared Content-Length ${declared}`,
        { retryable: true, details: { declared, received: total } },
      );
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: out, ...(contentType ? { contentType } : {}) };
  } finally {
    clearTimeout(timer);
    unlink();
  }
}
