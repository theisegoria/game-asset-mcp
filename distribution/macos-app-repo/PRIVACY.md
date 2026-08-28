# Privacy

Effective: 28 August 2026

Game Development Studio for macOS is a local-first app with a bundled, closed
`game-dev` runtime. The app does not create a publisher account, include
publisher-hosted analytics, or route requests through a Game Development
Studio backend.

## Local data

The selected local workspace can contain jobs, canonical asset packages,
provider receipts, capture bundles, logs, telemetry, metric samples,
comparisons, and project-vendoring receipts. The app stores ordinary
preferences such as the runtime path and workspace path in its local preferences.
Those files remain on the Mac and in paths the user controls unless the user or
another installed tool separately moves, synchronizes, or publishes them.

The app does not automatically inspect unrelated projects. Project writes,
scenario execution, GPU work, and hardware measurement are presented as
one-shot actions rather than standing permissions.

## Credentials

Tripo and Leonardo credentials are stored as provider-specific items in macOS
Keychain. The interface accepts them through masked fields, reports only
configured or not configured, and does not load a saved value back into a
visible field. A user can replace or explicitly delete a saved item.

An applicable credential is supplied only to the selected provider invocation
through the child process environment. It is not accepted as a command-line
argument. Results and diagnostics are redacted before display, but this is not
a claim that the host, every external tool, or every provider is immune to
credential compromise.

## Third-party providers and tools

Only an explicitly approved provider command sends prompt or asset input to a
provider:

- Tripo can receive text, image, or model inputs for requested 3D work.
- Leonardo can receive text or related inputs for requested image or audio
  work.

These services process data under their own privacy policies and terms. The
publisher does not proxy or receive the request. Provider calls may incur
charges and require a separate finite estimated-spend ceiling.

The bundled CLI can also invoke local tools selected by the user, including
Blender-backed operations and project-owned adapter commands. Those external
tools are not covered by the bundled runtime digest and have their own data and
security boundaries.

## Diagnostics

The app emits bounded operational telemetry through Apple's unified logging so
that a user can diagnose windows, workspaces, and command outcomes locally.
Provider secrets are not intended to be logged. Do not attach unreviewed logs,
private paths, private game content, or signed URLs to a public issue.

## Contact

Open a non-sensitive privacy question at
https://github.com/theisegoria/game-development-studio-macos/issues. Use the
private process in [SECURITY.md](SECURITY.md) for a security-sensitive report.
