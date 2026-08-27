# Release notes

## 1.0.0 — 28 August 2026

The first native Game Development Studio companion brings the local
`game-dev` contract into four macOS 26 workspaces.

### Included

- Production checks, explicitly approved Tripo or Leonardo requests, local GLB
  inspection and validation, and canonical package construction
- dry-run-first package catalog search and exact-input project vendoring
- project-owned visual-debugging scenarios with separate process, GPU, and
  hardware-performance authority
- sealed capture analysis, attachment-aware raster comparison, metric summary,
  and performance comparison
- native result inspector, recent operation history, toolbar search, menus,
  settings, progress, cancellation, and explicit empty/error states
- masked, provider-specific Keychain credential entry that reports only
  configured state
- one-shot approval sheets for paid work, local writes, project execution, GPU
  work, and hardware measurement

### System and artifact contract

- macOS 26.0 or later
- Apple silicon (`arm64`) only
- native app version 1.0.0, bundle identifier
  `com.theisegoria.GameDevelopmentStudio`
- separately installed `game-dev` CLI 1.0.0 or later; Node.js 22.5 or later is
  required by that CLI and is not embedded in the app
- compiled `.app` ZIP attached to the GitHub release; no Swift or TypeScript
  source is committed to this distribution repository

### Distribution boundary

The 1.0.0 bundle is ad-hoc signed. It is not Developer ID signed, notarized,
stapled, claimed to use Hardened Runtime, or reviewed by the Mac App Store. A
verified checksum and an intact ad-hoc signature establish download and bundle
integrity within those limits; they do not authenticate an Apple Developer ID.

Provider fixtures, automated tests, source review, a local build, or one app
screenshot do not prove live-provider compatibility, engine import, target-GPU
execution, pixel correctness, hardware performance, accessibility, or human
artistic acceptance. Each stronger claim requires its own admitted evidence.

