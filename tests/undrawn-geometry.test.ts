/**
 * The inspector has always counted undrawn geometry, and has reported those
 * counts to callers since they were added to `AssetInspection`. Nothing ever
 * judged them.
 *
 * Two consequences, both silent. A file whose meshes all sit outside the
 * default scene failed as "0 triangles" — the symptom, not the cause, and a
 * user re-exports blindly. And a file that is mostly undrawn passed validation
 * outright, shipping download size and memory for geometry that never appears.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { inspectGltf } from '../src/inspection/gltf.js';
import { evaluateAsset, type PolicyCheck } from '../src/domain/asset-policy.js';

let work: string;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'undrawn-geometry-'));
});

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

function triangle(doc: Document) {
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  return doc.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv);
}

/** Default scene draws one triangle; a second, never-drawn scene holds another. */
async function writeDrawnAndUndrawn(file: string): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const drawn = doc
    .createScene('drawn')
    .addChild(doc.createNode('drawn').setMesh(doc.createMesh('drawn').addPrimitive(triangle(doc))));
  doc
    .createScene('leftover')
    .addChild(doc.createNode('leftover').setMesh(doc.createMesh('leftover').addPrimitive(triangle(doc))));
  doc.getRoot().setDefaultScene(drawn);
  await new NodeIO().write(file, doc);
  return file;
}

/** Default scene holds only a camera; the geometry is offstage. */
async function writeUndrawnOnly(file: string): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  doc
    .createScene('offstage')
    .addChild(doc.createNode('mesh').setMesh(doc.createMesh('mesh').addPrimitive(triangle(doc))));
  doc.getRoot().setDefaultScene(doc.createScene('main').addChild(doc.createNode('camera')));
  await new NodeIO().write(file, doc);
  return file;
}

function check(checks: PolicyCheck[], id: string): PolicyCheck {
  const found = checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} check was emitted`);
  return found;
}

describe('undrawn geometry alongside drawn geometry', () => {
  it('warns, naming the cost, without failing an otherwise valid asset', async () => {
    const inspected = await inspectGltf(await writeDrawnAndUndrawn(path.join(work, 'both.glb')));
    expect(inspected.triangleCount).toBe(1);
    expect(inspected.undrawnTriangleCount).toBe(1);

    const report = evaluateAsset(inspected);
    const undrawn = check(report.checks, 'undrawn_geometry');

    expect(undrawn.severity).toBe('warning');
    expect(undrawn.passed).toBe(false);
    expect(undrawn.actual).toContain('not reachable from the default scene');
    // A warning must not fail the asset — the drawn mesh is fine.
    expect(check(report.checks, 'has_geometry').passed).toBe(true);
  });

  it('carries the inspector prose through to the report', async () => {
    const inspected = await inspectGltf(await writeDrawnAndUndrawn(path.join(work, 'prose.glb')));
    const report = evaluateAsset(inspected);

    expect(report.inspectorWarnings.some((line) => line.includes('not reachable from the default scene')))
      .toBe(true);
  });
});

describe('geometry that exists but is never drawn', () => {
  it('fails has_geometry naming the cause, not the symptom', async () => {
    const inspected = await inspectGltf(await writeUndrawnOnly(path.join(work, 'offstage.glb')));
    expect(inspected.triangleCount).toBe(0);
    expect(inspected.undrawnTriangleCount).toBe(1);

    const report = evaluateAsset(inspected);
    const geometry = check(report.checks, 'has_geometry');

    expect(geometry.passed).toBe(false);
    // The old message was bare "0 triangles", which sent users re-exporting a
    // mesh that was present the whole time.
    expect(geometry.actual).toContain('outside the default scene');
    expect(geometry.consequence).toContain('no scene references it');
  });

  it('does not also raise undrawn_geometry: one cause, one error', async () => {
    const inspected = await inspectGltf(await writeUndrawnOnly(path.join(work, 'single.glb')));
    const report = evaluateAsset(inspected);

    expect(report.checks.some((entry) => entry.id === 'undrawn_geometry')).toBe(false);
  });
});
