/**
 * searchableTextExtractor -- derives `searchable_text` and `message_kind` for
 * an `ai_agent_messages` row from its raw provider payload.
 *
 * Runs at insert time (in the AIProvider write path) and during the backfill
 * pass. Output mirrors what `TranscriptTransformer` would have emitted for the
 * same row at read time -- one searchable string per row, plus a stable
 * provider-agnostic classification.
 *
 * The extractor is deliberately simpler than the full canonical parsers: it
 * does not need cross-row state (tool ID maps, subagent tracking, parser-level
 * deduplication). For rows that produce multiple canonical events (e.g. an
 * assistant message containing both text and a tool_use), the extractor
 * collapses them to a single searchable string and a single kind, prioritizing
 * user > assistant > tool > system > meta.
 *
 * The kinds mean the same thing for every provider: `tool` is a tool call or
 * its output, `system` is a provider lifecycle or error frame, and `meta` is
 * only a row nothing renders. Retention and search select on this column, so
 * a provider that files tool output under `meta` hides it from both.
 *
 * See plan: `nimbalyst-local/plans/canonical-transcript-deprecation.md`.
 */

import {
  CODEX_APP_SERVER_STATUS_EVENT_TYPES,
  CODEX_APP_SERVER_SUPERSEDED_DELTA_METHODS,
} from '../../../storage/nonRenderingFrames';
import {
  isAppServerToolItem,
  isNonRenderingAppServerItemStarted,
} from './parsers/CodexAppServerRawParser';

export type MessageKind = 'user' | 'assistant' | 'tool' | 'system' | 'meta';

export interface ExtractedSearchable {
  searchableText: string | null;
  messageKind: MessageKind;
}

export interface ExtractorInput {
  source: string;
  direction: 'input' | 'output';
  content: string;
  metadata?: Record<string, unknown> | null;
  hidden?: boolean;
}

const SYSTEM_REMINDER_RE = /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/;

