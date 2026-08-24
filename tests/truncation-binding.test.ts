/**
 * A flag no caller can read is not a feature.
 *
 * `stdoutTruncated` was computed correctly in blender.ts and read by exactly
 * one thing: its own unit test. Every tool discarded it. That is this repo's
 * signature defect — built, never bound — and a unit test on the layer that
 * computes it can never catch it, because that layer is right.
 *
 * So this asserts on the JSON a CLIENT receives, using a stub Blender (via the
 * supported BLENDER_PATH override) that emits more than the capture cap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerNormalizeTools } from '../src/tools/normalize.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

let work: string;
let tools: ToolClient;
let previousBlenderPath: string | undefined;

/** A minimal but genuinely valid GLB — the tool inspects what it is handed. */
function minimalGlb(): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2', min: [0, 0], max: [1, 1] },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 24 },
      ],
      buffers: [{ byteLength: 60 }],
    }),
  );
  const jsonPad = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const bin = Buffer.alloc(60);
  new Float32Array(bin.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Float32Array(bin.buffer, 36, 6).set([0, 0, 1, 0, 0, 1]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + bin.length, 8);
  const jsonChunk = Buffer.alloc(8);
  jsonChunk.writeUInt32LE(jsonPad.length, 0);
  jsonChunk.write('JSON', 4);
  const binChunk = Buffer.alloc(8);
  binChunk.writeUInt32LE(bin.length, 0);
  binChunk.write('BIN\0', 4);
  return Buffer.concat([header, jsonChunk, jsonPad, binChunk, bin]);
}

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'truncation-'));
  previousBlenderPath = process.env.BLENDER_PATH;

  // A stub Blender: writes a real GLB to the --output path, floods stdout past
  // the 4 MiB capture cap, and prints the receipt LAST, as the real script does.
  const payload = path.join(work, 'payload.glb');
  await fs.writeFile(payload, minimalGlb());
  const stub = path.join(work, 'blender-stub.sh');
  await fs.writeFile(
    stub,
    `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  case "$prev" in --output) out="$arg";; esac
  prev="$arg"
done
# The real script takes its options as JSON on argv; find the output path there.
if [ -z "$out" ]; then
  out=$(printf '%s\\n' "$@" | tr ',' '\\n' | sed -n 's/.*"output":"\\([^"]*\\)".*/\\1/p' | head -1)
fi
[ -n "$out" ] && cp ${JSON.stringify(payload)} "$out"
awk 'BEGIN{s=sprintf("%1000000s","");for(i=0;i<6;i++)print s}'
echo 'NORMALIZE_RECEIPT={"objectsMissingUVsBefore":0,"objectsMissingUVsAfter":0,"objectsUnwrapped":0,"trianglesBefore":1,"trianglesAfter":1,"blenderVersion":"stub"}'
exit 0
`,
  );
  await fs.chmod(stub, 0o755);
  process.env.BLENDER_PATH = stub;

  tools = await connectTools(registerNormalizeTools, work);
});

afterEach(async () => {
  await tools.close();
  if (previousBlenderPath === undefined) delete process.env.BLENDER_PATH;
  else process.env.BLENDER_PATH = previousBlenderPath;
  await fs.rm(work, { recursive: true, force: true });
});

describe('a truncated Blender run is visible to the caller', () => {
  it('reports stdoutTruncated in the tool response', async () => {
    const source = path.join(work, 'source.glb');
    await fs.writeFile(source, minimalGlb());

    const { isError, payload, text } = await tools.call('normalize_mesh', {
      modelPath: source,
      outputPath: path.join(work, 'out.glb'),
    });

    expect(isError, text).toBe(false);
    // The whole point: not "blender.ts computed it", but "a client can read it".
    expect(payload.stdoutTruncated).toBe(true);
  }, 120_000);
});
