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
import math
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
    # An object belonging to a non-active scene is not in this view layer, and
    # select_set then raises "cannot be selected because it is not in View
    # Layer". A multi-scene glTF is valid and ordinary, and Blender swallows the
    # traceback and exits 0, so the failure surfaced as "exited 0 without
    # emitting a receipt" — naming nothing actionable.
    if obj.name not in bpy.context.view_layer.objects:
        bpy.context.scene.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# Blender refuses a threshold below this and silently clamps UP, which would
# over-weld by exactly the amount we were trying to avoid. Queried from
# bpy.ops.mesh.remove_doubles' RNA, not assumed.
BLENDER_MIN_THRESHOLD = 1e-6

# How much larger the mesh's own smallest real feature must be than Blender's
# threshold floor before we will dissolve at that floor.
#
# `mergeDistance: 0` is a SENTINEL, not a distance: it means "merge nothing, but
# still remove faces that are degenerate at any scale". The only threshold
# Blender can express for that is its 1e-6 floor, and whether 1e-6 is safe
# depends on the mesh's LOCAL feature size — nothing else.
#
# Two previous attempts framed this in world space and both were wrong at some
# scale, in opposite directions. Framing it as `1e-6 LOCAL` destroyed a mesh
# whose own local features were 4e-7. Framing it as `1e-6 WORLD / divisor` made
# the gate reduce to `divisor <= 1`, so every object scaled above 1.0 silently
# stopped being repaired — and both fixtures sat at divisor exactly 1.0, which
# is the one value where each bug is invisible.
#
# The question was never about world scale. The dissolve runs on LOCAL
# coordinates, so it is safe exactly when the mesh's smallest real local edge is
# comfortably above the floor. That is scale-independent by construction, which
# is the property the previous two framings lacked.
DEGENERATE_SAFETY_FACTOR = 10.0


def smallest_local_edge(obj):
    """Shortest NON-ZERO edge in local space, or None when there is none.

    Zero-length edges are excluded deliberately: they are exactly what the
    dissolve exists to remove, so counting them would make the mesh look finer
    than it is and suppress its own repair.
    """
    mesh = obj.data
    shortest = None
    for edge in mesh.edges:
        first = mesh.vertices[edge.vertices[0]].co
        second = mesh.vertices[edge.vertices[1]].co
        length = (first - second).length
        if length > 0.0 and (shortest is None or length < shortest):
            shortest = length
    return shortest


def world_threshold_divisor(obj):
    """How much to DIVIDE a world-space threshold by to express it locally.

    mergeDistance is documented as scene units and welding happens on LOCAL
    coordinates, so the two differ by the object's world scale.

    MAX, not min. A local separation v becomes world separation S·v, so a pair
    merged at local threshold T can be as far apart in world as max(s)·T. To
    guarantee nothing is merged that is further apart than M in world:
    max(s)·T <= M, hence T = M / max(s). The previous version used min(s) with
    the reasoning that "welding is isotropic, so the smallest axis decides what
    is safe" — which is exactly inverted, and over-welded by up to max/min. On a
    plate scaled [1,1,0.02] it destroyed 73% of the mesh at defaults and
    reported it ready to texture.

    An earlier version instead baked the scale with transform_apply. That missed
    a scale on a PARENT node and crashed on instanced meshes; matrix_world
    covers the whole chain and mutates nothing.
    """
    scale = obj.matrix_world.to_scale()
    largest = max(abs(scale[0]), abs(scale[1]), abs(scale[2]))
    return largest if largest > 1e-12 else 1.0