function isSystemReminder(text: string, metadata?: Record<string, unknown> | null): boolean {
  if (metadata && metadata.promptType === 'system_reminder') return true;
  return SYSTEM_REMINDER_RE.test(text);
}

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function nonEmpty(s: string | null | undefined): string | null {
  if (s == null) return null;
  const trimmed = String(s);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Apply a hard cap on the searchable text the FTS index sees. 500KB matches
 * the legacy `logAgentMessage` `searchable` guard so a single pathological row
 * can't blow out the tsvector / FTS5 segment.
 */
const MAX_SEARCHABLE_LEN = 500_000;
function capLen(s: string | null): string | null {
  if (s == null) return null;
  return s.length > MAX_SEARCHABLE_LEN ? s.slice(0, MAX_SEARCHABLE_LEN) : s;
}

// ---------------------------------------------------------------------------
// Provider-specific extraction
// ---------------------------------------------------------------------------

function extractClaudeCodeInput(parsed: unknown, content: string, metadata?: Record<string, unknown> | null): ExtractedSearchable {
  if (parsed && typeof parsed === 'object' && 'prompt' in parsed) {
    const prompt = (parsed as { prompt?: unknown }).prompt;
    if (typeof prompt === 'string') {
      if (prompt.startsWith('[System:')) {
        return { searchableText: null, messageKind: 'system' };
      }
      if (isSystemReminder(prompt, metadata)) {
        return { searchableText: null, messageKind: 'system' };
      }
      if (metadata?.promptOrigin === 'wakeup_resume') {
        return { searchableText: null, messageKind: 'system' };
      }
      return { searchableText: nonEmpty(prompt), messageKind: 'user' };
    }
  }

  if (parsed && typeof parsed === 'object') {
    const p = parsed as { type?: unknown; message?: { content?: unknown } };
    if (p.type === 'user' && p.message) {
      const c = p.message.content;
      if (Array.isArray(c)) {
        // tool_result blocks
        const hasToolResult = c.some((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result');
        if (hasToolResult) {
          return { searchableText: null, messageKind: 'tool' };
        }
      } else if (typeof c === 'string') {
        if (isSystemReminder(c, metadata)) {
          return { searchableText: null, messageKind: 'system' };
        }
        return { searchableText: nonEmpty(c), messageKind: 'user' };
      }
    }
  }

  // Fallback: plain-text user prompt
  const trimmed = content.trim();
  if (trimmed.length === 0) return { searchableText: null, messageKind: 'meta' };
  if (isSystemReminder(content, metadata)) {
    return { searchableText: null, messageKind: 'system' };
  }
  return { searchableText: nonEmpty(content), messageKind: 'user' };
}

function extractClaudeCodeOutput(parsed: unknown, content: string): ExtractedSearchable {
  if (parsed === undefined) {
    const trimmed = content.trim();
    if (trimmed.length === 0) return { searchableText: null, messageKind: 'meta' };
    return { searchableText: nonEmpty(content), messageKind: 'assistant' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { searchableText: null, messageKind: 'meta' };
  }

  const p = parsed as {
    type?: unknown;
    subtype?: unknown;
    content?: unknown;
    message?: { content?: unknown };
    error?: unknown;
    result?: unknown;
    num_turns?: unknown;
    attachment?: unknown;
  };

  if (p.type === 'text' && typeof p.content === 'string') {
    return { searchableText: nonEmpty(p.content), messageKind: 'assistant' };
  }

  if (p.type === 'assistant' && p.message) {
    // An errored assistant frame is a synthetic echo the parser skips; the
    // error itself renders from the separate `type: 'error'` frame.
    if (p.error) {
      return { searchableText: null, messageKind: 'meta' };
    }
    const blocks = p.message.content;
    if (Array.isArray(blocks)) {
      const textParts: string[] = [];
      let sawTool = false;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
        else if (b.type === 'thinking') {
          const t = typeof b.thinking === 'string' ? b.thinking : (typeof b.text === 'string' ? b.text : '');
          if (t) textParts.push(t);
        } else if (b.type === 'tool_use' || b.type === 'tool_result') {
          sawTool = true;
        }
      }
      const joined = textParts.join('\n');
      if (nonEmpty(joined)) return { searchableText: capLen(joined), messageKind: 'assistant' };
      if (sawTool) return { searchableText: null, messageKind: 'tool' };
      return { searchableText: null, messageKind: 'meta' };
    }
  }

  if (p.type === 'attachment') {
    return { searchableText: null, messageKind: 'system' };
  }

  if (p.type === 'error') {
    const errText = typeof p.error === 'string'
      ? p.error
      : (p.error != null ? JSON.stringify(p.error) : null);
    return { searchableText: nonEmpty(errText), messageKind: 'system' };
  }

  if (p.type === 'result' && typeof p.result === 'string') {
    return { searchableText: nonEmpty(p.result), messageKind: 'assistant' };
  }

  // A result frame without text (error_max_turns, error_during_execution) is
  // the turn-end lifecycle frame, the claude-code analog of codex's
  // `turn/completed`.
  if (p.type === 'result') {
    return { searchableText: null, messageKind: 'system' };
  }

  if (p.type === 'nimbalyst_tool_use' || p.type === 'nimbalyst_tool_result') {
    return { searchableText: null, messageKind: 'tool' };
  }

  if (p.type === 'user' && p.message) {
    const c = p.message.content;
    if (Array.isArray(c)) {
      return { searchableText: null, messageKind: 'tool' };
    }
    if (typeof c === 'string' && c.trim().length > 0) {
      return { searchableText: nonEmpty(c), messageKind: 'system' };
    }
  }

  if (p.type === 'system') {
    return { searchableText: null, messageKind: 'system' };
  }

  return { searchableText: null, messageKind: 'meta' };
}

function todoListText(items: unknown[]): string | null {
  const lines = items
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => {
      const txt = typeof t.text === 'string' ? t.text : String(t.text ?? '');
      return `- [${t.completed ? 'x' : ' '}] ${txt}`;
    });
  return nonEmpty(lines.join('\n'));
}

/** Lifecycle namespaces: the thread, the turn, the account and MCP server status. */
const CODEX_APP_SERVER_LIFECYCLE_PREFIXES = ['turn/', 'thread/', 'account/', 'mcpServer/'];

/**
 * Classify one Codex app-server notification the way `CodexAppServerRawParser`
 * renders it: tool cards are `tool`, provider lifecycle frames (turn, thread,
 * account, MCP server status, errors) are `system`, and `meta` is left for
 * frames nothing renders, such as superseded deltas and `item/started` for an
 * item type whose card waits for `item/completed`.
 */
function extractCodexAppServerNotification(
  method: string,
  params: Record<string, unknown>,
): ExtractedSearchable {
  const item = params.item as
    | { type?: unknown; text?: unknown; items?: unknown }
    | undefined;

  if (method === 'item/completed' || method === 'item/updated') {
    if (item && typeof item === 'object') {
      if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim().length > 0) {
        return { searchableText: capLen(item.text), messageKind: 'assistant' };
      }
      // Reasoning renders as the turn's thinking. It is not indexed: the
      // last-response readers assemble every assistant row's searchable_text,
      // and the model's reasoning is not part of its reply.
      if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim().length > 0) {
        return { searchableText: null, messageKind: 'assistant' };
      }
      // The parser renders a todo list as an assistant message. Not indexed,
      // for the same reason as reasoning: it is a plan, not the reply.
      if ((item.type === 'todoList' || item.type === 'todo_list') && Array.isArray(item.items)) {
        return { searchableText: null, messageKind: todoListText(item.items) ? 'assistant' : 'meta' };
      }
      if (isAppServerToolItem(item)) {
        return { searchableText: null, messageKind: 'tool' };
      }
    }
    return { searchableText: null, messageKind: 'meta' };
  }

  if (method === 'item/started') {
    if (isAppServerToolItem(item) && !isNonRenderingAppServerItemStarted(item?.type)) {
      return { searchableText: null, messageKind: 'tool' };
    }
    return { searchableText: null, messageKind: 'meta' };
  }

  if (CODEX_APP_SERVER_SUPERSEDED_DELTA_METHODS.has(method)) {
    return { searchableText: null, messageKind: 'meta' };
  }

  if (method === 'error' || method === 'turn/failed') {
    const error = params.error as { message?: unknown } | undefined;
    const message = typeof error?.message === 'string' ? error.message : params.message;
    return { searchableText: typeof message === 'string' ? nonEmpty(message) : null, messageKind: 'system' };
  }

  if (CODEX_APP_SERVER_STATUS_EVENT_TYPES.has(method)
    || CODEX_APP_SERVER_LIFECYCLE_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return { searchableText: null, messageKind: 'system' };
  }

  return { searchableText: null, messageKind: 'meta' };
}

