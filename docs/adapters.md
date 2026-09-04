# Capture adapters

A capture adapter lets a game own its executable and evidence-production
details while Game Development Studio owns planning, authorization, process
containment, normalization, sealing, and analysis.

The default project path is:

```text
<game>/.game-dev/adapter.json
```

Adapter installation is dry-run-first and writes only that manifest. It does
not execute the project.

## Minimal manifest

```json
{
  "schema": "game_dev.adapter.v1",
  "id": "sample-game",
  "name": "Sample Game",
  "version": "1.0.0",
  "scenarios": [
    {
      "id": "capture-reference",
      "title": "Capture reference frame",
      "command": {
        "executable": "tools/capture.sh",
        "arguments": [
          "--scene",
          "{param.scene}",
          "--output",
          "{run_dir}/staging"
        ],
        "workingDirectory": "."
      },
      "timeoutSeconds": 300,
      "capabilities": ["project-write", "gpu"],
      "parameters": {
        "scene": {
          "type": "string",
          "required": true,
          "description": "Stable scene identifier"
        }
      },
      "outputs": {
        "format": "game-dev-capture-v1",
        "path": "staging"
      }
    }
  ]
}
```

Executables, working directories, and output paths are project-relative. The
loader refuses absolute paths, traversal, symlink escapes, unknown fields,
duplicate scenario IDs, undeclared placeholders, and commands outside the
project.

## Capabilities

Each scenario declares one or more:

- `cpu`
- `project-write`
- `gpu`
- `performance`
- a graphics lane: `metal`, `vulkan`, `webgpu`, or `opengl`
- `software-raster`

`--confirm` authorizes execution. GPU scenarios additionally need
`--allow-gpu`; performance scenarios additionally need
`--allow-performance`. A graphics lane describes which API is requested and
does not weaken either gate.

`software-raster` runs on the CPU authorization path and deliberately does NOT
require `--allow-gpu`: demanding GPU authority for lavapipe would train users to
grant it for runs that never touch a GPU.

## Renderer class and the software lane

`adapterEvidence.rendererClass` is `hardware`, `software`, or `unknown`
(the default — "unknown" is truthful where "hardware" would be a claim nobody
made).

When it is `software`, the harness **overwrites** the adapter's GPU and
hardware-timing claims rather than recording them: `adapterReportedGpuExecution`,
`adapterReportedGpuCompletionIdentity` and `hardwarePerformanceEvidenceAdmitted`
are all forced false, `softwareRasterizedLane` is set, and the run's evidence
ceiling says the timings are inadmissible. This is not a lint. An adapter that
declared a software renderer and claimed GPU execution anyway cannot make that
claim stick.

What the lane is genuinely good for is the reason to keep it: a CPU rasterizer
is bit-deterministic where a real GPU is not, so `visual compare --threshold 0`
becomes a usable hard gate in CI.

## Declared graphics environment

A scenario may set graphics environment variables for its own process:

```json
"environment": {
  "VK_ICD_FILENAMES": "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json",
  "LIBGL_ALWAYS_SOFTWARE": "1"
}
```

Only a hardcoded allowlist is accepted: the Vulkan ICD/layer variables, the
Mesa and EGL selectors, the Metal capture and validation switches, the wgpu
backend selector, `DRI_PRIME`, and `RUST_BACKTRACE`. Anything else is refused
when the manifest loads.

The inherited environment is deliberately NOT widened to cover these. Inheriting
them would make a run's meaning depend on the shell that launched it, which
contradicts the determinism the sealed-bundle model rests on. Declared values
land in the plan and therefore in the sealed run, where they are reviewable and
reproducible.

`LD_*` and `DYLD_*` are absent from the allowlist on purpose. They are
loader-injection vectors, and a capture harness that let a manifest set them
would be a code-execution primitive wearing a configuration hat. `DISPLAY` and
`WAYLAND_DISPLAY` are absent because surfaceless rendering is the point. The
`GAME_DEV_*` contract variables are absent because a manifest that could set
`GAME_DEV_RUN_DIR` could aim the capture write anywhere.

## Parameters

Parameters are declared and typed. Supported forms include strings, booleans,
finite numbers, enums, and project-relative paths with optional existence and
file/directory requirements. The planner rejects missing required values,
unknown values, path escapes, and mismatched types before execution.

