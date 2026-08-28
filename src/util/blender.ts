/**
 * Locating and driving a local Blender install.
 *
 * Blender is an OPTIONAL dependency. A published npm package cannot assume it
 * exists, so every path here either finds a real executable or refuses by name
 * with instructions — never a silent no-op that leaves a mesh unchanged while
 * reporting success.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetPipelineError } from './errors.js';
import { registerOwnedProcessTerminator, type OwnedProcessSignal } from './process-lifecycle.js';

/** Where Blender actually lives on each platform, in preference order. */
const CANDIDATE_PATHS: readonly string[] = [
  // macOS ships an .app bundle whose binary is NOT on PATH by default, which
  // is why PATH-only discovery reports "not installed" on a machine that has it.
  '/Applications/Blender.app/Contents/MacOS/Blender',
  '/usr/local/bin/blender',
  '/usr/bin/blender',
  '/snap/bin/blender',
  'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
];

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Scan PATH for a bare `blender` executable. */
function fromSearchPath(): string | undefined {
  const raw = process.env.PATH;
  if (!raw) return undefined;
  const exeNames = process.platform === 'win32' ? ['blender.exe'] : ['blender'];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Find Blender, honouring an explicit override first.
 *
 * `BLENDER_PATH` wins because a user with several installs (or a portable
 * build) must be able to say which one, and guessing wrong is worse than asking.
 */
export function findBlender(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.BLENDER_PATH?.trim();
  if (override) return isExecutable(override) ? override : undefined;
  const onPath = fromSearchPath();
  if (onPath) return onPath;
  return CANDIDATE_PATHS.find((candidate) => isExecutable(candidate));
}

export function requireBlender(env: NodeJS.ProcessEnv = process.env): string {
  const found = findBlender(env);
  if (found) return found;
  throw new AssetPipelineError(
    'CONFIG_MISSING',
    'Blender was not found. This tool needs a local Blender install (4.x or newer). ' +
      'Install it from https://www.blender.org/download/, or set BLENDER_PATH to the executable — ' +
      'on macOS that is /Applications/Blender.app/Contents/MacOS/Blender, which is deliberately ' +
      'not on PATH. Every other non-Blender operation in this harness works without Blender.',
    { details: { checked: ['BLENDER_PATH', 'PATH', ...CANDIDATE_PATHS] } },
  );
}

/** Absolute path to a script shipped inside this package. */
export function packagedScript(name: string): string {
  // dist/util/blender.js -> package root is two levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'scripts', name),
    path.resolve(here, '..', '..', '..', 'scripts', name),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new AssetPipelineError('INVALID_STATE', `packaged script ${name} is missing`, {
      details: { candidates },
    });
  }
  return found;
}

export interface BlenderRunResult {
  receipt: Record<string, unknown>;
  stderrTail: string;
  exitCode: number;
  /** True when Blender's stdout exceeded the capture cap and was truncated. */
  stdoutTruncated: boolean;
}

const RECEIPT_PREFIX = 'NORMALIZE_RECEIPT=';
const MAX_CAPTURE_BYTES = 4 << 20;
const MAX_RECEIPT_LINE_BYTES = 256 << 10;