function extractCodexOutput(parsed: unknown, content: string): ExtractedSearchable {
  if (parsed === undefined) {
    return { searchableText: nonEmpty(content), messageKind: 'assistant' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { searchableText: null, messageKind: 'meta' };
  }

  const p = parsed as {
    item?: { type?: unknown; items?: unknown; text?: unknown; content?: unknown };
    msg?: { type?: unknown; message?: unknown; text?: unknown; delta?: unknown };
    type?: unknown;
    method?: unknown;
    params?: { item?: { type?: unknown; text?: unknown } };
  };

  // App-server transport envelope: production Codex persists notifications as
  // `JSON.stringify({ method, params })` (see OpenAICodexProvider.storeRawEventIfPresent).
  // The assistant text lives at `params.item.text` for an `agentMessage` item,
  // NOT the top-level SDK shapes handled below. Without this branch every
  // codex assistant reply classifies as `meta`/null, so the read APIs that
  // query `message_kind = 'assistant'` (e.g. get_session_summary's
  // fetchLastAssistantResponse) return no last response. Mirrors the canonical
  // reader (CodexAppServerRawParser.parseItemCompleted) and the meta-agent's
  // extractCodexText. Fixes #692.
  if (typeof p.method === 'string' && p.params && typeof p.params === 'object') {
    return extractCodexAppServerNotification(p.method, p.params as Record<string, unknown>);
  }

  // todo_list item -> rendered as assistant_message text
  if (p.item && typeof p.item === 'object') {
    const it = p.item;
    if (it.type === 'todo_list' && Array.isArray(it.items)) {
      return { searchableText: todoListText(it.items), messageKind: 'assistant' };
    }
    if (typeof it.text === 'string' && it.text.trim().length > 0) {
      return { searchableText: capLen(it.text), messageKind: 'assistant' };
    }
    if (typeof it.content === 'string' && it.content.trim().length > 0) {
      return { searchableText: capLen(it.content), messageKind: 'assistant' };
    }
  }

  // SDK event envelopes (msg.type)
  if (p.msg && typeof p.msg === 'object') {
    const m = p.msg as { type?: unknown; message?: unknown; text?: unknown; delta?: unknown };
    if (m.type === 'agent_message' && typeof m.message === 'string') {
      return { searchableText: nonEmpty(m.message), messageKind: 'assistant' };
    }
    if (m.type === 'agent_message_delta' && typeof m.delta === 'string') {
      return { searchableText: nonEmpty(m.delta), messageKind: 'assistant' };
    }
    if (typeof m.text === 'string' && m.text.trim().length > 0) {
      return { searchableText: capLen(m.text), messageKind: 'assistant' };
    }
  }

  // Bare text envelope
  if (p.type === 'text' && typeof (p as { content?: unknown }).content === 'string') {
    return { searchableText: nonEmpty((p as { content?: string }).content ?? null), messageKind: 'assistant' };
  }

  return { searchableText: null, messageKind: 'meta' };
}

/**
 * Gemini's own source id. Rows written while it shipped as an extension carry
 * `gemini-antigravity/antigravity-server` instead; those predate the search
 * index caring about it and are handled by the generic path, which is correct
 * for their text rows.
 */
const GEMINI_SOURCE = 'antigravity-gemini-agent';

/**
 * Gemini writes two output shapes, distinguished by `metadata.role` rather than
 * by a type tag inside the content: plain assistant text, and a
 * `{name,args,result}` tool row.
 *
 * The tool row must NOT be indexed. Its body is a whole file's contents for a
 * write, or a directory listing for a read; indexing that would let a search
 * for any word in the repository match every Gemini session that ever read it.
 */
function extractGeminiOutput(
  content: string,
  metadata?: Record<string, unknown> | null,
): ExtractedSearchable {
  if (metadata?.role === 'tool') {
    return { searchableText: null, messageKind: 'tool' };
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) return { searchableText: null, messageKind: 'meta' };
  return { searchableText: nonEmpty(content), messageKind: 'assistant' };
}

function extractGenericOutput(content: string): ExtractedSearchable {
  // Chat providers (claude, openai, lmstudio) write one row per semantic block.
  // The content is typically the assistant text directly (not provider-JSON).
  const parsed = safeJsonParse(content);
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { type?: unknown; content?: unknown; error?: unknown };
    if (p.type === 'error') {
      const errText = typeof p.error === 'string' ? p.error : null;
      return { searchableText: nonEmpty(errText), messageKind: 'system' };
    }
    if (typeof p.content === 'string') {
      return { searchableText: nonEmpty(p.content), messageKind: 'assistant' };
    }
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) return { searchableText: null, messageKind: 'meta' };
  return { searchableText: nonEmpty(content), messageKind: 'assistant' };
}

