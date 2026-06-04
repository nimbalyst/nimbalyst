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
