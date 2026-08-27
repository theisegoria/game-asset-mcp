# Security policy

## Supported versions

Security fixes are provided for the latest released major version. At initial
publication that is 1.x.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/theisegoria/game-development-studio-macos/security/advisories/new)
when a report could expose credential leakage, argument injection, unintended
project writes, a plan/approval bypass, an archive-integrity bypass, or unsafe
handling of provider or capture data.

Include the affected version and macOS build, a minimal reproduction, the
expected security property, and the impact. Never include real provider keys,
cookies, signed URLs, private game assets, or recovery information. Revoke and
rotate a credential immediately if it may have been exposed.

## Artifact verification

Every release publishes a SHA-256 line in `CHECKSUMS.txt`. Verify it before
opening the app, then run:

```sh
codesign --verify --deep --strict GameDevelopmentStudio.app
codesign -dvvv GameDevelopmentStudio.app
lipo -archs GameDevelopmentStudio.app/Contents/MacOS/GameDevelopmentStudio
```

For version 1.0.0, expect an intact ad-hoc signature and exactly the `arm64`
architecture. An ad-hoc signature detects post-signing bundle changes but does
not authenticate a Developer ID publisher. The release is not notarized; the
GitHub release and its checksum are the available distribution channel and
integrity evidence.

## Narrow security properties

The app is designed to:

- keep provider secrets out of command arguments and visible saved state;
- use provider-specific Keychain items and inject only the credential required
  by an invocation;
- redact configured secret values from structured results and diagnostics;
- launch the configured executable with an argument array instead of shell
  interpolation;
- bound standard input, captured output, timeouts, and cancellation;
- keep planning separate from confirmation and spend, GPU, and performance
  authority; and
- require a fresh exact-input plan before consequential vendoring or scenario
  execution.

These properties reduce risk. They do not make an untrusted CLI, project
adapter, Blender file, provider response, generated asset, or host system safe.
Review project adapters before execution and protect provider accounts with
their own limits.

## Distribution limitation

Version 1.0.0 is ad-hoc signed, not Developer ID signed, not notarized, and is
not claimed to use Hardened Runtime. Do not interpret successful local launch
or `codesign --verify` as Apple trust-policy review.