function extractGenericInput(content: string, metadata?: Record<string, unknown> | null): ExtractedSearchable {
  const parsed = safeJsonParse(content);
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { prompt?: unknown };
    if (typeof p.prompt === 'string') {
      if (isSystemReminder(p.prompt, metadata)) {
        return { searchableText: null, messageKind: 'system' };
      }
      return { searchableText: nonEmpty(p.prompt), messageKind: 'user' };
    }
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) return { searchableText: null, messageKind: 'meta' };
  if (isSystemReminder(content, metadata)) {
    return { searchableText: null, messageKind: 'system' };
  }
  return { searchableText: nonEmpty(content), messageKind: 'user' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Agent providers whose *input* rows are the plain prompt text plus metadata,
 * rather than the JSON envelope a chat provider writes.
 */
const AGENT_SOURCES = new Set([
  'claude-code',
  'openai-codex',
  'openai-codex-acp',
  'opencode',
  'copilot-cli',
  'grok-build',
  'cursor-agent',
  'antigravity-gemini-agent',
]);

/**
 * Agent providers whose turn-final assistant row uses the Codex
 * `item.completed` envelope. A provider missing from here falls through to the
 * generic extractor, and its sessions become unsearchable by their replies.
 */
const CODEX_SHAPED_OUTPUT_SOURCES = new Set([
  'openai-codex',
  'openai-codex-acp',
  'opencode',
  'copilot-cli',
  'grok-build',
  'cursor-agent',
]);

export function extractSearchable(input: ExtractorInput): ExtractedSearchable {
  if (input.hidden) {
    return { searchableText: null, messageKind: 'meta' };
  }

  const { source, direction, content, metadata } = input;

  // Treat all "agent provider" output payloads through their SDK-shaped extractors;
  // chat providers write plainer rows and use the generic extractor.
  if (direction === 'input') {
    if (AGENT_SOURCES.has(source)) {
      const parsed = safeJsonParse(content);
      const result = extractClaudeCodeInput(parsed, content, metadata);
      return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
    }
    const result = extractGenericInput(content, metadata);
    return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
  }

  // direction === 'output'
  if (source === GEMINI_SOURCE) {
    const result = extractGeminiOutput(content, metadata);
    return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
  }
  if (source === 'claude-code') {
    const parsed = safeJsonParse(content);
    const result = extractClaudeCodeOutput(parsed, content);
    return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
  }
  if (CODEX_SHAPED_OUTPUT_SOURCES.has(source)) {
    const parsed = safeJsonParse(content);
    const result = extractCodexOutput(parsed, content);
    return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
  }
  const result = extractGenericOutput(content);
  return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
}
