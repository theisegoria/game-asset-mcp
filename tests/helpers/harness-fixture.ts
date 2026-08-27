import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePNG } from '../../src/inspection/image.js';
import { canonicalJson } from '../../src/packages/format.js';
import { GAME_DEV_ADAPTER_SCHEMA } from '../../src/harness/contracts.js';

function raster(red: number, green: number, blue: number): Uint8Array {
  const data = new Uint8Array(4 * 4 * 4);
  for (let pixel = 0; pixel < 16; pixel += 1) {
    const offset = pixel * 4;
    data[offset] = red + (pixel >= 8 ? 8 : 0);
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = 255;
  }
  return encodePNG({ width: 4, height: 4, data });
}

function objectIds(): Uint8Array {
  const data = new Uint8Array(4 * 4 * 4);
  for (let pixel = 0; pixel < 16; pixel += 1) {
    const offset = pixel * 4;
    data[offset + 2] = pixel < 8 ? 1 : 2;
    data[offset + 3] = 255;
  }
  return encodePNG({ width: 4, height: 4, data });
}

const runner = `#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';

const [source, objectIds, frameTimeRaw, mode = 'normal'] = process.argv.slice(2);
const runDir = process.env.GAME_DEV_RUN_DIR;
const runId = process.env.GAME_DEV_RUN_ID;
const adapterId = process.env.GAME_DEV_ADAPTER_ID;
const scenarioId = process.env.GAME_DEV_SCENARIO_ID;
if (!source || !objectIds || !frameTimeRaw || !runDir || !runId || !adapterId || !scenarioId) {
  throw new Error('fixture runner is missing its declared inputs');
}
const frameTime = Number(frameTimeRaw);
await fs.mkdir(path.join(runDir, 'captures'));
await fs.copyFile(source, path.join(runDir, 'captures', 'color.png'));
await fs.copyFile(objectIds, path.join(runDir, 'captures', 'objects.png'));
await fs.writeFile(path.join(runDir, 'telemetry.jsonl'), [
  JSON.stringify({
    schema: 'game_dev.telemetry_event.v1', runId, sequence: 0, timestampNs: '1',
    category: 'performance', name: 'frame_time', value: frameTime, unit: 'ms', attributes: {},
  }),
  JSON.stringify({
    schema: 'game_dev.telemetry_event.v1', runId, sequence: 1, timestampNs: '2',
    category: 'diagnostic', name: 'visible_instances', value: 2, unit: 'count', attributes: { source: 'fixture' },
  }),
].join('\\n') + '\\n');
await fs.writeFile(path.join(runDir, 'profile.json'), JSON.stringify({ renderer: { gpu_frame_ns: frameTime * 1000000 } }));
await fs.writeFile(path.join(runDir, 'capture.json'), JSON.stringify({
  schema: 'game_dev.capture.v1', runId, adapterId, scenarioId, sourceFormat: 'game-dev-capture-v1',
  frames: [{ index: 0, label: 'main', attachments: [
    { kind: 'color', path: 'captures/color.png', encoding: 'png' },
    { kind: 'object_id', path: 'captures/objects.png', encoding: 'png' },
  ] }],
  telemetry: ['telemetry.jsonl'], profiles: ['profile.json'],
  measurements: [{ metric: 'render.frame_time', value: frameTime, unit: 'ms', aggregation: 'sample' }],
  adapterEvidence: {
    windowless: true, graphicsApi: 'fixture', gpuExecutionReported: false,
    gpuCompletionIdentityReported: false, hardwarePerformanceReported: false,
    pixelVisualInspectionPerformed: false, notes: ['synthetic test fixture'],
  },
}));
if (mode === 'symlink') await fs.symlink('/etc/passwd', path.join(runDir, 'unsafe-link'));
console.log(JSON.stringify({ runId, frameTime, mode }));
`;

export async function writeHarnessProject(root: string): Promise<{
  projectRoot: string;
  baselinePng: string;
  candidatePng: string;
  objectIdPng: string;
}> {
  const projectRoot = path.join(root, 'game');
  await mkdir(path.join(projectRoot, '.game-dev'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src'));
  await writeFile(path.join(projectRoot, 'src', 'renderer.cpp'), '// bounded optimization fixture\n');
  const executable = path.join(projectRoot, 'capture-runner.mjs');
  await writeFile(executable, runner);
  await chmod(executable, 0o755);
  const baselinePng = path.join(projectRoot, 'baseline.png');
  const candidatePng = path.join(projectRoot, 'candidate.png');
  const objectIdPng = path.join(projectRoot, 'objects.png');
  await writeFile(baselinePng, raster(24, 48, 72));
  await writeFile(candidatePng, raster(36, 48, 72));
  await writeFile(objectIdPng, objectIds());

  const scenario = (id: string, capabilities: string[]) => ({
    id,
    title: id === 'capture' ? 'Synthetic capture' : 'Synthetic GPU capture',
    command: {
      executable: 'capture-runner.mjs',
      arguments: ['{param.source}', '{param.objectIds}', '{param.frameTime}', '{param.mode}'],
      workingDirectory: '.',
    },
    timeoutSeconds: 20,
    capabilities,
    parameters: {
      source: { type: 'project_path', required: true, mustExist: true, kind: 'file' },
      objectIds: { type: 'project_path', required: true, mustExist: true, kind: 'file' },
      frameTime: { type: 'integer', required: true, minimum: 1, maximum: 1000 },
      mode: { type: 'enum', required: false, default: 'normal', values: ['normal', 'symlink'] },
    },
    outputs: { format: 'game-dev-capture-v1', path: 'capture.json' },
  });
  await writeFile(path.join(projectRoot, '.game-dev', 'adapter.json'), canonicalJson({
    schema: GAME_DEV_ADAPTER_SCHEMA,
    id: 'fixture-game',
    name: 'Fixture Game',
    version: '1.0.0',
    scenarios: [
      scenario('capture', ['cpu', 'project-write']),
      scenario('gpu-capture', ['project-write', 'gpu', 'metal']),
    ],
  }));
  return { projectRoot, baselinePng, candidatePng, objectIdPng };
}
