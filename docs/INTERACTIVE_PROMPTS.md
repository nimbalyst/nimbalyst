# Interactive Prompts

Nimbalyst treats interactive prompts as durable transcript state, not transient UI state. If an agent asks the user a question, proposes a commit, or requests structured input, the prompt must survive remounts, session switches, and process restarts.

This document describes the current architecture, with special attention to Codex. The important lesson from the recent `PromptForUserInput` failures is that prompt correlation must be centralized. Widget rendering, response persistence, and MCP waiters cannot each invent their own prompt id rules.

## Core Rules

1. The database is the durable source of truth for prompt requests and responses.
2. Widgets render from transcript tool-call data, not from ephemeral local state.
3. Response routing must tolerate multiple valid ids for the same Codex prompt.
4. Codex-specific prompt-id resolution lives in one shared helper:
   `packages/electron/src/main/mcp/tools/codexToolCallResolver.ts`

## Prompt Types

| Prompt Type | Tool / Entry Point | Widget / UI Path | Durable Response Row |
| --- | --- | --- | --- |
| Ask user question | `AskUserQuestion` | `AskUserQuestionWidget` | `ask_user_question_response` |
| Structured user input | `PromptForUserInput` | `RequestUserInputWidget` | `request_user_input_response` |
| Exit plan mode | `ExitPlanMode` | `ExitPlanModeWidget` | `exit_plan_mode_response` |
| Git commit approval | `developer_git_commit_proposal` | `GitCommitConfirmationWidget` | `git_commit_proposal_response` |
| Tool permission | permission flow | permission UI | `permission_response` |

## Codex Prompt Identity

Codex can expose the same prompt through more than one identifier:

1. Raw tool-call id: `call_...`
   This is the most important id. It is what Codex app-server emits for the MCP tool call when available.
2. Synthetic transcript id: `nimtc|call_...|<timestamp>|<index>`
   This is a durable lookup id used by transcript projection because raw Codex ids are not globally unique across turns.
3. Local fallback waiter id: `rui-<sessionId>-<timestamp>`
   This is only used when the MCP server cannot recover a raw tool-call id. It exists to keep the request blocking instead of failing open.

These ids are aliases for the same prompt, not independent identities.

## Why `PromptForUserInput` Uses That Wire Name

Codex already ships with a built-in `request_user_input` tool that is restricted to Plan mode. If our MCP server advertises `RequestUserInput`, Codex snake-cases it to the same built-in name and may reject the call in Default mode.

`PromptForUserInput` snake-cases to `prompt_for_user_input`, which avoids that collision. Internal prompt types, response rows, IPC channels, and widget code still use `request_user_input`.

## Shared Codex Correlation Utilities

Use these helpers instead of reimplementing prompt-id logic:

- `extractToolUseIdFromMcpRequest(request)`
  Reads direct provider metadata such as `openai/toolCallId`.
- `resolveToolUseIdFromMcpRequest(request, sessionId, toolName)`
  Falls back to Codex turn metadata plus recent `item/started` events when `_meta` does not contain a raw tool-call id.
- `resolveRequestUserInputPromptTargets(promptId)`
  Expands a renderer prompt id into every id the waiter and DB should match, including the raw `call_...` alias behind a synthetic `nimtc|...` id.

Current implementation:

- Shared helper: `packages/electron/src/main/mcp/tools/codexToolCallResolver.ts`
- Synthetic/raw alias utilities: `packages/runtime/src/ai/server/toolLookupIds.ts`

## RequestUserInput Flow

1. The agent calls `PromptForUserInput`.
2. `interactiveToolHandlers.ts` resolves the blocking prompt id through `resolveToolUseIdFromMcpRequest(...)`.
3. The MCP handler waits on:
   - exact channel: `request-user-input-response:<sessionId>:<promptId>`
   - fallback channel: `request-user-input-response:<sessionId>:__fallback__`
4. The transcript renders the prompt from the tool call. Draft edits live in renderer state keyed by the tool call id, but completion is determined by durable transcript/result state.
5. On submit or cancel, the renderer or mobile client sends `messages:respond-to-prompt`.
6. `SessionHandlers.ts` persists a `request_user_input_response` row with:
   - `promptId`
   - `rawPromptId` when the submitted id has a raw Codex alias
   - `answers`
   - `cancelled`
7. After persistence, the desktop/mobile response path tries to wake the MCP waiter:
   - first by exact waiter channels for all known aliases
   - then by the session-scoped fallback channel if no exact waiter exists
8. The MCP waiter resolves from IPC immediately when possible, or from DB polling if IPC was dropped.

## Why The Session Fallback Channel Exists

Codex does not always provide a direct tool-call id in MCP `_meta`. In that case, the MCP waiter may have to block on a temporary `rui-...` id before the real `call_...` id is recoverable.

If the renderer later submits a response using a synthetic `nimtc|...` id, exact channel matching alone is not enough. The session fallback channel lets a blocked waiter recover even when its local fallback id does not match the renderer's final id shape.

This fallback is intentionally narrow:

- It is scoped to one session.
- It is only used if no exact waiter channel matches.
- For `RequestUserInput`, the waiter still validates ids when possible and only accepts unrelated ids outright when it is already blocked on a synthetic `rui-...` fallback id.

## Durable Rendering Rules

Interactive widgets should follow these rules:

1. Render from `toolCall.arguments` and `toolCall.result`.
2. Treat missing `toolCall.result` as pending.
3. Do not rely on component-local state to determine whether the prompt is completed.
4. If a draft state is needed for editing, key it by the transcript tool-call id and treat it as disposable UI state, not the source of truth.

## Adding Or Updating A Prompt

When adding a new interactive prompt, keep the correlation path unified:

1. Define the tool and its durable response message shape.
2. Render the widget from transcript tool-call data.
3. Persist responses before or alongside any best-effort IPC wakeup.
4. If Codex is involved, reuse the shared resolver instead of parsing `_meta` or synthetic ids locally.
5. If the prompt blocks an MCP call, decide what the fallback wakeup path is before shipping it.
6. Add at least one regression test that covers the full request -> persist response -> waiter resume path.

## What Broke Before

The `PromptForUserInput` failures came from having three prompt identities with no single source of truth:

- the MCP waiter could block on `rui-...`
- the transcript could render `nimtc|call_...|...`
- the durable response row could be written under `call_...`

That caused two user-visible failures:

1. submitting answers did not resume the blocked Codex session
2. remounting the transcript could lose the apparent completion state

The current architecture fixes that by:

- centralizing Codex prompt-id recovery
- treating raw and synthetic ids as aliases
- persisting both `promptId` and `rawPromptId` where needed
- adding a session-scoped fallback wakeup path for blocked `RequestUserInput` flows

## Key Files

- `packages/electron/src/main/mcp/tools/codexToolCallResolver.ts`
- `packages/electron/src/main/mcp/tools/interactiveToolHandlers.ts`
- `packages/electron/src/main/ipc/SessionHandlers.ts`
- `packages/electron/src/main/services/ai/MobileSessionControlHandler.ts`
- `packages/runtime/src/ai/server/toolLookupIds.ts`
- `packages/electron/src/main/mcp/__tests__/requestUserInputLifecycle.test.ts`
- `packages/electron/src/main/mcp/__tests__/codexToolCallResolver.test.ts`