function safeBlenderEnvironment(isolatedHome: string): NodeJS.ProcessEnv {
  const allowed = [
    'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'DEVELOPER_DIR', 'SDKROOT',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const systemSearchPaths = process.platform === 'win32'
    ? [path.dirname(process.execPath), `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`]
    : [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const temporary = path.join(isolatedHome, 'tmp');
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  environment.PATH = [...new Set(systemSearchPaths)].join(path.delimiter);
  environment.HOME = isolatedHome;
  environment.TMPDIR = temporary;
  if (process.platform === 'win32') {
    environment.USERPROFILE = isolatedHome;
    environment.TEMP = temporary;
    environment.TMP = temporary;
    if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) environment.WINDIR = process.env.WINDIR;
  }
  return environment;
}

/**
 * Run a packaged Blender script with a JSON option blob.
 *
 * Arguments go through argv, never a shell, so nothing in `options` can be
 * interpreted as a command. `--factory-startup` keeps a user's add-ons and
 * preferences from changing the result.
 */
export async function runBlenderScript(
  scriptPath: string,
  options: Record<string, unknown>,
  settings: { timeoutMs: number; blenderPath?: string },
): Promise<BlenderRunResult> {
  const executable = settings.blenderPath ?? requireBlender();
  const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'game-dev-blender-'));

  return new Promise<BlenderRunResult>((resolve, reject) => {
    // detached puts the child in its OWN process group, so the timeout can kill
    // the whole tree. BLENDER_PATH is a supported override and is routinely a
    // wrapper — xvfb-run, flatpak run, snap run are the normal ways to run
    // headless Blender — so the process we spawn is often not the process doing
    // the work. Signalling only the direct child left descendants running.
    const child = spawn(
      executable,
      [
        '--background',
        '--factory-startup',
        '--python',
        scriptPath,
        '--',
        JSON.stringify(options),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: safeBlenderEnvironment(isolatedHome) },
    );

    let stderr = '';
    let lastReceiptLine: string | undefined;
    let stdoutTruncated = false;
    let killedForTimeout = false;
    let receiptLineTooLong = false;
    let externallyStopping = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const killTree = (signal: OwnedProcessSignal = 'SIGKILL'): void => {
      // Negative pid targets the group. Falling back to the child alone matters
      // where process groups are unavailable; either way we must not throw out
      // of a timer.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process is already gone.
        }
      }
    };
    const unregisterOwnedProcess = registerOwnedProcessTerminator((signal) => {
      if (signal === 'SIGTERM') externallyStopping = true;
      killTree(signal);
    });

    const timer = setTimeout(() => {
      killedForTimeout = true;
      killTree();
    }, settings.timeoutMs);

    // Receipt lines are scanned from EVERY chunk, independently of the capture
    // cap. The cap silently dropped everything past 4 MiB — including the real
    // receipt, which the script prints last — so a forged line near byte 0
    // survived and became "the last matching line". Blender echoes glTF mesh
    // names to stdout, so a mesh named "X\nNORMALIZE_RECEIPT={...}" plus 6 MiB
    // of padding dictated every non-measured field in the response, including
    // the Blender version it claimed to be running.
    let pendingLine = '';
    let discardingOversizedNoiseLine = false;
    const scanForReceipt = (incoming: string): void => {
      let text = incoming;
      if (discardingOversizedNoiseLine) {
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        discardingOversizedNoiseLine = false;
        text = text.slice(newline + 1);
      }
      const combined = pendingLine + text;
      const lines = combined.split('\n');
      pendingLine = lines.pop() ?? '';
      if (Buffer.byteLength(pendingLine, 'utf8') > MAX_RECEIPT_LINE_BYTES) {
        if (pendingLine.startsWith(RECEIPT_PREFIX)) {
          receiptLineTooLong = true;
          pendingLine = '';
          killTree();
          return;
        }
        // Blender and wrappers can emit long progress/noise lines. Drop those
        // incrementally rather than retaining them, while continuing to scan
        // subsequent complete lines for the final receipt.
        pendingLine = '';
        discardingOversizedNoiseLine = true;
      }
      for (const entry of lines) {
        if (!entry.startsWith(RECEIPT_PREFIX)) continue;
        if (Buffer.byteLength(entry, 'utf8') > MAX_RECEIPT_LINE_BYTES) {
          receiptLineTooLong = true;
          killTree();
          return;
        }
        lastReceiptLine = entry;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      scanForReceipt(text);
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - stdoutBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        stdoutBytes += retained.length;
      }
      if (chunk.length > remaining) stdoutTruncated = true;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - stderrBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        stderr += retained.toString('utf8');
        stderrBytes += retained.length;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      unregisterOwnedProcess();
      reject(
        new AssetPipelineError('INVALID_STATE', `could not start Blender: ${err.message}`, {
          cause: err,
        }),
      );
    });

    // 'exit' rather than 'close': close waits for every holder of the pipes,
    // so one surviving descendant kept this pending for 45s against a 10s
    // timeout while the error claimed the process "was terminated". A short
    // grace period still lets buffered output arrive.
    child.on('exit', (code) => {
      clearTimeout(timer);
      setTimeout(() => finish(code), 25);
    });

    const finish = (code: number | null): void => {
      // The wrapper/group leader may exit on SIGTERM while a Blender descendant
      // ignores it.  Preserve the CLI-wide cancellation guarantee by escalating
      // the group before removing this process from the ownership registry.
      if (externallyStopping) killTree('SIGKILL');
      unregisterOwnedProcess();
      const stderrTail = stderr.split('\n').slice(-40).join('\n');

      if (killedForTimeout) {
        reject(
          new AssetPipelineError(
            'TIMEOUT',
            `Blender exceeded ${settings.timeoutMs}ms; its process group was sent SIGKILL`,
            { retryable: true, details: { stderrTail } },
          ),
        );
        return;
      }

      if (receiptLineTooLong) {
        reject(
          new AssetPipelineError(
            'INSPECTION_FAILED',
            `Blender emitted a receipt line larger than ${MAX_RECEIPT_LINE_BYTES} bytes`,
            { details: { stderrTail } },
          ),
        );
        return;
      }

      // The LAST matching line, matching what the script promises: it prints the
      // receipt as its final line. Taking the FIRST let the INPUT FILE forge it
      // — Blender echoes mesh names to stdout, so a mesh named
      // "MESH\nNORMALIZE_RECEIPT={...}" injected a complete receipt that was
      // reported as fact. Every non-measured field became attacker-controlled.
      // Flush whatever the last chunk left unterminated, then take the last
      // receipt seen across the WHOLE stream, not the captured prefix of it.
      if (pendingLine.startsWith(RECEIPT_PREFIX)) lastReceiptLine = pendingLine;
      const line = lastReceiptLine;
      // A non-zero exit is a failure even WITH a receipt. finish() checked only
      // for the receipt's presence, so a Blender exiting 3 that had printed one
      // was reported as a clean success.
      // `code === null` means the child was killed by a SIGNAL. Exempting it
      // reported an OOM-killed or segfaulting Blender as a clean success, with
      // exitCode 0, provided a receipt had already been printed.
      if (code !== 0) {
        reject(
          new AssetPipelineError(
            'INSPECTION_FAILED',
            code === null ? 'Blender was killed by a signal' : `Blender exited ${code}`,
            { details: { exitCode: code, killedBySignal: code === null, stderrTail } },
          ),
        );
        return;
      }
      if (!line) {
        // A zero exit without a receipt means the script did not reach its end.
        // Reporting success here would claim a normalisation that never ran.
        reject(
          new AssetPipelineError(
            'INSPECTION_FAILED',
            `Blender exited ${code ?? 'unknown'} without emitting a normalisation receipt`,
            { details: { exitCode: code, stderrTail } },
          ),
        );
        return;
      }

      try {
        const parsed: unknown = JSON.parse(line.slice(RECEIPT_PREFIX.length));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          // `NORMALIZE_RECEIPT=null` parsed fine and then threw a raw TypeError
          // in the caller — AFTER the staged file had been renamed into place.
          throw new Error('receipt is not a JSON object');
        }
        resolve({
          receipt: parsed as Record<string, unknown>,
          stdoutTruncated,
          stderrTail,
          exitCode: code ?? 0,
        });
      } catch (err) {
        reject(
          new AssetPipelineError('INSPECTION_FAILED', 'Blender emitted an unparseable receipt', {
            cause: err,
            details: { stderrTail },
          }),
        );
      }
    };
  }).finally(() => {
    rmSync(isolatedHome, { recursive: true, force: true });
  });
}
