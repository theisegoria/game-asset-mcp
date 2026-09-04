# Repository layout and release boundaries

Game Development Studio is one product family with three independently useful
surfaces: a cross-platform CLI/library, five local skills, and a native macOS
companion. This layout keeps their shared contracts visible while giving each
distribution a closed, reviewable roster.

## Source map

| Path | Responsibility | Shipped where |
| --- | --- | --- |
| `src/` | TypeScript CLI, provider adapters, durable jobs, packages, capture harness, inspection, and analysis | npm package and source repository |
| `tests/` | CLI, provider-fixture, package, harness, migration, security, and release-contract tests | source repository only |
| `skills/` | Router plus four focused Codex/ChatGPT skills and their metadata/assets | npm package, skills release, and source repository |
| `adapters/` | Declarative game-specific scenario manifests | npm package and source repository |
| `apps/macos/GameDevelopmentStudio/` | SwiftPM-native macOS 26 app and tests | source repository only; compiled app is released separately |
| `assets/` | Shared icons, screenshot masters, and byte-verifiable provenance | selected product distributions |
| `docs/` | Architecture and machine-readable protocol contracts | npm package and source repository |
| `distribution/skills-repo/` | Reproducible public skills-repository template | source repository; rendered into a separate release repository |
| `distribution/macos-app-repo/` | Exact binary-only macOS repository template | source repository; rendered into a separate release repository |
| `script/` | Native build/run and binary-release orchestration | source repository only |
| `scripts/` | TypeScript build, install verification, skill validation, Blender helpers, and repository export | npm package as explicitly allowlisted and source repository |
| `marketing/` | Maintained listing copy and product-tour sources | source repository; selected copy enters the skills package |

The supported automation boundary is `game-dev` with `game_dev.result.v1` and
`game_dev.event.v1`. The macOS app launches a configured local CLI and validates
its identity and protocol. Its complete bundle embeds a direct Node runtime and
a closed, exact-rostered build of that CLI; it does not embed Blender, provider
services, or the target game.

## Public distributions

### Source and CLI repository

The source repository contains the complete product implementation, tests,
documentation, skills, app source, release templates, and retained history. The
npm `files` allowlist is intentionally narrower: it omits `apps/`, native build
outputs, tests, and repository-only release machinery.

Current releases ship two transports over one registry: the `game-dev` CLI and
an MCP server at `dist/mcp/server.js`, installed as the `game-dev-mcp` bin and
reachable as `game-dev mcp serve`. See `docs/mcp.md`.

The v0.4.0 MCP implementation stays retired and available only through its
historical tag: its module layout, tool surface and bin name all differ, and
shipping it beside the current server would give clients two servers claiming
one package. Releases must therefore continue to reject stale `dist/server.js`,
`.mcp.json`, and `.app.json` payloads. `.mcp.json` in particular is never
shipped -- client configuration is generated per client by
`game-dev mcp config`, because the one setting everybody gets wrong is a
relative `ASSET_OUTPUT_DIR` and only the generator can resolve it.

The Codex plugin and the macOS app repository remain skills-only and
binary-only respectively; neither declares an MCP server.

### Skills repository and archive

The skills repository contains static skill instructions, UI metadata, icons,
screenshots, policy documents, and reproducible validation/build scripts. It
contains no provider credential, native application binary, executable service,
hook, or automatic profile installation. A release ZIP is built only after the
source candidate is committed and tagged, then downloaded and compared with the
locally verified artifact.

### macOS binary repository

The macOS public repository is binary-only. Its Git tree contains documentation,
policy files, notices, the exact screenshot set, checksums, and release metadata;
the compiled app ZIP is attached to the GitHub release. The packaging verifier
rejects Swift/TypeScript source, build manifests, symlinks, executable extras,
unresolved placeholders, unexpected files, mismatched screenshot provenance,
and invalid app metadata or signatures.

Version 1.0.0 is intentionally Apple-silicon-only, ad-hoc signed, and not
notarized. Those trust properties must be disclosed and reverified on the
downloaded artifact; a local compile is not equivalent evidence.

## Generated outputs

These paths are generated and must not become source-controlled release input:

- `dist/` and the TypeScript compiler output beneath it
- `apps/macos/GameDevelopmentStudio/.build/`
- `apps/macos/GameDevelopmentStudio/.swiftpm/`
- `apps/macos/GameDevelopmentStudio/dist/`
- temporary exported skills repositories and macOS staging directories
- local provider workspaces, asset catalogs, jobs, captures, and receipts

Build release artifacts into an isolated temporary directory, validate their
closed roster, and never publish directly from a dirty working tree.

## Verification order

1. Freeze the exact source commit and version.
2. Run the CLI typecheck, lint, tests, install verifier, and publish-roster audit.
3. Run the complete Swift suite and build the native bundle from the frozen
   source path.
4. Launch and inspect the native UI, then capture and hash the runtime screenshot.
5. Build each distribution in isolation and run its dedicated verifier.
6. Publish, download into a fresh directory, and repeat checksum, roster,
   metadata, architecture, and signature checks.
7. Regenerate and persist the codebase graph after the release tree is final.

Each gate proves only its literal scope. Source and tests are not live-provider,
GPU, pixel, target-hardware performance, signing-identity, notarization, or human
acceptance evidence.

## Version bumps and publishing

The product version is stated structurally in five places: `package.json`,
`src/version.ts`, `skills/manifest.json`, `.codex-plugin/plugin.json`, and the
macOS record `distribution/macos-app-repo/THIRD_PARTY_PROVENANCE.json` (whose
license asset is also named after the version). Bump all of them with one
command:

```sh
node scripts/set-version.mjs 1.1.0
```

`tests/version-parity.test.ts` reads every site from disk and fails if they
disagree; nothing in it is a literal. The test exists because the 1.0.2 release
bumped `package.json` and left the macOS record at 1.0.1, which broke the app
build and a CI job — and two test literals were pinned to the stale value, so
they confirmed the bug rather than catching it. Test and verifier assertions now
derive the expected version rather than stating it.

Prose compatibility floors ("requires 1.0.2 or newer") are deliberately not
rewritten by the script: they describe history, not the current version.

Publishing is tag-driven. Pushing `v<version>` runs
`.github/workflows/release.yml`, which refuses to continue unless the tag
matches `package.json`, `CHANGELOG.md` has a matching section, the parity test
passes, and the full `prepublishOnly` gate — including the packed-tarball
install check that drives the installed MCP server — is green. It then
publishes with npm provenance, so the package carries a verifiable link to the
commit that built it. Steps that are inherently human — freezing the commit,
launching and looking at the native app, regenerating the codebase graph after
the tree is final — stay manual and are listed above.