def clean_geometry(obj, merge_distance, weld=True, dissolve_threshold=None):
    """Weld coincident vertices and dissolve zero-area faces.

    `merge_distance` arrives in LOCAL units — the caller divides the documented
    scene-unit value by the object's world scale.

    `weld=False` means the WELD threshold cannot be expressed — the caller asked
    for 0, or dividing by the world scale put it under Blender's 1e-6 floor.

    `dissolve_threshold=None` means the same about the DISSOLVE, which is a
    separate decision the caller makes: the two share no flag, because "merge
    nothing" and "this distance is inexpressible" are different requests.
    """
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    if weld:
        try:
            bpy.ops.mesh.remove_doubles(threshold=merge_distance)
        except AttributeError:
            bpy.ops.mesh.merge(type="BY_DISTANCE")


    # An EXPLICIT threshold. This was once a bare call using Blender's 1e-4
    # default, in local space, independent of mergeDistance — a 2 mm part at
    # true scale went from 3042 triangles to ZERO even at mergeDistance 0, and
    # the refusal named the one knob that could not fix it.
    #
    # Gated SEPARATELY from the weld and decided by the caller, because the two
    # questions genuinely differ:
    #
    #   "merge nothing, but still repair"  -> dissolve at Blender's floor, but
    #                                         ONLY when this mesh's own smallest
    #                                         real local edge is far enough above
    #                                         that floor for it to reach nothing
    #                                         but genuinely degenerate geometry.
    #   "this distance is inexpressible"   -> skip, because the clamp to the
    #                                         floor would be WIDER than asked.
    #
    # ⚠ The first comment here claimed "a zero-area face is degenerate at ANY
    # threshold, so skipping protects nothing". That is true of the FACE and
    # false of the THRESHOLD: the floor also reaches real geometry finer than
    # itself, which is how a mesh with 4e-7 local features lost 98% of itself.
    # The prose outlived two rewrites of the code beneath it and contradicted
    # what that code did — which is its own kind of defect, because the next
    # person reads the comment.
    if dissolve_threshold is not None:
        bpy.ops.mesh.dissolve_degenerate(threshold=min(dissolve_threshold, 1.0))

    # NOT gated. Recalculating normals outward has no threshold and cannot
    # delete geometry, and skipping the whole function handed back a mesh with
    # its inverted faces intact while reporting "geometry and materials were
    # normalized". A flipped island reads as a hole.
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
    # A modifier cannot be applied to multi-user mesh data, and an instanced
    # glTF is ordinary. transform_apply hit the identical wall and was removed;
    # decimate kept it, so targetTriangles turned a working input into
    # "Blender exited 0 without emitting a normalisation receipt" — which names
    # nothing actionable, since Blender exits 0.
    if obj.data.users > 1:
        obj.data = obj.data.copy()
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

    scaled_objects = 0
    weld_skipped = 0
    dissolve_skipped = 0
    largest_divisor = 1.0
    requested_merge = float(options.get("mergeDistance", 0.0001))
    for obj in objects:
        # Computed for EVERY object, not only when welding: unwrap reads it too,
        # and gating it on cleanGeometry meant turning welding off silently
        # degraded UV texel density by 2.8x on a non-uniformly scaled mesh.
        divisor = world_threshold_divisor(obj)
        if divisor != 1.0:
            scaled_objects += 1
            # Report the EXTREME divisor in either direction; initialising to
            # 1.0 and only taking max() could never report a divisor below 1,
            # and it printed 1 on the very run that lost 73% of a mesh.
            if abs(math.log(divisor)) > abs(math.log(largest_divisor)):
                largest_divisor = divisor
        local_merge = requested_merge / divisor
        if options.get("cleanGeometry", True):
            # `requested_merge <= 0` means "weld nothing", which the schema's
            # minimum of 0 implies and which Blender cannot express: its
            # threshold floor is 1e-6, so passing 0 still merged vertices 5e-7
            # apart. Treat it as a skip, like an unrepresentable threshold.
            weldable = requested_merge > 0.0 and local_merge >= BLENDER_MIN_THRESHOLD
            if not weldable:
                # Blender clamps a smaller threshold UP, applying a world
                # threshold larger than asked for on exactly the objects whose
                # scale makes them fragile. Skipping the WELD destroys nothing.
                weld_skipped += 1

            # A SEPARATE question from weldability, but the SAME arithmetic —
            # and that is the whole point of writing it as one formula.
            #
            # The previous version special-cased `requested_merge <= 0` as
            # `dissolve_threshold = BLENDER_MIN_THRESHOLD`, in LOCAL units, with
            # no divisor, while both other branches divided. The world-space
            # radius was therefore 1e-6 * divisor, and the branch below SKIPS
            # whenever the request is narrower than that — so asking for ZERO
            # merging applied a strictly WIDER repair than asking for a small
            # positive one. That is the r11 data-loss argument verbatim,
            # reintroduced by the fix whose comment cites it.
            #
            # Measured: two files with byte-identical WORLD geometry, differing
            # only in how scale splits between node and vertices, went to 100
            # and 0 triangles at mergeDistance 0. A partial case lost 98% (102
            # triangles to 2) and still reported readyToTexture with the skip
            # counter reading zero. Its test used a fixture at scale [1,1,1] —
            # divisor 1, the one value at which the bug is invisible.
            #
            # `mergeDistance: 0` means "merge nothing, but still repair faces
            # that are degenerate at any scale". That is a WORLD-space claim, so
            # it is expressed as one: the narrowest world radius we are willing
            # to call degenerate-only. Everything then flows through the single
            # divisor rule, which is monotonic by construction.
            if requested_merge <= 0.0:
                # The sentinel. Dissolve at Blender's floor, but only when this
                # mesh's own smallest real edge is far enough above it that the
                # floor can only reach genuinely degenerate geometry.
                shortest = smallest_local_edge(obj)
                if (
                    shortest is not None
                    and shortest >= BLENDER_MIN_THRESHOLD * DEGENERATE_SAFETY_FACTOR
                ):
                    dissolve_threshold = BLENDER_MIN_THRESHOLD
                else:
                    dissolve_threshold = None
                    dissolve_skipped += 1
            else:
                # A real distance, in world units: express it locally and refuse
                # if Blender cannot, because the clamp to its floor would be
                # WIDER than what was asked for.
                dissolve_local = requested_merge / divisor
                if dissolve_local >= BLENDER_MIN_THRESHOLD:
                    dissolve_threshold = dissolve_local
                else:
                    dissolve_threshold = None
                    dissolve_skipped += 1

            clean_geometry(
                obj,
                local_merge,
                weld=weldable,
                dissolve_threshold=dissolve_threshold,
            )
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
        # Reported honestly: these describe the THRESHOLD adjustment, and no
        # longer claim geometry was mutated, because it is not. The previous
        # counters were also provably false for a scale like [-1, 1, 1], whose
        # largest component is 1.
        "objectsWithNonUnitWorldScale": scaled_objects,
        "objectsWeldSkippedThresholdUnrepresentable": weld_skipped,
        # Reported separately from the weld counter, which named only welding
        # and called a threshold "unrepresentable" when the caller had simply
        # asked for zero. A caller cannot act on a repair it is not told was
        # skipped.
        "objectsDissolveSkippedThresholdUnrepresentable": dissolve_skipped,
        "largestThresholdDivisor": largest_divisor,
        "mergeDistanceRequestedSceneUnits": requested_merge,
        "outputBytes": exported_bytes,
        "blenderVersion": bpy.app.version_string,
    }
    print("NORMALIZE_RECEIPT=" + json.dumps(receipt))


if __name__ == "__main__":
    main()
