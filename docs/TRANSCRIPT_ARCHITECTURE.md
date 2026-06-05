# Transcript Architecture

How AI session transcripts are stored, transformed, and rendered.

## Storage model

| Layer | Where | Purpose |
|-------|-------|---------|
| Raw provider payloads | `ai_agent_messages` (PGLite / SQLite) | Append-only source of truth. Provider-native shapes preserved exactly. |
| Searchable text + kind | `ai_agent_messages.searchable_text` / `.message_kind` columns | Extracted at write time so the raw table can serve FTS and cross-session lookups directly. |
| Canonical events | In-memory, per-session, MRU-evicted (cap 16) | Held by `TranscriptRuntime` for the lifetime of an open session tab. Discarded when the tab closes; rebuilt on demand from raw. |

The raw `ai_agent_messages` log is the sole persisted source of truth. Canonical events are derived from it on first access and never written to disk.

## Data flow

```
Provider SDK (Claude Code, Codex, OpenCode)
    |
    v
Provider writes raw chunk to ai_agent_messages
   (searchable_text + message_kind extracted in-line by
    searchableTextExtractor before the row is enqueued)
    |
    v
TranscriptRuntime.processNewMessages reads new raw rows (watermark)
    |
    v
Per-provider parser (ClaudeCodeRawParser / CodexRawParser / ...)
produces CanonicalEventDescriptors
    |
    v
Transformer processes descriptors via TranscriptWriter into the
per-session InMemoryTranscriptEventStore held by the runtime
    |
    v
onEventWritten callback fires (IPC to renderer)
    |
    v
TranscriptProjector projects events into TranscriptViewMessages
    |
    v
RichTranscriptView renders the UI
```

## Key components

All located in `packages/runtime/src/ai/server/transcript/` unless noted.

### TranscriptRuntime

(Phase 3 rename of the old `TranscriptMigrationService`. The legacy class name is preserved as a thin shim for backwards compatibility but new code should import `TranscriptRuntime` directly.)

The central component. Holds a per-session `InMemoryTranscriptEventStore` cache (MRU eviction, default cap N=16) and an in-memory watermark store. Exposes:

- `getCanonicalEvents(sessionId, provider)` -- ensures the session's events are built, returns them
- `getViewMessages(sessionId, provider)` -- chains events through `TranscriptProjector`
- `processNewMessages(sessionId, provider)` -- incremental processing during streaming
- `getTailEvents(sessionId, provider, count)` -- efficient tail slice for previews
- `findToolCallByProviderId(sessionId, providerToolCallId, provider)` -- correlation lookup used by ToolCallMatcher
- `forceReparseSession(sessionId, _provider)` -- evicts the in-memory cache so the next read rebuilds
- `setOnEventWritten(cb)` -- wires the real-time IPC notification

### TranscriptTransformer

The watermark + parser pipeline driver. Same contract as before, but its `transcriptStore` is now a routing facade backed by the runtime's per-session in-memory cache, and its `metadataStore` is an in-memory implementation. There is no persisted watermark.

### Per-provider parsers

Located in `packages/runtime/src/ai/server/transcript/parsers/`. Unchanged.

| Parser | Provider(s) | Handles |
|--------|-------------|---------|
| `ClaudeCodeRawParser` | `claude-code` | SDK chunks: `assistant`, `text`, `tool_use`, `tool_result`, `error`, `nimbalyst_tool_use/result`, subagent spawns |
| `CodexRawParserDispatcher` -> `CodexRawParser` / `CodexAppServerRawParser` | `openai-codex` | Per-message dispatch based on `metadata.transport` |
| `CodexACPRawParser` | `openai-codex-acp` | ACP wire format |
| `CopilotRawParser` | `copilot-cli` | Copilot CLI |
| `OpenCodeRawParser` | `opencode` | AgentProtocol events |

Parsers implement `IRawMessageParser` and are **pure functions** over a single raw message. They return canonical descriptors; they never write to storage.

### searchableTextExtractor

`packages/runtime/src/ai/server/transcript/searchableTextExtractor.ts`. Per-row extractor that runs on the write path inside `AIProvider.logAgentMessage` / `logAgentMessageNonBlocking`. Produces `{ searchableText: string | null, messageKind: 'user' | 'assistant' | 'tool' | 'system' | 'meta' }` directly from the raw payload. The result is persisted on the same row so FTS and cross-session "list user prompts" style queries don't need a derived table.

### TranscriptWriter

Same as before -- shared service used by the transformer for emitting canonical events through the runtime's routing store. Owns sequence assignment and assistant_message coalescing.

### TranscriptProjector

Pure function projecting `TranscriptEvent[]` into a `TranscriptViewModel` for UI rendering. Groups tool progress under parent tool calls, nests subagent child events, and attaches turn-ended metadata.

## Search

FTS now runs over the raw table:

| Backend | Index |
|---------|-------|
| SQLite | `ai_agent_messages_fts` (FTS5 external content, indexes `searchable_text`, triggers skip NULL rows) |
| PGLite | Partial GIN index `idx_ai_agent_messages_searchable_text_fts` on `to_tsvector('english', searchable_text)` WHERE `searchable_text IS NOT NULL` |

