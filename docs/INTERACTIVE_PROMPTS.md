# Interactive Prompts Architecture

When Claude needs user input (AskUserQuestion, ExitPlanMode, GitCommitProposal, ToolPermission), Nimbalyst uses a **durable prompts architecture** where the database is the source of truth.

## Key Principles

1. **Widgets render from tool call data** - Interactive widgets receive `toolCall.id`, `toolCall.arguments`, and `toolCall.result` directly from the message
2. **No ephemeral state for prompts** - Prompts survive session switches and app restarts
3. **`nimbalyst_tool_use` messages** - For tools intercepted before `tool_use` block exists (AskUserQuestion), we log our own message type that SessionManager parses into standard `toolCall` objects
4. **InteractiveWidgetHost pattern** - Widgets access callbacks, analytics, and IPC through an atom-based host, not prop drilling

## Current Implementation

| Prompt Type | Implementation | Message Type |
| --- | --- | --- |
| AskUserQuestion | `AskUserQuestionWidget` | `nimbalyst_tool_use` |
| PromptForUserInput | `RequestUserInputWidget` | MCP `tool_use` |
| ExitPlanMode | `ExitPlanModeWidget` | SDK `tool_use` |
| GitCommitProposal | `GitCommitConfirmationWidget` | MCP `tool_use` |
| ToolPermission | `ToolPermissionConfirmation` (legacy) | DB-backed atom |

## PromptForUserInput

`PromptForUserInput` is the generic structured-input tool. `One MCP call carries one or more typed fields composed in a single prompt, all rendered by RequestUserInputWidget.`

**Why the wire-name isn't `RequestUserInput`:** the Codex CLI binary ships with its own built-in tool named `request_user_input` (gated to Plan mode). When our MCP server advertises `RequestUserInput`, Codex matches it against its built-in (snake_case match) and refuses the call in Default mode with `request_user_input is unavailable in Default mode`. The wire-name `PromptForUserInput` snake-cases to `prompt_for_user_input`, which is unique. Internal type names, IPC channels, atom keys, and promptType discriminators still use `request_user_input` — they're never seen by Codex.

**Field types:**

- `multiSelect` — checkbox list with rich rows (title, subtitle, badge, defaultChecked). Use for "pick a subset".
- `singleSelect` — radio group with optional "Other" textarea fallback.
- `reorder` — drag-to-reorder list with optional per-item delete affordance (`removable: true`). Answer payload returns `orderedIds` AND `removedIds` so the agent can act on both.
- `editText` — inline Lexical editor seeded with markdown or plain text. Compact mode (no slash-menu, basic toolbar). The answer carries the serialized text plus an `edited` boolean.
- `confirm` — single yes/no toggle.

**Flow:**

1. Agent calls `mcp__nimbalyst-mcp__RequestUserInput` with `{ fields: [...] }`.
2. The MCP handler in `interactiveToolHandlers.ts` persists the SDK's `tool_use` chunk via the standard streaming path, fires `ai:requestUserInput` so voice mode can pick up the data, and waits for a response on `request-user-input-response:<sessionId>:<promptId>` with a DB-polling fallback.
3. The widget renders pending state from `toolCall.arguments`; user edits live in `requestUserInputDraftAtom(toolCallId)` so they survive virtual-scroll and session switches.
4. On submit/cancel, the widget calls `host.requestUserInputSubmit(promptId, answers)` / `host.requestUserInputCancel(promptId)`. The desktop host invokes `messages:respond-to-prompt` with promptType `request_user_input_request`, which writes a `request_user_input_response` row, fires the IPC channel, and clears the pending indicator.
5. The MCP handler resolves and the agent receives the answer payload.

**Voice mode:** the renderer computes a `voiceFriendly` hint (NOT trusted from the agent) and forwards it via `voice-mode:interactive-prompt`. Reorder fields > 6 items and editText with > 240 char drafts are flagged as not voice-friendly so the agent defers to the screen.

## Widget Pattern (preferred)

```typescript
// Widget receives toolCall from message props
const { toolCall, sessionId } = props;
const host = useAtomValue(interactiveWidgetHostAtom(sessionId));

// Check pending state from tool call result
const isPending = !toolCall.result;

// Get data from tool call arguments
const { questions } = toolCall.arguments;

// Respond via host (which calls IPC)
await host.askUserQuestionSubmit(toolCall.id, answers);
```

## Key Files

- `packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/` - Widget implementations
- `packages/runtime/src/store/atoms/interactiveWidgetHost.ts` - Host atom pattern

## Adding New Interactive Prompts

1. Define the tool in the appropriate MCP server or SDK tool list
2. Create a custom widget in `CustomToolWidgets/`
3. Register the widget in the tool widget registry
4. Use the `InteractiveWidgetHost` pattern for callbacks
5. Ensure the widget reads state from `toolCall.result` (not local state)
