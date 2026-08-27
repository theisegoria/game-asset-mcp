import { Document, NodeIO } from '@gltf-transform/core';

/** A small, textured-policy-compatible tetrahedron with finite 3D bounds. */
export async function writeGameReadyGlb(filePath: string, scale = 1): Promise<string> {
  const document = new Document();
  document.createBuffer();
  const positions = document.createAccessor('positions').setType('VEC3').setArray(new Float32Array([
    0, 0, 0,
    scale, 0, 0,
    0, scale, 0,
    0, 0, scale,
  ]));
  const normals = document.createAccessor('normals').setType('VEC3').setArray(new Float32Array([
    -0.577, -0.577, -0.577,
    0.904, -0.302, -0.302,
    -0.302, 0.904, -0.302,
    -0.302, -0.302, 0.904,
  ]));
  const uvs = document.createAccessor('uvs').setType('VEC2').setArray(new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ]));
  const indices = document.createAccessor('indices').setType('SCALAR').setArray(new Uint16Array([
    0, 2, 1,
    0, 1, 3,
    1, 2, 3,
    2, 0, 3,
  ]));
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', positions)
    .setAttribute('NORMAL', normals)
    .setAttribute('TEXCOORD_0', uvs)
    .setIndices(indices)
    .setMaterial(document.createMaterial('brass').setBaseColorFactor([0.6, 0.35, 0.1, 1]));
  const mesh = document.createMesh('tetrahedron').addPrimitive(primitive);
  const scene = document.createScene('default').addChild(document.createNode('asset').setMesh(mesh));
  document.getRoot().setDefaultScene(scene);
  await new NodeIO().write(filePath, document);
  return filePath;
}