Search call sites:
- `SQLiteStoreAdapter.searchTranscriptEventSessions` / `.searchTranscriptEvents` route through the new index. The `eventType` argument is mapped to `message_kind` (`user_message` -> `user`, `assistant_message` -> `assistant`).
- `PGLiteSessionStore.search` queries `ai_agent_messages.searchable_text` directly with `message_kind` filters.

## Provider integration

Providers write raw messages via `logAgentMessage()` / `logAgentMessageNonBlocking()` (defined in `AIProvider.ts`). The extractor runs in-line so every row lands with `searchable_text` + `message_kind` populated. Providers do **not** write canonical events directly.

`ClaudeCodeProvider` additionally drops transient SDK chunks (`hook_started`, `task_progress`, `tool_progress`, `auth_status`, `rate_limit_event`, `task_started`, `task_notification`, `hook_response`, `tool_use_summary`) at the write site via `isTransientClaudeCodeChunk()`. Existing rows of these types are cleaned up by `AgentMessagesBackfill` on next startup.

### Chunk parser adapters

Each provider also uses a chunk parser adapter that converts SDK-specific streaming chunks into typed `ParsedItem[]` for the provider's streaming yield loop. These adapters are separate from the raw message parsers and exist only for the live yield loop.

## Real-time updates

`processNewMessages` is called after each raw write. It reads everything past the in-memory watermark, runs the parser, writes canonical events into the session's `InMemoryTranscriptEventStore`, and fires `onEventWritten` once per event. The Electron main process forwards those events to renderer windows over `transcript:event` IPC.

## Mobile sync

Mobile sync works naturally:

1. Mobile writes a raw message (e.g., permission response) to the sync server
2. Desktop receives it via `messageBroadcast` and writes to local `ai_agent_messages`
3. The next `processNewMessages` / `getCanonicalEvents` call picks it up via the watermark

iOS already runs `TranscriptTransformer` locally against `InMemoryTranscriptEventStore`, so adding a new provider continues to require a new iOS build.

## Force reparse

`transcript:force-reparse-session` (dev-only IPC) evicts the session from the runtime's in-memory cache. The next read rebuilds the canonical events from raw. The IPC also fires `transcript:session-reparsed` to nudge any open renderer view.

## Cross-session queries

The cross-session "list all user prompts" query that used to scan `ai_transcript_events` now reads `ai_agent_messages` directly:

```sql
SELECT t.searchable_text, t.session_id, t.created_at, s.title, s.provider
FROM ai_agent_messages t
JOIN ai_sessions s ON t.session_id = s.id
WHERE t.message_kind = 'user'
  AND t.searchable_text IS NOT NULL
  AND s.workspace_id = $1
ORDER BY t.created_at DESC
LIMIT $2
```

`packages/electron/src/main/mcp/sessionContextServer.ts` uses the same pattern for per-session prompt and assistant-message fetches.

## File locations

```
packages/runtime/src/ai/server/transcript/
  TranscriptTransformer.ts        -- Watermark + parser pipeline driver
  TranscriptWriter.ts             -- Canonical event writer
  TranscriptProjector.ts          -- Event -> view model projection
  TranscriptRuntime.ts            -- Per-session in-memory cache (Phase 3)
  TranscriptMigrationService.ts   -- Backwards-compat shim around TranscriptRuntime
  searchableTextExtractor.ts      -- Write-time extractor (Phase 1B)
  InMemoryTranscriptEventStore.ts -- Backing store for each cached session
  types.ts                        -- Canonical event types
  parsers/
    IRawMessageParser.ts          -- Parser interface + descriptor types
    ClaudeCodeRawParser.ts
    CodexRawParser.ts
    CodexACPRawParser.ts
    CopilotRawParser.ts
    OpenCodeRawParser.ts
  __tests__/
    TranscriptTransformer.test.ts
    TranscriptRuntime.test.ts
    searchableTextExtractor.test.ts
    ClaudeCodeRawParser.test.ts
    ...

packages/electron/src/main/services/
  RepositoryManager.ts            -- Wires the runtime + onEventWritten + backfill
  TranscriptMigrationAdapters.ts  -- Raw-message store adapter
  AgentMessagesBackfill.ts        -- Startup pass that populates searchable_text/message_kind
                                     on legacy rows and deletes transient claude-code chunks

packages/electron/src/main/database/sqlite/schemas/
  0001_initial.sql                 -- Consolidated end-state schema
  0002_pending_files_index.sql
  0003_searchable_text_message_kind.sql -- Phase 1A: column additions
  0004_fts_on_searchable_text.sql       -- Phase 2: switch FTS to searchable_text
  0005_drop_transcript_events.sql       -- Phase 4: drop canonical-events table
```

## Historical note

Prior to the canonical-transcript-deprecation refactor (June 2026), canonical events were persisted in `ai_transcript_events` with an FTS5 mirror in `ai_transcript_events_fts`, and `ai_sessions` carried `canonical_transform_*` watermark columns. The table and columns are dropped by migration 0005 (SQLite) and the equivalent forward-only block in `worker.js` (PGLite); no rollback path exists. See `nimbalyst-local/plans/canonical-transcript-deprecation.md` for the rationale.
