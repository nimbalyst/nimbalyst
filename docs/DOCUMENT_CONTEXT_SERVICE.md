# DocumentContextService Business Logic

This document describes the business logic of `DocumentContextService`, a session-aware service that prepares document context for AI providers.

## Purpose

DocumentContextService answers the question: **"What document context should we send to the AI provider for this message?"**

It optimizes context delivery by:
1. Tracking document state changes between messages
2. Sending diffs instead of full content when appropriate
3. Injecting mode-specific instructions (e.g., plan mode)

## Location

- **Implementation**: `packages/runtime/src/ai/services/DocumentContextService.ts`
- **Types**: `packages/runtime/src/ai/services/types.ts`
- **Tests**: `packages/runtime/src/ai/services/__tests__/DocumentContextService.test.ts`

## Core Concept: Document Transitions

Every time a user sends a message, the service determines what changed since the last message in that session:

| Transition | Meaning | When It Occurs |
| --- | --- | --- |
| `opened` | User started viewing a file | First message with a file, or file opened after being closed |
| `closed` | User stopped viewing any file | Had a file before, now has none |
| `switched` | User changed to a different file | File path differs from cached state |
| `modified` | User edited the current file | Same file, but content hash changed |
| `none` | Nothing changed | Same file with identical content, or no file in either state |

### Transition State Machine

```
Initial State (no cached state for session)
  ├─ Message has file → 'opened'
  └─ Message has no file → 'none'

Cached State Exists
  ├─ Message has no file
  │   └─ Previous had file → 'closed'
  ├─ Different file path → 'switched'
  ├─ Same file, same content hash → 'none'
  └─ Same file, different content hash → 'modified'
```

## Content Optimization Strategy

### Hashing for Change Detection

The service uses a fast djb2 hash to detect content changes without expensive string comparisons:

```typescript
// Only hash once per file version
const hash = hashContent(content);
// Compare hashes to detect changes
if (currentHash !== cachedHash) → 'modified'
```

### Content Handling by Transition

The service decides what to send based on the transition type and provider:

| Transition | Content Sent | Rationale |
| --- | --- | --- |
| `none` | Nothing (omit content) | AI already has the context from previous message |
| `opened` | Full content | New file, AI needs full context |
| `switched` | Full content | Different file, AI needs full context |
| `modified` (claude-code, small diff) | Diff only | Efficient update of what changed |
| `modified` (claude-code, large diff) | Full content | Diff is larger than content |
| `modified` (other providers) | Full content | Providers can't parse diffs |
| `closed` | Nothing | No document to send |

**Why `none` transition omits content:**
- The AI already received the full content on a previous message
- Sending duplicate content wastes tokens
- The `documentTransition: 'none'` field tells the AI nothing has changed

**Why only Claude Code gets diffs:**
- Claude Code uses MCP tools that can parse diffs and make surgical edits
- Other providers (Claude Chat, OpenAI, etc.) need full content for context
- Token efficiency: diffs are often much smaller than full content

## Session State Management

Each session maintains independent document state in memory:

```typescript
private lastDocumentStateBySession: Map<string, DocumentState>

interface DocumentState {
  filePath: string;
  content: string;        // Full content (for diff computation)
  contentHash: string;    // djb2 hash for fast comparison
}
```

**Key behaviors:**
- State is automatically updated on every `prepareContext()` call
- State is automatically cleared when transition is `closed`
- State can be manually cleared via `clearSessionState(sessionId)`
- Multiple sessions can track different files simultaneously

### Persistence Across Restarts

Session document state is persisted to the database to enable transition detection across app restarts:

```typescript
// Persisted state (stored in ai_sessions.last_document_state)
interface PersistedDocumentState {
  filePath: string;
  contentHash: string;    // Only hash is stored, NOT content
}
```

**Storage location:** `ai_sessions.last_document_state` JSONB column

**How it works:**
1. On every state change, the service persists `{ filePath, contentHash }` to the database
2. When a session is loaded, `AIService` calls `loadPersistedState()` to restore cached state
3. The service can detect if the file is unchanged (same hash) or modified (different hash)

