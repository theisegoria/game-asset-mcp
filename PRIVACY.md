# Privacy

Effective: 28 August 2026

Game Development Studio is a local-first, open-source CLI and skills package.
The skills-only plugin does not run a hosted Game Development Studio service,
create a Game Development Studio account, or send analytics to the publisher.

## Local data

When the local CLI is available, it can write the workspace you select,
including jobs, asset packages, provider receipts, capture bundles, logs,
telemetry, metric samples, comparisons, and vendoring receipts. Those files
remain on the machine and paths you control unless you separately move or
publish them.

The CLI does not automatically inspect unrelated projects and does not install
into a user profile or game project without a confirmed command.

## Third-party providers

Only an explicitly authorized provider command sends data to a third party:

- Tripo may receive text prompts, images, or model inputs for requested 3D work.
- Leonardo may receive text prompts or related inputs for requested image or
  audio work.

Those services process data under their own terms and privacy policies. The CLI
connects directly from the user's machine; the publisher does not proxy or
receive the request. Provider calls can incur charges and require a separate
per-invocation approval and finite estimated spend ceiling.

## Credentials

Provider credentials are read from the local process environment or, in the
native macOS app when released, from Keychain. They are not accepted as command
arguments and are not intentionally written into jobs, receipts, logs, skill
files, or capture bundles.

## ChatGPT and Codex

Use of the public plugin is also subject to the privacy terms of the OpenAI
product in which it runs. A skills-only plugin contains instructions and
static assets. It runs no publisher backend or resident Game Development Studio
service. Local CLI execution is available only in an environment that exposes
that local executable and files to the model under the user's approval policy.

## Contact

For privacy questions, open a non-sensitive issue at
https://github.com/theisegoria/game-development-studio-skills/issues. For a
security-sensitive report, use the private process in `SECURITY.md`.
