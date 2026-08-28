/**
 * The contract between this server and the Blender subprocess.
 *
 * A mutation sweep reverted five separate fixes here and the suite stayed green
 * on all of them: the receipt could be taken from the FIRST stdout line instead
 * of the last, the non-zero-exit refusal could be deleted, and signal death
 * could be treated as success — none of it observable, because every stub in
 * the suite exited 0 and printed exactly one receipt.
 *
 * These drive `runBlenderScript` against stub executables, so they need no
 * Blender install and run everywhere, including CI.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBlenderScript } from '../src/util/blender.js';

let work: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'blender-protocol-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A stub standing in for Blender. `body` is shell run with the script's argv. */
async function stub(body: string): Promise<string> {
  const file = path.join(work, 'blender-stub.sh');
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}

const RECEIPT = (fields: string) => `echo 'NORMALIZE_RECEIPT={${fields}}'`;

function run(blenderPath: string) {
  return runBlenderScript(path.join(work, 'unused.py'), { input: 'a', output: 'b' }, {
    timeoutMs: 30_000,
    blenderPath,
  });
}

describe('the receipt is the LAST line, not the first', () => {
  it('prefers the final receipt when several are printed', async () => {
    // Blender echoes glTF mesh names to stdout, so a mesh named
    // "X\nNORMALIZE_RECEIPT={...}" prints a forged receipt BEFORE the real one.
    // Taking the first let the input file dictate the response.
    const result = await run(await stub(
      `${RECEIPT('"blenderVersion":"FORGED","trianglesAfter":999999')}\n` +
      `${RECEIPT('"blenderVersion":"REAL","trianglesAfter":12')}\nexit 0`,
    ));

    expect(result.receipt.blenderVersion).toBe('REAL');
    expect(result.receipt.trianglesAfter).toBe(12);
  }, 60_000);

  it('finds the receipt even when it is the last line without a trailing newline', async () => {
    const result = await run(await stub(
      `printf 'noise\\nNORMALIZE_RECEIPT={"blenderVersion":"REAL"}'\nexit 0`,
    ));

    expect(result.receipt.blenderVersion).toBe('REAL');
  }, 60_000);

  it('survives a receipt arriving after megabytes of chatter', async () => {
    // The capture cap silently dropped everything past 4 MiB, INCLUDING the
    // real receipt, so a forged line near byte 0 became "the last one". Receipt
    // scanning is now independent of the cap.
    const result = await run(await stub(
      `${RECEIPT('"blenderVersion":"FORGED"')}\n` +
      `awk 'BEGIN{s=sprintf("%1000000s","");for(i=0;i<6;i++)print s}'\n` +
      `${RECEIPT('"blenderVersion":"REAL"')}\nexit 0`,
    ));

    expect(result.receipt.blenderVersion).toBe('REAL');
    expect(result.stdoutTruncated).toBe(true);
  }, 120_000);
});

describe('a failed Blender is never a success', () => {
  it('refuses a non-zero exit even when a receipt was printed', async () => {
    // The check ran only when the receipt was ABSENT, so a Blender exiting 3
    // that had printed one was reported as a clean success.
    await expect(run(await stub(`${RECEIPT('"blenderVersion":"X"')}\nexit 3`)))
      .rejects.toThrow(/exited 3/);
  }, 60_000);

  it('refuses death by signal, which used to be exempted explicitly', async () => {
    await expect(run(await stub(`${RECEIPT('"blenderVersion":"X"')}\nkill -SEGV $$`)))
      .rejects.toThrow(/killed by a signal/);
  }, 60_000);

  it('refuses a receipt that is not a JSON object', async () => {
    // `NORMALIZE_RECEIPT=null` parsed fine and threw a raw TypeError in the
    // caller — after the staged file had already been renamed into place.
    await expect(run(await stub(`echo 'NORMALIZE_RECEIPT=null'\nexit 0`)))
      .rejects.toThrow(/unparseable receipt|not a JSON object/);
  }, 60_000);

  it('refuses a zero exit with no receipt at all', async () => {
    await expect(run(await stub(`echo 'just chatter'\nexit 0`)))
      .rejects.toThrow(/without emitting a normalisation receipt/);
  }, 60_000);

  it('rejects an oversized newline-free receipt candidate within a fixed bound', async () => {
    await expect(run(await stub(
      `printf 'NORMALIZE_RECEIPT='\n` +
      `awk 'BEGIN { for (i = 0; i < 300000; i++) printf "x" }'\nsleep 30`,
    ))).rejects.toThrow(/receipt line larger than 262144 bytes/);
  }, 60_000);

  it('does not inherit unrelated parent secrets or configuration', async () => {
    const previous = process.env.GAME_DEV_SECRET_SENTINEL;
    process.env.GAME_DEV_SECRET_SENTINEL = 'must-not-reach-blender';
    try {
      const result = await run(await stub(
        `if [ -n "\${GAME_DEV_SECRET_SENTINEL:-}" ]; then\n` +
        `  ${RECEIPT('"leaked":true')}\n` +
        `else\n` +
        `  ${RECEIPT('"leaked":false')}\n` +
        `fi\nexit 0`,
      ));
      expect(result.receipt.leaked).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GAME_DEV_SECRET_SENTINEL;
      else process.env.GAME_DEV_SECRET_SENTINEL = previous;
    }
  }, 60_000);
});
