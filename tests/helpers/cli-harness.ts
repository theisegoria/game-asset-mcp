import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const builtCLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export interface CLICommandResult {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  payload: Record<string, unknown>;
  stderr: string;
}

export async function callCLICommand(options: {
  name: string;
  args: Record<string, unknown>;
  outputDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<CLICommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        builtCLI,
        'tool',
        'call',
        options.name,
        '--input',
        JSON.stringify(options.args),
        '--output-dir',
        options.outputDir,
        '--json',
      ],
      {
        cwd: options.cwd,
        env: { ...process.env, ASSET_LOG_LEVEL: 'error', ...options.env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let envelope: unknown;
        try {
          envelope = JSON.parse(stdout);
        } catch (parseError) {
          reject(new Error(
            `game-dev returned non-JSON (exit=${String(error?.code)}): ${stdout}\n${stderr}`,
            { cause: parseError },
          ));
          return;
        }
        if (!envelope || typeof envelope !== 'object') {
          reject(new Error('game-dev returned a non-object result'));
          return;
        }
        const record = envelope as Record<string, unknown>;
        const ok = record.ok === true;
        const payload = (ok ? record.data : record.error) as Record<string, unknown>;
        const text = JSON.stringify(payload, null, 2);
        resolve({
          ...(ok ? {} : { isError: true }),
          content: [{ type: 'text', text }],
          payload,
          stderr,
        });
      },
    );
  });
}
