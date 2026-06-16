# Gemini extension-agent as a Meta Agent: integration notes

How the `antigravity-gemini-agent` extension provider was made to work as a nimbalyst meta-agent, on par with the built-in `claude-code` and `openai-codex` providers. Branch: `feat/gemini-marketplace-fresh`.

## The governing principle

The extension-agent meta-agent path runs parallel to the built-in providers. Built-ins enforce a set of gates; the extension path was built without them, and every meta-agent bug here was a missing built-in constraint. The rule for any future change: **mirror what the built-in providers do, do not invent a separate mechanism for the extension path.** Built-in behavior is defined by:

- Tools: discovered over the SSE MCP server, gated by `BaseAgentProvider.META_AGENT_ALLOWED_TOOLS` (packages/runtime). That allowlist OMITS `spawn_session`.
- Meta-agent persona: `buildMetaAgentSystemPrompt` (packages/runtime/src/ai/prompt.ts), which references only `create_session`.
- Children: created by `create_session` with `createdBySessionId = meta-agent`, `agentRole='standard'`, no workstream container.

## How the extension path is wired (and gated)

- `MessageStreamingHandler` builds `isMetaAgentExtensionSession = isExtensionAgentSession && session.agentRole === 'meta-agent'` and gates BOTH the tool set (`getMetaAgentOpenAITools()`) and the persona (`buildMetaAgentSystemPrompt`) on it. Standard child sessions get neither, so a child cannot spawn (no recursion) and a plain chat session is unaffected.
- `getMetaAgentOpenAITools()` (packages/electron/src/main/mcp/metaAgentServer.ts) filters `META_AGENT_TOOL_DEFS` to `EXTENSION_META_AGENT_ALLOWED_TOOLS`, a mirror of the built-in allowlist. It OMITS `spawn_session`. This is the load-bearing fix for clean nesting: `spawn_session` is the only path that creates a `sessionType='workstream'` container, which reparents the child and pulls it out of the META AGENT group. With it gone, the gemini meta-agent spawns via `create_session` and its child nests directly under it.
- A non-dev-capable (extension) meta-agent's spawned child is forced to `claude-code` (post-resolution force in `MetaAgentService.createChildSessionInternal`, gated on `resolveExtensionAgentRef(parentProvider) && resolveExtensionAgentRef(resolvedProvider)`). A chat-only gemini child cannot run commands or edit files, so the meta-agent delegates real work to a dev-capable child. Explicit dev providers are honored.
- `getMetaAgentOpenAITools()` and the persona are forwarded to the backend through a widened `sendMessage`/bridge contract (`ExtensionAgentProvider`, `extensionAgentBridge`); the backend (`agent.ts`) consumes `input.systemPrompt`, and `ToolLoopProtocol.buildInstructedSystemPrompt` places it ahead of the tool block. Antigravity has no native function-calling, so tools are simulated via a `{"tool_call":{...}}` JSON envelope the model is instructed to emit.

## Backstops

- A total per-parent spawn cap (`TOTAL_SPAWN_CAP = 15`, counts all children regardless of status) bounds runaway sequential spawning from completion-wakeups.
- Feeder cuts: the parent is not re-woken on a child ERROR settle (`AIService.onAfterSettled` captures the child status in `onChainSettled` before `endSession` evicts it; `handleChildSessionEvent` gates its re-trigger with `eventType !== 'session:error'`).

## Result-capture note (codex, related)

`get_session_result` reads the child's last assistant `output` row from `ai_agent_messages` via `metaAgentMessageText.extractMessageText`. The codex app-server transport persists assistant text as `{method:'item/completed', params:{item:{type:'agentMessage', text}}}`; the extractor was taught that envelope so codex children's results are not reported as `lastResponse: null`.

## Gotchas for development

- The isolated dev launch builds `packages/electron/out2/main/index.js` (outDir is relative to the cd'd electron dir). Verify any backend fix is live by grepping that bundle, not the source.
- Editing the extension backend (`agent.ts`, `ToolLoopProtocol.ts`) needs `npm run build` (vite) in this package; editing electron-main/runtime is rebuilt by the dev relaunch.
- The isolated profile uses SQLite (synchronous, main-thread). A bloated DB blocks the event loop and crashes the app; reset it if it grows large.

## Phase 1: read-only dev tools for standard sessions

A standard (non-meta-agent) gemini session now gets a read-only dev toolset so the model can investigate the workspace through the SAME simulated tool loop. This mirrors the built-in providers: a standard session has file tools, only a meta-agent session has orchestration tools. The tools are `read_file`, `list_files`, and `search_files`. Write/edit and shell are deliberately absent (Phase 2 and Phase 3).

How it is wired:

- `getDevAgentOpenAITools()` / `dispatchDevAgentTool()` live in `packages/electron/src/main/mcp/devAgentTools.ts` and delegate to `ElectronFileSystemService` (read with optional line range and 1MB cap, glob list, ripgrep search). Output is capped at 48000 characters.
- `MessageStreamingHandler` gives a standard extension session (`agentRole !== 'meta-agent'`) the dev tools plus `buildDevAgentSystemPrompt` (a coding persona, role text only). The meta-agent and built-in paths are unchanged. A standard session previously ran with an empty system prompt and no tools, so this is additive.
- The backend (`agent.ts` `makeSessionExecutor`) routes `DEV_AGENT_TOOL_NAMES` to `ctx.services.devToolExecutor`; everything else goes to the orchestration `toolExecutor`.

Security model (least privilege, and the hardening that came out of an adversarial review of this change):

- Dev tools dispatch over a NEW broker method `devToolExecutor` gated on the minimal `workspace-files` permission, NOT the high-risk `nimbalyst-database-write` that meta-agent orchestration needs. The host derives the permission from the method name (anti-forge: never from the backend-supplied tool name) and pins the jail root to its bound `ctx.workspacePath`. The `devToolExecutor` payload carries no path, so a backend cannot redirect file access.
- `ElectronFileSystemService.searchFiles` terminates ripgrep option parsing with `--` before the query. Without it, a query like `--pre=<binary>` is parsed as the ripgrep preprocessor flag and runs an arbitrary binary (argv-injection RCE). `execFile` blocks shell metacharacters but not argv injection; `--` blocks argv injection.
- `dispatchDevAgentTool` resolves real paths and re-checks workspace containment before reading or listing. This closes the symlink jail-escape that the string-only `SafePathValidator` leaves open (a symlink inside the workspace pointing at, say, `~/.ssh` would otherwise be followed). It is scoped to the dev-tool path so shared consumers (e.g. pnpm's symlinked `node_modules`) keep their existing behavior.

Reliability note: the dev persona tells the model to emit a tool call rather than narrate the action in prose, since the loop treats a prose-only turn as a final answer (no retry). This is the lower-risk mitigation; the shared `run()` loop is left untouched because the meta path depends on it.

Consent note: the manifest now declares `workspace-files` for the backend module, so an already-consented user sees a one-time re-consent prompt. Declining it disables the module per the existing all-or-nothing module-consent model.
