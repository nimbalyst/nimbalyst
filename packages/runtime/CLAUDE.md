# Runtime Package

Core runtime logic for Nimbalyst — AI provider implementations and shared services that work across Electron and Capacitor (mobile) platforms.

## Package Placement

Put React components in this package if they might be used by the mobile app. Components specific to Electron go in the `electron` package.

## AI Providers

Two categories — **agent providers** (Claude Agent, OpenAI Codex; full MCP, file-system tools, multi-file ops, session persistence) and **chat providers** (Claude Chat, OpenAI, LM Studio; direct API, files as context, faster, local model support). See [/docs/AI_PROVIDER_TYPES.md](/docs/AI_PROVIDER_TYPES.md).

| Provider ID | Implementation | Notes |
| --- | --- | --- |
| `claude` | `src/ai/server/providers/ClaudeProvider.ts` | Anthropic SDK; standard models; streaming with tool use; model list in `src/ai/modelConstants.ts`. |
| `claude-code` | `src/ai/server/providers/ClaudeCodeProvider.ts` | Dynamically loads `@anthropic-ai/claude-agent-sdk` from user's installation. **Manages its own model selection — do not pass model IDs.** See [/docs/INTERNAL_MCP_SERVERS.md](/docs/INTERNAL_MCP_SERVERS.md). |
| `openai` | OpenAI API | GPT-4, GPT-3.5. |
| `openai-codex` | `src/ai/server/providers/OpenAICodexProvider.ts` | Codex app-server transport by default; thread-based streaming; session resume via persisted provider session IDs. The old `@openai/codex-sdk` transport is legacy-only. See [Codex Binary Path](#codex-binary-path-resolution). |
| `lmstudio` | LM Studio HTTP | Local model support. |

### Provider Factory

- **Location**: `src/ai/server/ProviderFactory.ts`
- Creates / manages provider instances by type; each provider is cached per session.

### Codex Binary Path Resolution

In Electron packaged apps, the Codex binary cannot be executed from within the asar archive (virtual filesystem). `resolvePackagedCodexBinaryPath()`:

1. Maps `process.platform` / `process.arch` to Codex target triples (`aarch64-apple-darwin` for ARM64 macOS, `x86_64-pc-windows-msvc` for x64 Windows, etc.)
2. Checks `app.asar.unpacked/node_modules/@openai/codex-sdk` first (priority location)
3. Falls back to `node_modules/@openai/codex-sdk`
4. Passes the resolved path to the app-server transport or legacy SDK constructor via `codexPathOverride`

**Related files:**
- `src/ai/server/providers/codex/codexBinaryPath.ts`
- `packages/electron/package.json` — `asarUnpack` and `extraResources` include Codex SDK/native packages for the app-server binary and the legacy SDK escape hatch

## AI Features

- **AI Chat Panel**: multi-provider, document-aware, no-document handling, multi-session per project, edit streaming
- **Session Manager**: global view, search, session details, open/export/delete actions
- **Model Configuration**: dynamic model fetching from provider APIs; no hardcoded models; LM Studio auto-detection; `claude-code` manages its own models
- **Custom Tool Widgets**: see [/docs/CUSTOM_TOOL_WIDGETS.md](/docs/CUSTOM_TOOL_WIDGETS.md) for replacing the generic tool call display

## Linear Integration

The Linear MCP integration uses the "NIM" project for issue tracking.
