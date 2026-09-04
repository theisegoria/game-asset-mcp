# Your first capture

This walks from nothing to a sealed capture your AI can look at, using the
smallest engine in the repository. Ten minutes, no GPU required.

## 1. Install the CLI

```sh
npm install --global @theisegoria/game-development-studio
game-dev doctor --json
```

`doctor` reports what is and is not available on this machine. Nothing below
needs Blender or provider credentials.

## 2. Give your AI the tools

If your AI client can run a shell (Claude Code, a terminal agent), it can call
`game-dev` directly and you are done with this step.

If it cannot (Claude Desktop, Codex, Gemini, most GUI clients), give it the MCP
server. Generate the configuration rather than writing it — the one setting
everyone gets wrong is an absolute output directory, and the generator resolves
it for you:

```sh
game-dev mcp config --client claude-desktop
```

Paste the printed snippet into the file it names and restart the client. Paid
tools stay disabled unless you add `--spend-limit-cents N`; nothing here needs
them.

## 3. Compile the example engine

The probe SDK is two C files your engine compiles in. The example fills a
frame on the CPU — no graphics API at all — which is exactly why it runs
anywhere:

```sh
mkdir -p ~/first-capture && cd ~/first-capture
game-dev probe install --project . --confirm
cp "$(npm root -g)/@theisegoria/game-development-studio/probe/examples/minimal/main.c" .
cc -std=c99 -Wall -Wextra -Werror third_party/gdprobe/gdprobe.c main.c -o engine
./engine
```

`probe install` copies `gdprobe.h` and `gdprobe.c` into `third_party/gdprobe/`
— plan first, write on `--confirm`, and it refuses to overwrite a copy you have
since changed. The example's `#include` expects the header beside it, so adjust
the include path or copy `main.c` into that directory.

Run outside the harness it prints `not attached to the harness; rendering
normally` and exits 0. That is the contract: the same binary renders normally
when nobody is capturing.

## 4. Describe it to the harness

An adapter is a small declarative manifest saying what to run. Create
`.game-dev/adapter.json`:

```json
{
  "schema": "game_dev.adapter.v1",
  "id": "first-capture",
  "name": "First capture",
  "version": "1.0.0",
  "scenarios": [
    {
      "id": "capture",
      "title": "Capture one frame",
      "command": { "executable": "engine", "arguments": ["{param.brightness}"], "workingDirectory": "." },
      "timeoutSeconds": 30,
      "capabilities": ["software-raster", "project-write"],
      "parameters": {
        "brightness": { "type": "integer", "required": false, "default": 0, "minimum": 0, "maximum": 50 }
      },
      "outputs": { "format": "game-dev-capture-v1", "path": "capture.json" }
    }
  ]
}
```

`software-raster` is honest: this engine is a CPU loop, so the harness will
refuse any claim that a GPU drew it. Check the manifest loads:

```sh
game-dev adapter inspect --project . --json
game-dev scenario plan capture --project . --json
```

`plan` resolves exactly what would run and executes nothing. Read it before
running anything — that is what it is for.

## 5. Capture twice, then compare

```sh
game-dev scenario run capture --project . --confirm --json
game-dev scenario run capture --project . --request <(echo '{"brightness":40}') --confirm --json
```

Each run prints a run id. The bundle is sealed: every file hashed into a closed
roster, `run.json` written last. Then:

```sh
game-dev capture verify <run-a> --json
game-dev visual analyze <run-a> --json
game-dev visual compare <run-a> <run-b> --output ./diff --json
game-dev performance summarize <run-a> --warmup-frames 1 --json
```

`visual compare` prints a `verdict`, a prose `summary` — which will tell you
that object `0x000001` changed and `0x000002` did not — and writes heatmaps
into `./diff`. `performance summarize` names the cold-start hitch the example
deliberately emits in frame 0, and excludes it when you ask.

Over MCP the same tools are `run_scenario`, `verify_capture_run`,
`analyze_capture_run`, `compare_capture_visuals` and
`summarize_run_performance`, and the heatmaps and frames come back as images
the model can see. Running a scenario over MCP needs
`GAME_DEV_MCP_ALLOW_EXECUTION=1` in the server's environment plus a
confirmation prompt per run — the model cannot grant that to itself.

## 6. Now your engine

Replace `render` in `main.c` with a readback from your renderer, declare the
backend you actually used, and say how you know the GPU finished:

```c
gdprobe_declare_backend(run, GDPROBE_BACKEND_VULKAN, "RTX 4070", "545.29",
                        GDPROBE_RENDERER_HARDWARE);
gdprobe_attest_gpu(run, GDPROBE_GPU_FENCE_SIGNALLED, "vkWaitForFences");
```

Change `capabilities` to `["gpu", "vulkan", "project-write"]` and pass
`--allow-gpu`. Add object-id and depth attachments so the diff can name what
moved and the analysis can read depth at full precision. `probe/README.md`
covers the rest.

## What you now have

A capture your AI can verify, look at, diff object-by-object, and read timing
from — with every result stating what it does not prove. The next time a
change breaks a render, `visual compare` says which object and roughly how,
and the model can act on that without you describing the screen to it.
