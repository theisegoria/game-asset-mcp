# Privacy

Effective: 28 August 2026

Game Development Studio is a local-first, open-source CLI and skills package.
The skills-only plugin does not run a hosted Game Development Studio service,
create a Game Development Studio account, or send analytics to the publisher.
The publisher does not receive or retain prompts, project files, generated
assets, captures, telemetry, provider requests, provider credentials, or usage
analytics through the plugin.

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

Provider requests are available only to a user who already controls the
applicable provider account, API access, credential, inputs, and spend. Tripo
and Leonardo independently determine their retention, deletion, training,
visibility, and output-rights rules, which can depend on account tier and
settings. Review the current
[Tripo privacy policy](https://www.tripo3d.ai/privacy) and
[Leonardo privacy policy](https://leonardo.ai/privacy-policy) before use.

## Credentials

The plugin does not collect, solicit, accept, store, or transmit provider
credentials. A local CLI credential must be configured by the user outside the
plugin conversation in a user-controlled environment; the native macOS app can
store it in Keychain. The CLI reads a configured credential only when the user
authorizes the corresponding direct provider request. Credentials are not
accepted as command arguments and are not intentionally written into request
files, jobs, receipts, logs, skill files, screenshots, or capture bundles.

Do not paste a provider credential into ChatGPT, Codex, a support report, a
request file, source control, or a screenshot. The skills may use
`game-dev credentials status --json`, which reports only configured or missing
and never returns the credential value.

## Retention and user controls

**Publisher retention is zero:** because the plugin has no publisher backend
or analytics collector, the publisher receives no plugin-workflow data to
retain and normally has nothing to delete on a user's behalf.

Local jobs, packages, receipts, captures, logs, metrics, and related artifacts
remain in the user-selected workspace until the user deletes those files or
the containing workspace. The CLI does not set an automatic retention period,
upload those files to the publisher, or delete them in the background. Users
can inspect the selected paths before execution, decline any operation, delete
local outputs with their normal file-management tools, uninstall the plugin or
CLI, and revoke a provider credential in the provider account.

Data sent in an authorized provider request is retained and controlled by that
provider, not by the publisher. Use the provider's account controls or support
process for access or deletion requests concerning provider-held data. OpenAI
and GitHub may separately retain data supplied to their services under their
own policies and controls.

## ChatGPT and Codex

Use of the public plugin is also subject to the privacy terms of the OpenAI
product in which it runs. A skills-only plugin contains instructions and
static assets. It runs no publisher backend or resident Game Development Studio
service. Local CLI execution is available only in an environment that exposes
that local executable and files to the model under the user's approval policy.

## Contact

For privacy questions, open a non-sensitive issue at
https://github.com/theisegoria/game-development-studio-skills/issues. Never put
personal data or secrets in a public issue. For a privacy or security report
that could expose sensitive material, use the private process in `SECURITY.md`.
