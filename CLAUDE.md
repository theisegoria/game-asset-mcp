# Working in this repository

These are the conventions the code actually enforces. Every one of them was
tribal knowledge encoded only in review comments until now, and several of
them were learned by shipping the bug.

## stdout is the protocol

`game-dev --json` emits exactly one `game_dev.result.v1` object; `--jsonl`
emits `game_dev.event.v1` lines; the MCP server emits JSON-RPC. A single stray
`console.log` corrupts every caller. ESLint bans `console` outside
`scripts/**/*.mjs`; diagnostics go to stderr through the logger. The install
verifier spawns the packed MCP server and fails on any non-JSON-RPC byte.

## Every result carries an evidence ceiling

Results include `evidenceCeiling` and an `evidence` object whose
impossible-to-claim fields are `z.literal(false)`:
`hardwareGpuExecutionProvenByHarnessAlone`,
`hardwarePerformanceMeasuredByHarnessAlone`, `humanVisualReviewPerformed`.
A new surface must say what it does not prove. Prose summaries describe
statistics — phrase interpretation as "consistent with", never "because".

## A software renderer is not a GPU

`rendererClass: software` makes the harness **overwrite** the adapter's GPU
and timing claims and record them in `refusedAdapterClaims`. Do not weaken
this. The default is `unknown`, because "unknown" is true where "hardware"
is a claim nobody made.

## Authority cannot come from an argument the caller writes

No tool schema has an approval input. Spending needs a human-written spend
ceiling plus per-call elicitation; execution needs `GAME_DEV_MCP_ALLOW_*`
in the launch environment plus per-call elicitation; writes into a user's
project need `GAME_DEV_MCP_ALLOW_PROJECT_WRITE=1` plus per-call elicitation.
Every non-acceptance path fails closed, and the tests assert the provider was
never contacted and nothing was written. Every gated write has a free
`plan_*` twin. The environment check lives in the handler, because
`game-dev tool call` reaches the same handler.

## Plan, then confirm — and where the line actually is

Writes **outside** the tool's workspace require `--confirm`; `--allow-gpu`
and `--allow-performance` are separate authorities on top. Workspace-local,
content-addressed writes (`package build`, `catalog admit`) take `--dry-run`
instead. Do not add `--confirm` to those: three shipped call sites invoke
them bare.

## No native code in the npm package

Pure-JS codecs exist so `npx` works with no build toolchain. Native source
may live under `probe/`, shipped as text and compiled by the engine's build,
never by npm.

## The CLI surface is byte-compatible

`docs/cli-protocol.md` promises it; five skills reference exact command
strings; the macOS app binds a runtime digest. Change internals freely; do
not change observable envelope shape. Unknown flags are refused — add new
ones to `KNOWN_FLAGS` in `src/cli/arguments.ts` (a test re-derives the set
from accessor call sites and fails on drift).

## Registry names are `^[a-z][a-z0-9_]{1,63}$`

Shared between CLI and MCP via `TOOL_NAME_PATTERN`. Every registered tool
must appear in exactly one of `FREE_TOOLS` or `TOOL_COSTS`; a test fails if
one is unclassified.

## Tests

- No live provider tests, ever (`vitest.config.ts` says why). Stub the
  provider through `contextOverrides`.
- Derive expected values; do not pin literals copied from the thing under
  test. Two tests pinned `1.0.1` and confirmed a stale release record
  instead of catching it.
- Validate against an independent implementation, never against vectors the
  implementation generated. The probe SDK has no golden files for this reason.
- A skip that looks like a pass is how a broken feature ships. CI asserts
  gated suites actually ran.

## Shell discipline

`cmd | tail` reports `tail`'s exit code. Capture the real one
(`set -o pipefail`, or `$?` before piping). This repo committed on a red
`verify` once because of it.

## Git

- This working tree may be shared with another session. Stage explicit paths;
  never `git add -A`. Never force-push a shared branch.
- Version literals live in `package.json`, `src/version.ts`,
  `skills/manifest.json`, `.codex-plugin/plugin.json`, and the macOS
  provenance record. Bump all of them together (`scripts/set-version.mjs`)
  — a parity test fails otherwise.

## The idiom you will see everywhere

`...(value !== undefined ? { value } : {})` — `exactOptionalPropertyTypes`
is on, and an explicit `undefined` is a different value from an absent key.
