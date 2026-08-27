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
- `metal`
- `performance`

`--confirm` authorizes execution. GPU scenarios additionally need
`--allow-gpu`; performance scenarios additionally need
`--allow-performance`. `metal` describes the requested graphics lane but
does not weaken either gate.

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

## Generic capture output

For `game-dev-capture-v1`, the adapter writes a capture manifest and every
referenced attachment under its declared staging directory. The capture
manifest can contain:

- frames with color, depth, normal, object-ID, material-ID, motion, overdraw,
  or custom attachments
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
