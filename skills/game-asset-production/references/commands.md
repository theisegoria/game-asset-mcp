# Asset-production commands

Use a dedicated output workspace consistently with `--output-dir PATH`.

## Discover and diagnose

```text
game-dev capabilities --json
game-dev doctor --json
game-dev credentials status --json
```

`capabilities.data.localOperations` is the installed command/schema authority. Do not infer request fields from an older example.

## Provider jobs

```text
game-dev provider tripo generate --request request.json --approve-spend --spend-limit-cents N --jsonl
game-dev provider tripo retexture --request request.json --approve-spend --spend-limit-cents N --jsonl
game-dev provider tripo rig --request request.json --approve-spend --spend-limit-cents N --jsonl
game-dev provider tripo retarget --request request.json --approve-spend --spend-limit-cents N --jsonl
game-dev provider tripo retopologize --request request.json --approve-spend --spend-limit-cents N --jsonl
game-dev provider leonardo image-generate --request request.json --approve-spend --spend-limit-cents N --jsonl
game-dev provider leonardo sound-generate --request request.json --approve-spend --spend-limit-cents N --jsonl
```

Omitting spend flags reaches the structured approval boundary without making the provider call. Creating that durable local job is still a write, so do it only as part of an execution request.

```text
game-dev job show JOB_ID --detail --json
game-dev job follow JOB_ID --max-seconds N --jsonl
game-dev job resume JOB_ID --confirm --approve-spend --spend-limit-cents N --jsonl
game-dev job cancel JOB_ID --confirm --json
```

A retry requires fresh authorization. A local cancelled state does not prove remote cancellation.

## Inspect, normalize, and package

```text
game-dev asset inspect model.glb --json
game-dev asset validate model.glb --request policy.json --json
game-dev asset normalize model.glb --output normalized.glb --request options.json --jsonl
game-dev asset preview-usdz model.glb --output preview.usdz --jsonl
game-dev package build model.glb --name NAME --version VERSION --license SPDX --request metadata.json --jsonl
game-dev package verify PACKAGE_ID_OR_PATH --json
```

Use `game-dev tool call NAME --request request.json` only for an installed local operation not represented by a higher-level command. Prefer the high-level command because its durable receipt and approval behavior are clearer.

Package metadata should bind the original source digest, provider and job identity when applicable, prompts, generation parameters, transformations, license, and validation policy. An optional USDZ file is a preview artifact; the portable GLB remains the canonical game asset.
