# AI Provider Types

Nimbalyst currently supports two provider categories:

- **Agent providers**: long-running coding agents with MCP, direct file/tool access, multi-file workflows, and resumable provider sessions.
- **Chat providers**: direct model/API integrations that work by attaching document context to prompts instead of giving the model a live tool surface.

The code-level source of truth for provider IDs lives in `packages/runtime/src/ai/server/types.ts` (`AI_PROVIDER_TYPES` and `isAgentProvider()`).

## Current Provider Inventory

### Agent providers

These providers currently register through `packages/runtime/src/ai/server/ProviderFactory.ts` and are treated as agents by `isAgentProvider()`.

| Provider ID | UI label / availability | Transport style | Auth model | Model discovery | Notes |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | **Claude Agent**. Enabled by default in settings. | Anthropic SDK integration in `ClaudeCodeProvider.ts` using `@anthropic-ai/claude-agent-sdk`. | Claude CLI / account login, with optional stored provider key. | Built-in Claude variants plus custom models from Claude settings `modelPicker` (see [Custom Claude models](#custom-claude-models)). | Historical provider ID is still `claude-code` even though the UI now says "Claude Agent". Agent-verified workspaces transparently use the SDK's `permissionMode: 'auto'` classifier, which approves safe operations silently and escalates destructive or uncertain ones (issue #371). |
| `openai-codex` | **OpenAI Codex**. First-class settings panel. | Codex app-server over stdio via `CodexAppServerProtocol`. | Codex CLI login by default; optional OpenAI API key override. | Dynamic discovery from Codex/OpenAI. | Main Codex transport. Agent-verified workspaces use Codex's `workspace-write` sandbox with `on-request` approvals and the native automatic reviewer. The old `@openai/codex-sdk`/`CodexSDKProtocol` path is retained only as an explicit `openaiCodex.transport = 'sdk'` escape hatch and for historical transcript parsing. |
| `openai-codex-acp` | **OpenAI Codex (ACP)**. Hidden behind the experimental ACP toggle in the OpenAI Codex settings panel. | ACP over stdio via `CodexACPProtocol`. | Same auth story as Codex; optional API key. | Reuses Codex model catalog. | Experimental peer provider with native file-edit hooks and better diff attribution. |
| `opencode` | **OpenCode**. Alpha settings panel. | OpenCode local server + SDK (`OpenCodeSDKProtocol`) over HTTP/SSE. | OpenCode's own config/auth model. | Preset model list plus user-configured providers/models from `opencode.json`. | Best fit when we want an open-source multi-model agent surface. |
| `copilot-cli` | **GitHub Copilot**. Alpha settings panel. | ACP over stdio via `copilot --acp --stdio` and `CopilotACPProtocol`. | Existing Copilot CLI login. | Minimal fixed catalog (`copilot-cli:default`). | No separate API key flow; relies on CLI auth. |
| `grok-build` | **Grok Build**. Alpha settings panel. | ACP over stdio via `grok agent stdio` and `GrokACPProtocol`. | `grok login` only. | Discovered from `grok models`, which works without auth. | Grok's ACP updates keep the `rawInput`/`rawOutput` and `{type:'diff', path, oldText, newText}` blocks the old `grok -p` surface carried, and add a live permission round-trip, MCP servers delivered inline through `session/new` (nothing is written to `~/.grok/`), and Grok's native `_x.ai/ask_user_question`. The user's model is applied with `session/set_model` — the `-m` spawn flag is reset at `session/new`. Token counts arrive in `response._meta`, not standard `usage`; grok stays `contextReporting: 'token-counts'`. File-change fidelity is `'tool-args'` — Grok has no delete or move tool, so removals go through `run_terminal_command` and the watcher must stay on. |
| `cursor-agent` | **Cursor Agent**. Alpha settings panel. | Headless NDJSON per turn: `cursor-agent --resume <chatId> -p … --output-format stream-json` via `CursorAgentProtocol`. | `cursor-agent login` only. | Discovered from `cursor-agent --list-models` (reflects the account's entitlements). | The only built-in provider besides Codex app-server with `'structured'` file-change fidelity: `editToolCall` results carry `beforeFullFileContent`/`afterFullFileContent` plus a unified diff, and `deleteToolCall` reports removals with `prevContent`. Headless `--print` grants write and shell for the whole turn with no per-tool approval to intercept, so the turn is gated up front on workspace trust. |

### Custom Claude models

`claude-code` and `claude-code-cli` list built-in variants (`opus`, `sonnet`, ...) that resolve to pinned Anthropic model ids, plus any models the user defines under `modelPicker.options` in Claude's own settings. Logic lives in `packages/runtime/src/ai/claudeCustomModels.ts`.

- **Id format:** `claude-code:custom/<model>` (and `claude-code-cli:custom/<model>`). `<model>` keeps its case and is sent to the SDK `model` option or `claude --model` verbatim: no pinning, no `-1m`/`[1m]` handling. The `custom/` namespace means a router model named `opus` never collides with the built-in. Unknown non-custom ids still throw.
- **Discovery:** main injects `ClaudeSettingsManager.getModelPicker` via `setClaudeModelPickerSource`. It reads user, project, and local settings; the highest-precedence file that defines `modelPicker` wins wholesale. `replaceBuiltInOptions: true` hides built-ins only when at least one custom option exists. `ModelRegistry` does not cache Claude catalogs, so settings edits appear on the next fetch; scope is per workspace.
- **Capabilities:** `behavesAs` (a full Anthropic id) maps to a built-in variant for context window, effort, and thinking-toggle support (`behavesAsVariantForModelId`). Without it: 200k seed, no effort control, thinking left at the SDK default. The renderer registers options from the fetched catalog (`registerClaudeCustomModelsFromCatalog`) so labels and capability checks work there too.
- **CLI routing:** the observation proxy sits on the CLI's `ANTHROPIC_BASE_URL`. Its upstream is the explicit Nimbalyst setting, else a loopback `ANTHROPIC_BASE_URL` from Claude settings `env`, else Anthropic (`claudeCliObservation/proxyUpstream.ts`). Non-loopback URLs are never followed: the traffic carries the subscription OAuth token.
- **Known gaps:** iOS `ModelLabel.swift` shows a heuristic label for custom ids; the default model stays `claude-code:opus` even when built-ins are hidden.

User-facing setup: [support/custom-claude-models.md](../support/custom-claude-models.md).

### Chat providers

These providers still use `BaseAIProvider`, not `BaseAgentProvider`.

| Provider ID | UI label | Transport style | Notes |
| --- | --- | --- | --- |
| `claude` | Claude Chat | Direct Anthropic SDK | Standard chat provider with tool calling but no MCP/file-agent loop. |
| `openai` | OpenAI | Direct OpenAI SDK | Standard chat/completions path. |
| `lmstudio` | LM Studio | Local OpenAI-compatible endpoint | Local-only chat provider. |

## What Makes An Agent Provider Different

Agent providers all advertise:

- `mcpSupport: true`
- `supportsFileTools: true`
- `resumeSession: true`
- `edits: true`

Those capabilities are defined in `packages/runtime/src/ai/server/types.ts` and are what the rest of the app uses to distinguish agents from chat providers.

At runtime, almost all agent-only behavior is shared by `packages/runtime/src/ai/server/providers/BaseAgentProvider.ts`, including:

- provider-session ID mapping
- permission request lifecycle
- abort/destroy behavior
- trust-check integration
- permission response polling
- best-effort raw message logging

If a provider is agentic but does **not** extend `BaseAgentProvider`, it will miss a large amount of expected app behavior.

## Current Agent Provider Patterns

The current codebase has three useful implementation shapes:

### 1. Direct SDK provider

`ClaudeCodeProvider.ts` talks to the SDK directly and handles provider-specific stream parsing inline.

Use this pattern when the upstream SDK already exposes the exact lifecycle you need and wrapping it in `AgentProtocol` would not buy much.

### 2. Protocol-backed provider

`OpenAICodexProvider.ts`, `OpenAICodexACPProvider.ts`, `OpenCodeProvider.ts`, and `CopilotCLIProvider.ts` all extend `BaseAgentProvider` but push provider-specific transport details into protocol adapters under `packages/runtime/src/ai/server/protocols/`.

Use this pattern when:

- you want a clean transport boundary
- the provider already emits structured events
- you expect to unit test transport and provider logic independently

`packages/runtime/src/ai/server/protocols/ProtocolInterface.ts` is the contract for this layer.

### 3. CLI-backed provider

We currently have two CLI-backed sub-patterns:

- **ACP CLI**: `OpenAICodexACPProvider`, `CopilotCLIProvider`
- **CLI/server hybrid**: `OpenCodeProvider` starts a subprocess-backed local server and then speaks HTTP/SSE through its SDK client

For new CLI integrations, prefer a structured protocol like ACP or JSON-over-stdio. Avoid PTY scraping unless there is no viable alternative.

## Transcript Pipeline Requirements

Adding an agent provider is not just a provider-class change. The transcript system expects raw provider messages to be reparsed into canonical events.

Current parser routing lives in:

- `packages/runtime/src/ai/server/transcript/processDescriptor.ts`
- `packages/runtime/src/ai/server/transcript/TranscriptTransformer.ts`
- `packages/runtime/src/ai/server/transcript/projectRawMessages.ts`

Current provider-to-parser mapping is:

- `claude-code` -> `ClaudeCodeRawParser`
- `openai-codex` -> `CodexRawParser`
- `openai-codex-acp` -> `CodexACPRawParser`
- `opencode` -> `OpenCodeRawParser`
- `copilot-cli` -> `CopilotRawParser`
- `grok-build` / `cursor-agent` -> `HeadlessAgentRawParser` (re-uses the protocol adapters' own `mapGrokRecord` / `mapCursorRecord` rather than re-decoding the wire shapes a second time)

If a new provider emits a new raw event shape, it needs a parser and parser registration. If it deliberately reuses an existing shape, document that and route it to the existing parser explicitly.

## Adding A New Agent Provider

This is the practical checklist for adding another agent provider.

### 1. Add the provider ID to runtime types

Update `packages/runtime/src/ai/server/types.ts`:

- add the new ID to `AI_PROVIDER_TYPES`
- update `isAgentProvider()`
- update any provider-specific model normalization helpers if needed

This file is the first place that should fail if a provider is only partially wired.

### 2. Implement the provider class

Create `packages/runtime/src/ai/server/providers/<YourProvider>.ts` and extend `BaseAgentProvider`.

At minimum, implement:

- `initialize(config)`
- `sendMessage(...)`
- `getCapabilities()`
- `getProviderName()`
- `getProviderSessionData(sessionId)`

Typical expectations:

- store and restore the upstream session/thread ID via `this.sessions`
- log raw input/output events so transcript migration can rebuild canonical events
- emit `promptAdditions` when document/system additions are injected
- honor aborts through `this.abortController`

If the provider has a clean transport boundary, also create a protocol adapter under `packages/runtime/src/ai/server/protocols/`.

### 3. Register it in factory + model discovery

Update:

- `packages/runtime/src/ai/server/ProviderFactory.ts`
- `packages/runtime/src/ai/server/ModelRegistry.ts`

If the provider has fixed or synthetic models, surface them there. If it discovers models dynamically, keep that logic inside the provider and let `ModelRegistry` call into it.

### 4. Wire transcript parsing

Update parser selection and, if necessary, add a parser:

- `packages/runtime/src/ai/server/transcript/processDescriptor.ts`
- `packages/runtime/src/ai/server/transcript/TranscriptTransformer.ts`
- `packages/runtime/src/ai/server/transcript/projectRawMessages.ts`
- `packages/runtime/src/ai/server/transcript/parsers/*`

If the provider emits edit events, make sure the parser can reconstruct stable `providerToolCallId` values. That is what keeps diff rendering, file attribution, and transcript replay coherent.

### 5. Expose it through Electron settings and session creation

Update Electron-side provider plumbing:

- `packages/electron/src/renderer/store/atoms/appSettings.ts`
- `packages/electron/src/renderer/components/Settings/SettingsView.tsx`
- `packages/electron/src/renderer/components/Settings/SettingsSidebar.tsx`
- `packages/electron/src/preload/index.ts`
- `packages/electron/src/main/services/ai/AIService.ts`

This usually includes:

- default enabled/install state
- model loading
- connection testing
- provider toggles
- provider label/icon wiring
- session creation union types and IPC typing

### 6. Wire shared agent dependencies from Electron main

Most agent providers need startup-time injections from `packages/electron/src/main/index.ts` and related services:

- MCP config loader
- shell environment loader
- enhanced PATH loader
- session naming server port
- extension-dev server port
- session-context server port
- meta-agent server port
- trust checker
- permission pattern saver/checker
- security logger

If the provider supports native edit hooks, it may also need explicit file-write callbacks like the ACP Codex provider.

### 7. Add tests at the right layers

Minimum expected coverage:

- provider unit tests in `packages/runtime/src/ai/server/providers/__tests__/`
- transcript parser tests in `packages/runtime/src/ai/server/transcript/__tests__/`
- model discovery or normalization tests if relevant
- Electron-side behavior tests if the provider introduces new settings or lifecycle paths

## Extra Guidance For CLI-Based Agent Providers

If the new provider is driven by a CLI, there are a few extra requirements beyond the normal provider checklist.

### Prefer structured CLI protocols

Good:

- ACP over stdio
- JSON-RPC over stdio
- newline-delimited JSON events
- a local HTTP/SSE server spawned by the CLI

Bad:

- scraping ANSI terminal output
- parsing human-readable TTY status text
- relying on cursor movement or screen buffers

The existing codebase is set up for structured transports. `CopilotCLIProvider` and `OpenAICodexACPProvider` are the closest templates for stdio/ACP integrations.

### Add CLI installation metadata

If we want the app to manage installation or detect presence, update:

- `packages/electron/src/main/services/CLIManager.ts`

That includes:

- the provider's CLI package name
- the executable command name
- install/check/upgrade logic if the defaults are insufficient

If the CLI needs custom path resolution, follow the Copilot pattern and add a provider-specific path loader.

### Make Electron's environment usable

GUI-launched Electron apps do not inherit a full shell environment. CLI-backed agents often fail unless they receive:

- the user's login-shell env
- an enhanced `PATH`
- any provider-specific auth/config env vars

Existing wiring for this already exists in `packages/electron/src/main/index.ts`. A new CLI provider should almost certainly receive the same injections.

### Decide where auth lives

Current CLI-backed agents fall into three auth patterns:

- provider CLI login only: `copilot-cli`, `grok-build`, `cursor-agent`
- CLI login with optional API key override: `openai-codex`
- provider-owned config/auth file: `opencode`

Document the auth contract clearly in the provider panel and keep the runtime consistent with it. Do not add `process.env` API key fallbacks.

### Think about packaged builds early

CLI providers that work in dev can still fail in packaged apps because of:

- `asar` path resolution
- missing bundled binaries
- ESM dynamic import issues
- executable location differences by platform

`OpenAICodexProvider` is the main example of extra packaged-build work: it resolves the Codex SDK/binary differently when running from a packaged Electron app.

## Suggested Templates

Use these as starting points depending on the integration style:

- **Anthropic/SDK-first agent**: `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts`
- **SDK with protocol adapter**: `packages/runtime/src/ai/server/providers/OpenAICodexProvider.ts`
- **ACP / stdio CLI agent**: `packages/runtime/src/ai/server/providers/OpenAICodexACPProvider.ts`
- **Open-source server-backed agent**: `packages/runtime/src/ai/server/providers/OpenCodeProvider.ts`
- **Minimal CLI-auth ACP agent**: `packages/runtime/src/ai/server/providers/CopilotCLIProvider.ts`
- **Headless per-turn NDJSON CLI agent**: `packages/runtime/src/ai/server/providers/HeadlessCliAgentProvider.ts` with `protocols/headless/HeadlessNdjsonProcess.ts`. Subclass the provider and write only a protocol adapter that maps the CLI's records onto `ProtocolEvent`s — see `GrokBuildProvider` / `CursorAgentProvider`, which are ~120 lines each.

### Choosing a transport

**Pick the surface that reports file edits as structured data, not the one that shares the most code.** ACP is tempting because four providers could share a client, but ACP has no authoritative file-change item: every ACP provider here is stuck on watcher-inferred attribution. Both `grok-build` and `cursor-agent` were measured across every surface their CLI offers before choosing, and both landed off ACP for exactly this reason.

Declare what you found in `packages/runtime/src/ai/server/providerFileTracking.ts`:

- `'structured'` — an authoritative change item with path plus diff or old/new text, with deletes and moves distinguishable. Earns `attributionMode: 'disabled'`; the filesystem watcher must not attribute on top of it.
- `'tool-args'` — edits arrive as tool calls naming the path before the write. Good enough for a pre-edit baseline; the watcher still runs.
- `'none'` — nothing usable; the watcher is the only source.

The settings panel states this to the user (`HeadlessCliProviderPanel`), because "file tracking" means materially different things at each level and a user should not have to guess which one they have.

## Provider Switching Rules

Started sessions cannot switch away from an agent provider or switch between agent providers after messages already exist. That rule is enforced by `shouldBlockStartedSessionProviderSwitch()` in `packages/runtime/src/ai/server/types.ts`.

This is intentional. Agent sessions carry provider-specific thread/session state that is not safely interchangeable across providers or transports.