Only these templates are expanded:

- `{run_dir}`: the new harness-owned run directory
- `{run_id}`: the generated run identifier
- `{project_root}`: the validated project root
- `{param.name}`: a declared, validated parameter

No shell interpolation is used. The executable and argument array are passed
directly to the child process.

## What the harness tells the process

The child process inherits a narrow fixed set (`PATH`, `HOME`, `TMPDIR`,
`LANG`, `LC_ALL`, `DEVELOPER_DIR`, `SDKROOT`, `TERM`), any declared graphics
environment, and these injected variables — the actual contract surface:

- `GAME_DEV_RUN_ID` — the run identifier
- `GAME_DEV_RUN_DIR` — the harness-owned directory to write into
- `GAME_DEV_ADAPTER_ID`, `GAME_DEV_SCENARIO_ID`
- `GAME_DEV_CAPTURE_MANIFEST` — the absolute path the harness will read the
  capture manifest from, present when the scenario declares an output path

The last one exists because an engine otherwise has to guess, and both shapes
occur in practice: some capture runners write `capture.json` at the run root,
the Genome format writes it under `native/`. Reading the variable removes a
whole class of "the harness cannot find my capture" failure. It is additive —
a runner that ignores it behaves exactly as before.

Injected names are applied after the declared environment, so a manifest cannot
redirect them.

## Generic capture output

For `game-dev-capture-v1`, the adapter writes a capture manifest and every
referenced attachment under its declared staging directory. The capture
manifest can contain:

- frames with color, albedo, depth, normal, object-ID, material-ID, motion,
  overdraw, wireframe, UV-checker, mipmap-level, stencil, shader-complexity,
  light-complexity, or custom attachments

  The less obvious ones earn their place by discriminating a failure class
  nothing else does. `wireframe` bisects "the geometry is wrong" from "the
  shading is wrong": correct silhouettes over a black colour buffer means the
  mesh and transforms are fine. `uv_checker` exposes flipped or mirrored UVs,
  wrong tiling and inconsistent texel density, all invisible in a normal render.
  `shader_complexity` and `light_complexity` are engine-authored heuristics, so
  their `description` must state the cost model.

  There is deliberately no `histogram` kind: a histogram is a statistic derived
  from the colour buffer rather than a distinct render output, and accepting one
  would let an engine report a histogram that disagrees with its own pixels.
- JSON or JSONL telemetry
- profile files
- numeric measurements with metric, value, unit, frame index, and aggregation
- adapter evidence flags and explanatory notes

Attachment encodings are PNG, JSON, JSONL, or binary. Paths must be relative,
unique, non-symlinked, present, and inside staging. Limits bound frame,
attachment, telemetry, profile, measurement, log, and file sizes.

## Genome compatibility format

`genome-hemera-v1` normalizes the existing Genome Hemera evidence roster into
the same generic run-bundle contract. Shipping the template does not install it
into Genome and does not grant permission to run Genome's owner-gated GPU lane.

The adapter's own receipts determine whether GPU-completion identity or
hardware-performance evidence is admissible. The generic harness always records
that it cannot prove those properties by itself.

## Sealed run bundle

After process exit, the harness copies admitted artifacts into a new run
directory, removes unsafe entries, writes normalized stdout/stderr, computes
SHA-256 for every artifact, and writes `run.json` last.

A run manifest binds:

- adapter ID, version, and manifest hash
- scenario, project root, timestamps, duration, status, and process result
- normalized capture manifest
- the closed artifact roster and hashes
- evidence booleans and a human-readable evidence ceiling

`game-dev capture verify` rejects missing, extra, modified, or unsafe files.
Analysis commands verify before reading.

## Recommended integration sequence

1. Add a deterministic validation-only scenario.
2. Add a CPU or preflight scenario that produces no capture.
3. Add one bounded diagnostic capture with stable scene, camera, seed, tick, and
   resolution.
4. Add semantic attachments that answer likely failure classes.
5. Add a full acceptance matrix only after the bounded lane is reproducible.
6. Add performance samples only when the target-hardware contract and quiet-host
   requirements are explicit.

Keep the game harness responsible for engine-specific truth. Keep the adapter
small, declarative, and reviewable.
