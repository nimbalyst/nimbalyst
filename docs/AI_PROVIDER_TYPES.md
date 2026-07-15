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
| `claude-code` | **Claude Agent**. Enabled by default in settings. | Anthropic SDK integration in `ClaudeCodeProvider.ts` using `@anthropic-ai/claude-agent-sdk`. | Claude CLI / account login, with optional stored provider key. | Provider-managed; Claude model variants are handled internally. | Historical provider ID is still `claude-code` even though the UI now says "Claude Agent". When workspace trust is "Allow All", transparently uses the SDK's `permissionMode: 'auto'` classifier, which approves safe operations silently and escalates destructive or uncertain ones to the regular permission prompt (issue #371). |
| `openai-codex` | **OpenAI Codex**. First-class settings panel. | Codex app-server over stdio via `CodexAppServerProtocol`. | Codex CLI login by default; optional OpenAI API key override. | Dynamic discovery from Codex/OpenAI. | Main Codex transport. The old `@openai/codex-sdk`/`CodexSDKProtocol` path is retained only as an explicit `openaiCodex.transport = 'sdk'` escape hatch and for historical transcript parsing. |
| `openai-codex-acp` | **OpenAI Codex (ACP)**. Hidden behind the experimental ACP toggle in the OpenAI Codex settings panel. | ACP over stdio via `CodexACPProtocol`. | Same auth story as Codex; optional API key. | Reuses Codex model catalog. | Experimental peer provider with native file-edit hooks and better diff attribution. |
| `opencode` | **OpenCode**. Alpha settings panel. | OpenCode local server + SDK (`OpenCodeSDKProtocol`) over HTTP/SSE. | OpenCode's own config/auth model. | Preset model list plus user-configured providers/models from `opencode.json`. | Best fit when we want an open-source multi-model agent surface. |
| `copilot-cli` | **GitHub Copilot**. Alpha settings panel. | ACP over stdio via `copilot --acp --stdio` and `CopilotACPProtocol`. | Existing Copilot CLI login. | Minimal fixed catalog (`copilot-cli:default`). | No separate API key flow; relies on CLI auth. |

### Chat providers

These providers still use `BaseAIProvider`, not `BaseAgentProvider`.

| Provider ID | UI label | Transport style | Notes |
| --- | --- | --- | --- |
| `claude` | Claude Chat | Direct Anthropic SDK | Standard chat provider with tool calling but no MCP/file-agent loop. |
| `openai` | OpenAI | Direct OpenAI SDK | Standard chat/completions path. |
| `minimax` | MiniMax | Direct compatibility SDK selected by endpoint | Fixed MiniMax-M3 and MiniMax-M2.7 catalog with global and China endpoint presets. |
| `lmstudio` | LM Studio | Local OpenAI-compatible endpoint | Local-only chat provider. |

Chat providers should extend `BaseAIProvider`, register fixed or discovered models through `ModelRegistry`, and expose their settings, API key, endpoint, and session-creation paths in Electron. When a service offers multiple compatibility protocols, keep one provider ID and select the existing SDK adapter from validated endpoint presets instead of adding duplicate provider IDs or persisting protocol-only fields.

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

- provider CLI login only: `copilot-cli`
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

## Provider Switching Rules

Started sessions cannot switch away from an agent provider or switch between agent providers after messages already exist. That rule is enforced by `shouldBlockStartedSessionProviderSwitch()` in `packages/runtime/src/ai/server/types.ts`.

This is intentional. Agent sessions carry provider-specific thread/session state that is not safely interchangeable across providers or transports.
