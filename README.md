# dsh-experimental-agent-codex

English | [中文](README.zh.md)

An experimental [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that replaces the default Agent Loop with the user's own [OpenAI Codex CLI](https://github.com/openai/codex) through the public app-server protocol.

This repository is a bridge only. It never installs or upgrades Codex, starts login or logout, reads Codex authentication files, writes Codex configuration, or bundles `@openai/codex`. The user owns the Codex executable, version, `CODEX_HOME`, account, MCP configuration, and built-in tools.

## Status

This is an experimental first release. It preserves the Harness Agent, Session, inbox, UI/ACP, streaming text, usage, steering, cancellation, resume, and teardown surfaces. It does not yet bridge Harness tools or Harness approval UI into Codex. Read the compatibility limits below before using it in an important workspace.

## Prerequisites

- DeepSeek Harness `0.1.0-rc.8` or a compatible later `0.1.x` release.
- Node.js and pnpm supported by that Harness release.
- A user-managed Codex CLI whose `app-server` supports stdio JSON-RPC.

Install Codex using an OpenAI-supported method, then complete authentication yourself:

```sh
codex --version
codex login
```

The bridge checks neither installation nor login at plugin load. The first Agent creation reports executable, protocol, authentication, or account errors from the user's Codex installation.

## Install

Install the bundle into every Harness profile that should use Codex. It replaces that profile's existing `agent-loop` row; do not mount `@deepseek-ai/dsh-agent-loop` again under another row id.

```sh
# Browser profile
dsh plugin --profile web add github:CaineWind/dsh-experimental-agent-codex

# Headless profile
dsh plugin --profile headless add github:CaineWind/dsh-experimental-agent-codex
```

Pin a reviewed commit for a reproducible installation:

```sh
dsh plugin --profile web add github:CaineWind/dsh-experimental-agent-codex#<commit-sha>
```

The repository commits prebuilt `lib/` files, so a GitHub installation does not require allowing a dependency build script.

Restart the profile, then inspect the effective configuration:

```sh
dsh --profile web --dump-config
```

The effective configuration should disable the base row and add the bridge:

```yaml
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  disabled: true
- id: agent-codex
  name: dsh-experimental-agent-codex
  config:
    command: codex
    args: [app-server, --listen, 'stdio://']
    approvalPolicy: never
    sandbox: workspace-write
    disposeGraceMs: 3000
```

## Use

After restarting, use the profile normally:

```sh
# Browser application
dsh --profile web

# One headless task
dsh --profile headless "Inspect this repository and summarize its architecture"
```

Creating a Harness Session starts one Codex app-server process and creates one durable Codex thread. Closing the Session stops the process tree. Resuming the Harness Session starts a new app-server process and calls `thread/resume` with the recorded thread id.

Codex thread data remains in the user's Codex home. A persisted Harness Session cannot resume its thread after the user removes or changes the corresponding Codex state.

## Configure

Override the bundle defaults in the profile's own `cordis.patch.yml`:

```yaml
- id: agent-codex
  config:
    command: codex
    args: [app-server, --listen, 'stdio://']
    approvalPolicy: never
    sandbox: workspace-write
    disposeGraceMs: 3000
```

| Field | Default | Meaning |
|---|---|---|
| `command` | `codex` | PATH name or absolute path of the user-managed executable. |
| `args` | `[app-server, --listen, 'stdio://']` | Complete app-server arguments. |
| `env` | `{}` | Explicit environment layered after Harness subprocess environment scrubbing. |
| `cwd` | none | Fallback when a Harness Session has no working directory. |
| `approvalPolicy` | `never` | `untrusted`, `on-failure`, `on-request`, or `never`. |
| `sandbox` | `workspace-write` | `read-only`, `workspace-write`, or `danger-full-access`. |
| `disposeGraceMs` | `3000` | Grace before process-tree termination escalates. |

Some older Codex versions expose another app-server argument spelling. Keep Codex user-managed and override only `args` after checking `codex app-server --help`:

```yaml
- id: agent-codex
  config:
    args: [app-server, --stdio]
```

### Authentication and environment

The child inherits ordinary environment values, including `PATH`, `HOME`, proxies, and `CODEX_HOME`, so normal Codex login state remains user-owned.

Harness deliberately removes credential-shaped environment variables such as `OPENAI_API_KEY`. A deployment that authenticates Codex through an environment key must opt in explicitly:

```yaml
- id: agent-codex
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY
```

Never place a literal credential in a committed patch.

## Runtime behavior

Each live Harness Agent owns one app-server process and one durable Codex thread. A fresh Session records `codex/thread-linked` with the thread id and observed app-server version. Codex owns its internal conversation; Harness retains the UI, ACP, inbox, lifecycle, and audit projection.

One Harness turn maps to one Codex turn. Final-answer deltas become `assistant/chunk`, the assembled answer becomes `assistant/message`, and reported usage becomes standard disjoint `TokenUsage`. Cached input is reported as `cacheReadTokens` and subtracted from uncached `inputTokens`.

The assembled Harness system prompt is supplied as Codex developer instructions when a thread is created and recorded in `request/header`. Resume uses the thread's existing instructions.

Interactive command, file-change, permission, user-input, and MCP elicitation requests receive safe unattended refusal responses. The default `approvalPolicy: never` avoids an interactive approval round trip.

## Compatibility limits

- Codex runs its own built-in and configured MCP tools. Harness `ctx.tools` are not exported, and Codex-internal calls are not projected as Harness `tool/call` and `tool/result` events.
- The public app-server protocol does not expose every internal model request. The bridge cannot reproduce `agent/request`, `agent/pre-step`, Harness LLM adapters, retries, request reconstruction, or exact request-level KV-cache behavior.
- Input is text-only. Image and plugin-defined content blocks fail before crossing the process boundary.
- Harness approval UI is not bridged. Interactive Codex requests are declined rather than left pending.
- `AgentOptions.model` is sent at thread creation. `provider` labels the Harness projection. `maxTokens` has no app-server equivalent and is not applied.
- System-prompt changes after thread creation and Harness dynamic tool/context assembly are not synchronized into an existing thread.
- Only profiles that install this bundle replace their AgentFactory; global defaults remain unchanged.

## Troubleshooting

### Startup reports `cannot get property "agents" without inject`

This error means the installed package lost its Cordis injection metadata during Loader normalization. Update the Git dependency and restart the profile:

```sh
dsh plugin --profile web update dsh-experimental-agent-codex
```

Run the update for every affected profile. A commit-pinned installation must move its pin to a fixed commit.

### Codex executable not found

Run `codex --version` in the same environment that starts `dsh`. Configure an absolute `command` path when Codex is outside `PATH`.

### Authentication or authorization failure

Run Codex directly and repair its user-owned login. Explicitly forward `OPENAI_API_KEY` through `env` when that is the chosen authentication method. The bridge never runs `codex login`.

### App-server rejects the arguments

Run `codex app-server --help` for the installed version and override `args`. This repository intentionally does not pin the user's executable.

### A second AgentFactory is registered

Inspect `dsh --profile <name> --dump-config` and keep exactly one row that registers the AgentFactory.

## Uninstall

```sh
dsh plugin --profile web remove dsh-experimental-agent-codex
```

Restart the profile. The base bundle's earlier `@deepseek-ai/dsh-agent-loop` row becomes effective again. Uninstalling this bridge does not remove Codex, log out, or delete `CODEX_HOME`.

## Develop

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

Commit regenerated `lib/` files with every runtime source change so direct GitHub installation remains build-script-free.

## License

[MIT](LICENSE)