**Limitation:** Since only the hash is persisted (not full content), the service cannot compute diffs for the first message after an app restart. Instead:
- If file unchanged (same hash): Transition is `'none'`
- If file modified (different hash): Transition is `'modified'`, but full content is sent (no diff available)

This is a deliberate trade-off to keep database storage small while preserving transition detection across restarts.

## Text Selection Normalization

The service normalizes multiple legacy selection formats into a simple string:

**Input formats accepted (priority order):**
1. String: `textSelection: "selected text"` with `textSelectionTimestamp` for staleness
2. Object: `textSelection: { text, filePath, timestamp }`
3. Object: `selection: { text, filePath, timestamp }`
4. Legacy string: `selection: string`

**Output format:**
```typescript
textSelection: string  // Just the selected text
```

The `filePath` is omitted because it's always the open document (already available in `documentContext.filePath`). Staleness detection uses `textSelectionTimestamp` at the document context level.

## Plan Mode Instructions

When entering or exiting plan mode, the service injects special instructions:

### Entering Plan Mode

Injects a `<PLAN_MODE_ACTIVATED>` block containing:
- Restrictions (no code edits, read-only tools only)
- Requirements (create plan file, use exploratory tools)
- YAML frontmatter template for standardized plan documents
- Workflow instructions for iterative planning

### Exiting Plan Mode

Injects a `<PLAN_MODE_DEACTIVATED>` notice indicating planning restrictions no longer apply.

## API

### `prepareContext(rawContext, sessionId, providerType, modeTransition?)`

Main entry point called on every AI message.

**Parameters:**
- `rawContext`: Document content from renderer (may be undefined)
- `sessionId`: Session identifier for state tracking
- `providerType`: One of `'claude' | 'claude-code' | 'openai' | 'openai-codex' | 'lmstudio'`
- `modeTransition`: Optional info about entering/exiting plan mode

**Returns:**
```typescript
{
  documentContext: PreparedDocumentContext;    // Optimized context for provider
  userMessageAdditions: UserMessageAdditions;  // Special prompt additions
}
```

### `clearSessionState(sessionId)`

Manually clears cached state for a session. Use when:
- Session ends
- User explicitly closes document
- Need to treat next file as "opened" again

### `getSessionState(sessionId)`

Returns cached `DocumentState` for debugging/testing purposes.

### `loadPersistedState(sessionId, state)`

Loads persisted document state from the database into memory. Called by `AIService` when a session is loaded.

**Parameters:**
- `sessionId`: Session identifier
- `state`: Persisted state with `{ filePath, contentHash }`

**Note:** Content is set to empty string since only the hash is persisted. This means diffs cannot be computed for the first message after restart.

### `setPersistCallback(callback)`

Sets the callback function for persisting state changes to the database.

**Callback signature:**
```typescript
(sessionId: string, state: PersistedDocumentState | null) => Promise<void>
```

Called with `null` when document is closed (to clear persisted state).

## Integration

### Primary Consumer: AIService

`AIService` in the Electron main process:
1. Instantiates `DocumentContextService` as a singleton
2. Sets up persistence callback to save state to database
3. Loads persisted state when sessions are loaded via `ai:loadSession`
4. Calls `prepareContext()` on every message send
5. Merges prepared context with session metadata
6. Passes to AI provider

### Related Components

| Component | Relationship |
| --- | --- |
| `documentDiff.ts` | Provides `hashContent()` and `computeDiff()` utilities |
| `useDocumentContext.ts` | Renderer hook that builds raw context sent to main process |
| `AIService.ts` | Consumes prepared context for AI message construction |
| `PGLiteSessionStore.ts` | Reads/writes `last_document_state` column |
| `AISessionsRepository.ts` | Provides `updateMetadata()` for persistence |

## Design Principles

1. **Per-session isolation**: Each session tracks its own document state independently
2. **Provider awareness**: Optimizations are tailored to provider capabilities
3. **Backward compatibility**: Multiple selection formats are normalized seamlessly
4. **Fail-safe defaults**: When in doubt, send full content (always correct, just less optimal)
5. **Single responsibility**: Only handles document context - system prompts, attachments, and IPC are elsewhere
