# Game Development Studio for macOS

This SwiftPM package contains the native macOS 26 control surface for the local
`game-dev` toolchain. It is an optional app: the cross-platform CLI and five
skills remain independently usable.

## Requirements

- macOS 26 or later
- Apple silicon
- Swift 6.2 toolchain
- native app release version 1.0.0
- Node.js 22.5 or later and installed repository dependencies when building the
  self-contained runtime from source

## Build and test

From the repository root:

```sh
swift build --package-path apps/macos/GameDevelopmentStudio
swift test --package-path apps/macos/GameDevelopmentStudio
```

Use the repository helper for the canonical local app bundle, compiled icon,
closed rostered CLI/Node runtime, ad-hoc signature, launch, logs, and process
check:

```sh
./script/build_and_run.sh --test
./script/build_and_run.sh --build-only
./script/build_and_run.sh
./script/build_and_run.sh --verify
```

The generated `.build/`, `.swiftpm/`, and `dist/` directories are not source and
must not be committed. The public macOS repository is built separately from the
compiled app and contains no Swift or TypeScript project source. The app bundle
does contain the compiled JavaScript CLI, its production dependency closure,
the two required Blender helper scripts, skill/adapter resources, and a pinned
Node runtime because sensitive operations are not allowed to delegate secrets
or writes to an arbitrary global executable.

Read [the native app guide](../../../docs/macos-app.md) for architecture,
Keychain and executable-trust boundaries, one-shot approvals, distribution
state, and the exact limits of build, runtime, screenshot, GPU, and performance
evidence.
