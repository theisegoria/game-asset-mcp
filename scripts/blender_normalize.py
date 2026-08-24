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


def apply_object_scale(obj):
    """Bake the object's scale into its vertices, returning the factor applied.

    mergeDistance is documented as "scene units" and was applied to LOCAL vertex
    coordinates, while every size this pipeline reports — boundingBox.sizeMeters
    and the min/max dimension policies — is world space, measured after node
    transforms. On an asset whose node carries a scale, those are different
    units by exactly that factor.

    This is not exotic: the reference mesh committed to this repository has a
    node scale of 100, so the default 0.0001 acted as 1 CENTIMETRE on a 2.2 m
    weapon. Assets authored in centimetres or millimetres and scaled at the node
    are the ordinary output of Blender, Maya and FBX round-trips. Measured at
    defaults, a 0.69 m prop lost 96% of its triangles and was still reported
    ready to texture.

    Baking the scale makes local and world the same units, so the documented
    meaning of mergeDistance becomes the true one. World-space geometry is
    unchanged by this: it moves the same factor from the node to the vertices.
    """
    scale = tuple(obj.scale)
    if abs(scale[0] - 1.0) < 1e-9 and abs(scale[1] - 1.0) < 1e-9 and abs(scale[2] - 1.0) < 1e-9:
        return 1.0
    select_only(obj)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return max(abs(scale[0]), abs(scale[1]), abs(scale[2]))


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

    scales_applied = 0
    largest_scale_applied = 1.0
    for obj in objects:
        if options.get("cleanGeometry", True):
            # Bake the node scale FIRST, so mergeDistance means what the tool
            # documents it to mean — scene units — rather than local units that
            # differ from world by the node's scale factor.
            factor = apply_object_scale(obj)
            if factor != 1.0:
                scales_applied += 1
                largest_scale_applied = max(largest_scale_applied, factor)
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
    # The operator's result was discarded, and a bpy.ops operator returning
    # {'CANCELLED'} does NOT raise — so a failed export printed a healthy
    # receipt and exited 0. Downstream, that became a success carrying the
    # previous file's size and hash. Both the result and the file are checked
    # here, because neither alone is proof.
    export_result = bpy.ops.export_scene.gltf(
        filepath=target,
        export_format="GLB",
        export_apply=True,
        export_normals=True,
        export_texcoords=True,
        export_materials="EXPORT",
    )
    if "FINISHED" not in set(export_result):
        raise RuntimeError(
            f"glTF export did not finish: operator returned {sorted(export_result)}"
        )
    if not os.path.exists(target):
        raise RuntimeError(f"glTF export reported success but {target} does not exist")
    exported_bytes = os.path.getsize(target)
    if exported_bytes == 0:
        raise RuntimeError(f"glTF export reported success but {target} is empty")

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
        "objectScalesApplied": scales_applied,
        "largestScaleApplied": largest_scale_applied,
        "outputBytes": exported_bytes,
        "blenderVersion": bpy.app.version_string,
    }
    print("NORMALIZE_RECEIPT=" + json.dumps(receipt))


if __name__ == "__main__":
    main()
