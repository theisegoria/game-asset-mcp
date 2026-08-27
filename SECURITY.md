# Security policy

## Supported versions

Security fixes are provided for the latest released major version. At initial
publication that is 1.x.

## Report a vulnerability

Please use
[GitHub private vulnerability reporting](https://github.com/theisegoria/game-development-studio/security/advisories/new)
instead of a public issue when a report could expose:

- credential or authorization leakage
- path traversal, symlink escape, or unintended project writes
- command or argument injection
- package or capture integrity bypass
- spend-gate bypass or duplicate paid submission
- unsafe archive, download, or parser behavior

Include the affected version, platform, minimal reproduction, expected security
property, and impact. Do not include real provider credentials or private game
assets. You will receive acknowledgement through GitHub's advisory workflow.

## Security properties

The project is designed to:

- keep provider secrets out of command arguments and persisted artifacts
- redact credentials, signed query values, and user info from diagnostics
- require HTTPS for credential-bearing provider requests
- cap downloads while streaming and bound parsers and process output
- validate resolved paths, reject unsafe symlinks, and use atomic writes
- separate planning from confirmation and spend, GPU, and performance authority
- verify closed artifact rosters before analysis or vendoring
- avoid automatic installation into a user profile or game project

These properties reduce risk but do not make an untrusted adapter, Blender
file, provider response, or generated asset inherently safe. Review project
adapters before execution and keep provider accounts protected with their own
limits.

## Secrets

Never attach keys, cookies, OAuth tokens, signed download URLs, recovery codes,
or payment details to an issue. Revoke and rotate a credential immediately if
it may have been exposed.
