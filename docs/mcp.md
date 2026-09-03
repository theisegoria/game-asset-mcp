# MCP server

Game Development Studio serves the same local operations over two transports:
the `game-dev` CLI, and an MCP server on stdio. They are one registry with two
front doors, not two implementations — every tool, Zod contract, spend rule and
evidence ceiling is shared, and a release check fails if the two ever advertise
different tool sets.

Use the CLI from anything with a shell. Use MCP from clients that have none.

## Getting the configuration

Do not hand-write it. Run:

```sh
game-dev mcp config --client claude-desktop
game-dev mcp config --client claude-code
game-dev mcp config --client codex
game-dev mcp config --client gemini
game-dev mcp config --client generic
```

The generator exists for one reason: `ASSET_OUTPUT_DIR` must be **absolute**. A
relative value resolves against the working directory the *client* chose, and
several clients spawn servers from `/`, where `assets/generated` becomes
`/assets` and the server cannot start. Historically that surfaced in the client
as nothing but "connection closed". The server now names the setting on stderr,
and the generator avoids the mistake entirely by resolving the path for you.

Add `--spend-limit-cents N` to enable paid tools. Without it they stay disabled.

## Running it

The package installs two bins:

```sh
game-dev-mcp        # the MCP server, stdio
game-dev mcp serve  # identical, via the CLI
```

Both speak JSON-RPC on stdout, so neither prints a result envelope. Diagnostics
go to stderr.

## Spending money over MCP

The CLI's authority model is a human typing `--approve-spend
--spend-limit-cents N` on every invocation. Over MCP nobody types anything and
the **model writes every argument**, so the governing rule is:

> An argument the model can write can never constitute approval.

There is deliberately no `approveSpend` input on any tool schema. Authority
comes from two places a model cannot reach:

1. **Your client's configuration file**, which a human wrote.
   `ASSET_SPEND_LIMIT_CENTS` must be present or paid tools refuse. Note this
   inverts the CLI default, where an absent ceiling means unlimited — there, a
   human had still typed the whole command.
2. **A per-call elicitation** you answer, showing the estimate, whether that
   estimate is documented or a pessimistic guess, and the ceiling.

Every other outcome is a refusal, and the provider is never contacted: you
decline, you cancel, the prompt times out, the client cannot prompt at all, or
the response arrives without a confirmation.

Paid tools stay *visible* in the tool list even when disabled, so a model can
read why and tell you, rather than inventing a workaround.

**Do not add the paid tools to an always-allow list.** Approving one paid tool
once approves every future charge through it.

## Profiles

`GAME_DEV_MCP_PROFILE=readonly` registers only tools annotated read-only: no
spending, no writes. Useful for exploratory sessions. The default is `all`.

## What is not here yet

The capture, visual-debugging and performance commands are currently CLI-only —
they live in the CLI dispatch rather than the shared registry, so MCP does not
expose them. Moving them is planned. Until then, drive visual debugging through
the CLI.

Streamable HTTP is not implemented. When it lands it will be loopback-only with
an `Origin` check and a bearer token. SSE is deprecated and will not be added.

## Evidence

MCP results carry the same `evidenceCeiling` and `evidence` fields as the CLI.
A returned analysis is never a claim of hardware GPU execution, target-hardware
timing, or human visual review; those fields are `false` by construction.
