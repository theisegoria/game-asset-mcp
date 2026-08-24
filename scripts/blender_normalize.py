"""Headless Blender mesh normalisation.

Run as:  blender --background --factory-startup --python blender_normalize.py -- <json-options>

This script is FIXED and shipped with the server. Options arrive as one JSON
argument after `--`; nothing from a model or a network response is ever
interpolated into Python source.

It exists because generated and marketplace meshes routinely arrive in a state
no renderer will accept: no UVs (so they cannot be textured at all), degenerate
triangles, unnamed materials, blend modes that make an opaque object
transparent. Fixing those by hand is the step that stalls an asset pipeline.

The final line of stdout is a JSON receipt prefixed with NORMALIZE_RECEIPT= so
the caller can parse it without guessing which of Blender's chatter is ours.
"""

import json
import os
import sys

import bpy  # provided by Blender


def log(message):
    """Progress goes to stderr; stdout carries only the receipt."""
    print(f"[normalize] {message}", file=sys.stderr)


def parse_options():
    if "--" not in sys.argv:
        raise SystemExit("expected options JSON after --")
    payload = sys.argv[sys.argv.index("--") + 1]
    return json.loads(payload)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_mesh(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        # Blender 4.x replaced the legacy importer; prefer the new one and fall
        # back so this works across versions.
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.obj(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            bpy.ops.wm.stl_import(filepath=path)
        else:
            bpy.ops.import_scene.stl(filepath=path)
    else:
        raise SystemExit(f"unsupported input extension: {ext}")


def mesh_objects():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def count_triangles():
    total = 0
    for obj in mesh_objects():
        mesh = obj.data
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
    return total


def has_uvs(obj):
    return len(obj.data.uv_layers) > 0


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def clean_geometry(obj, merge_distance):
    """Weld coincident vertices and dissolve zero-area faces."""
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.mesh.remove_doubles(threshold=merge_distance)
    except AttributeError:
        bpy.ops.mesh.merge(type="BY_DISTANCE")
    bpy.ops.mesh.dissolve_degenerate()
    # Recalculate outward so a flipped island does not read as a hole.
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def unwrap(obj, angle_limit_degrees, island_margin):
    """Smart-project UVs. Only ever called when the object has none."""
    select_only(obj)
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    import math

    bpy.ops.uv.smart_project(
        angle_limit=math.radians(angle_limit_degrees),
        island_margin=island_margin,
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def decimate(obj, ratio):
    modifier = obj.modifiers.new(name="normalize_decimate", type="DECIMATE")
    modifier.ratio = ratio
    select_only(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def normalize_materials(obj, stem):
    """Give every slot a non-empty, stable name and an opaque blend mode.

    An unnamed material is a hard refusal in several downstream mesh gates, and
    a stray BLEND mode makes a solid object render see-through.
    """
    renamed = 0
    forced_opaque = 0
    for index, slot in enumerate(obj.material_slots):
        material = slot.material
        if material is None:
            material = bpy.data.materials.new(name=f"{stem}_material_{index}")
            slot.material = material
            renamed += 1
        elif not material.name or material.name.startswith("Material."):
            material.name = f"{stem}_material_{index}"
            renamed += 1
        # `blend_method` was removed from the material in Blender 4.2+ EEVEE
        # Next; guard so this works on both.
        if hasattr(material, "blend_method") and material.blend_method != "OPAQUE":
            material.blend_method = "OPAQUE"
            forced_opaque += 1
    if not obj.material_slots:
        material = bpy.data.materials.new(name=f"{stem}_material_0")
        obj.data.materials.append(material)
        renamed += 1
    return renamed, forced_opaque


def main():
    options = parse_options()
    source = options["input"]
    target = options["output"]
    stem = os.path.splitext(os.path.basename(target))[0]

    reset_scene()
    log(f"importing {source}")
    import_mesh(source)

    objects = mesh_objects()
    if not objects:
        raise SystemExit("import produced no mesh objects")

    before_triangles = count_triangles()
    before_missing_uvs = sum(0 if has_uvs(obj) else 1 for obj in objects)

    unwrapped = 0
    cleaned = 0
    renamed_total = 0
    opaque_total = 0

    for obj in objects:
        if options.get("cleanGeometry", True):
            clean_geometry(obj, float(options.get("mergeDistance", 0.0001)))
            cleaned += 1
        # Only unwrap what is actually missing UVs: re-unwrapping an authored
        # layout would silently destroy an artist's work.
        if options.get("unwrapMissingUVs", True) and not has_uvs(obj):
            unwrap(
                obj,
                float(options.get("angleLimitDegrees", 66.0)),
                float(options.get("islandMargin", 0.002)),
            )
            unwrapped += 1
        if options.get("normalizeMaterials", True):
            renamed, opaque = normalize_materials(obj, stem)
            renamed_total += renamed
            opaque_total += opaque

    target_triangles = options.get("targetTriangles")
    decimated = 0
    if target_triangles:
        current = count_triangles()
        if current > int(target_triangles):
            ratio = float(target_triangles) / float(current)
            for obj in objects:
                decimate(obj, ratio)
                decimated += 1

    after_triangles = count_triangles()
    after_missing_uvs = sum(0 if has_uvs(obj) else 1 for obj in mesh_objects())

    log(f"exporting {target}")
    bpy.ops.export_scene.gltf(
        filepath=target,
        export_format="GLB",
        export_apply=True,
        export_normals=True,
        export_texcoords=True,
        export_materials="EXPORT",
    )

    receipt = {
        "input": source,
        "output": target,
        "meshObjects": len(objects),
        "trianglesBefore": before_triangles,
        "trianglesAfter": after_triangles,
        "objectsMissingUVsBefore": before_missing_uvs,
        "objectsMissingUVsAfter": after_missing_uvs,
        "objectsUnwrapped": unwrapped,
        "objectsCleaned": cleaned,
        "objectsDecimated": decimated,
        "materialsRenamed": renamed_total,
        "materialsForcedOpaque": opaque_total,
        "blenderVersion": bpy.app.version_string,
    }
    print("NORMALIZE_RECEIPT=" + json.dumps(receipt))


if __name__ == "__main__":
    main()
