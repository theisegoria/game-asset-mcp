# Contributing

Thank you for helping improve Game Development Studio.

## Development setup

Use Node.js 22.5 or newer:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run verify
npm pack --dry-run --json
```

The tests do not require provider keys and must not make paid provider calls.
Some HTTP contract tests bind a loopback HTTPS server. Blender-specific tests
run when Blender is discoverable; CI has a dedicated job that refuses a false
green caused by skipping those tests.

## Change expectations

- Keep stdout valid for the selected JSON or JSONL protocol.
- Keep credentials out of arguments, request fixtures, logs, errors, snapshots,
  and receipts.
- Add a regression test for every fixed defect.
- Preserve dry-run-first behavior and per-invocation authorization boundaries.
- Treat package manifests and run bundles as closed, hashed formats.
- Add a schema major when changing the meaning of a persisted or process
  contract.
- Keep evidence claims literal. A fixture, static check, or adapter-reported
  flag is not live-provider, GPU, target-performance, pixel, or human-review
  proof.
- Update the focused skill reference when changing a public command.

## Pull requests

Describe:

1. the user-visible problem
2. the chosen contract
3. the tests and environments actually run
4. any evidence gate that remains external
5. migration or compatibility impact

Do not include API keys, generated paid assets without redistribution rights,
private project captures, or credentials in reproduction archives.

## Provider changes

Use the provider's current official API documentation. Tests should exercise a
local HTTPS fixture with representative success, pending, failure, timeout,
malformed, and oversized responses. A live smoke test is a separate,
explicitly authorized gate and must report its cost and retained artifacts.

## Adapter contributions

General adapters should be portable and must not assume access to a private
project. A project-specific adapter may be included as a documented template
when it contains no private source, secrets, binary paths, or standing
execution permission.

## License

By contributing, you agree that your contribution is available under the
repository's MIT license and that you have the right to submit it.
