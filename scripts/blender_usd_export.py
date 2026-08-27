"""Export a GLB to an intermediate USD scene for deterministic USDZ packaging."""

import json
import os
import sys

import bpy


def options():
    separator = sys.argv.index("--")
    return json.loads(sys.argv[separator + 1])


def main():
    request = options()
    source = os.path.abspath(request["input"])
    output = os.path.abspath(request["output"])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    result = bpy.ops.import_scene.gltf(filepath=source)
    if "FINISHED" not in result:
        raise RuntimeError("Blender did not finish importing the GLB")
    os.makedirs(os.path.dirname(output), exist_ok=True)
    exported = bpy.ops.wm.usd_export(
        filepath=output,
        export_textures=True,
        relative_paths=True,
        evaluation_mode="RENDER",
    )
    if "FINISHED" not in exported or not os.path.isfile(output):
        raise RuntimeError("Blender did not produce the intermediate USD scene")
    print(
        "NORMALIZE_RECEIPT="
        + json.dumps(
            {
                "operation": "export_usd_preview",
                "blenderVersion": bpy.app.version_string,
                "input": source,
                "output": output,
                "bytes": os.path.getsize(output),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
