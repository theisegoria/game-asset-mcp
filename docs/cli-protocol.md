# CLI protocol

The `game-dev` process is the supported integration boundary for shells,
coding agents, CI, and the native app.

## Output modes

`--json` writes one object to stdout:

```json
{
  "schema": "game_dev.result.v1",
  "operation": "doctor",
  "ok": true,
  "data": {}
}
```

`--jsonl` writes zero or more event objects and one terminal result event,
one compact JSON value per line:

```json
{"schema":"game_dev.event.v1","sequence":1,"type":"progress","operation":"scenario.run","data":{}}
{"schema":"game_dev.event.v1","sequence":2,"type":"result","operation":"scenario.run","data":{"ok":true}}
```

Consumers must:

1. Parse stdout only as the selected protocol.
2. Treat stderr as redacted human diagnostics, not protocol.
3. Read until the terminal result; process exit alone is not the result body.
4. Preserve operation, schema, artifact paths, IDs, and hashes.
5. Reject unknown major schema versions rather than guessing.

Human-readable help and `--version` are the only intentionally non-JSON stdout
paths.

## Result semantics

- `ok: true` means the requested local operation completed under its stated
  evidence ceiling.
- `ok: false` carries a structured error in `data`; callers should not scrape
  message text for control flow.
- An approval boundary is a normal structured refusal. Add only the exact flag
  the user has authorized and invoke again.
- Artifact entries point to local paths and may include a SHA-256 digest.
- A successful planning result does not imply that its proposed write or
  process execution occurred.

The process exits nonzero for terminal errors. Durable job and run records
remain the recovery authority after interruption.

## Input

Commands accept a JSON object from either:

- `--request path/to/request.json`
- `--request -` for stdin
- `--input '{"field":"value"}'` for small, non-secret objects

Do not put credentials in any form of request input. Provider credentials come
from the environment or, in the native app, Keychain.

Relative model, package, adapter, and project paths are resolved at the command
boundary and then validated. Adapter templates use only declared placeholders:
`{run_dir}`, `{run_id}`, `{project_root}`, and
`{param.<declared_name>}`.

## Authorization matrix

| Flag | Authorizes for this invocation |
| --- | --- |
| `--confirm` | the described local write, launch, cancellation, or process |
| `--approve-spend` | contacting a paid provider |
| `--spend-limit-cents N` | refusing before the estimated invocation exceeds N |
| `--allow-gpu` | a scenario whose adapter declares GPU capability |
| `--allow-performance` | a scenario declaring hardware performance capture |
| `--allow-unknown-license` | one vendoring plan's unknown-license blocker |
| `--allow-invalid` | one vendoring plan's failed-validation blocker |

No authorization is persisted or replayed.

## Discovery

Use:

```sh
game-dev --help
game-dev capabilities --json
game-dev doctor --json
game-dev credentials status --json
```

`capabilities.data.localOperations` is the installed request-schema authority
for local tool calls. The versioned help text is the command-route authority.

## Compatibility

The package follows semantic versioning:

- additive fields may appear in a v1 object; consumers should ignore fields
  they do not need
- field removal, meaning changes, or envelope changes require a new schema
  major and package major
- command aliases are not silently repurposed
- persisted manifests declare their own schema independently of CLI version

The `scripts/verify-install.mjs` check creates the npm tarball with scripts
disabled, installs that exact tarball and its runtime dependencies into an
empty temporary consumer, and exercises only the installed copy. It validates
the library export and npm bin, representative free CLI routes, all five skill
copies, the README asset and policy roster, the skills-repository exporter,
and the absence of retired v0.4 MCP/app entry points. It also spawns the
installed MCP server from `/`, completes a handshake, and asserts it advertises
the same tool set as the CLI and writes nothing but JSON-RPC to stdout. It makes
no provider call and does not install into a real user profile.
