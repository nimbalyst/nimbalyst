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
 * See plan: `nimbalyst-local/plans/canonical-transcript-deprecation.md`.
 */

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
    if (p.method === 'item/completed' || p.method === 'item/updated') {
      const item = p.params.item;
      if (item && typeof item === 'object' && item.type === 'agentMessage'
        && typeof item.text === 'string' && item.text.trim().length > 0) {
        return { searchableText: capLen(item.text), messageKind: 'assistant' };
      }
    }
    // turn/completed, item/started (tool calls), reasoning, turn/failed, error
    // carry no assistant prose -- fall through to meta.
    return { searchableText: null, messageKind: 'meta' };
  }

  // todo_list item -> rendered as assistant_message text
  if (p.item && typeof p.item === 'object') {
    const it = p.item;
    if (it.type === 'todo_list' && Array.isArray(it.items)) {
      const lines = (it.items as Array<Record<string, unknown>>).map((t) => {
        const txt = typeof t.text === 'string' ? t.text : String(t.text ?? '');
        return `- [${t.completed ? 'x' : ' '}] ${txt}`;
      });
      const joined = lines.join('\n');
      return { searchableText: nonEmpty(joined), messageKind: 'assistant' };
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

function extractGenericOutput(content: string): ExtractedSearchable {
  // Chat providers write one row per semantic block.
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

export function extractSearchable(input: ExtractorInput): ExtractedSearchable {
  if (input.hidden) {
    return { searchableText: null, messageKind: 'meta' };
  }

  const { source, direction, content, metadata } = input;

  // Treat all "agent provider" output payloads through their SDK-shaped extractors;
  // chat providers write plainer rows and use the generic extractor.
  if (direction === 'input') {
    if (source === 'claude-code' || source === 'openai-codex' || source === 'openai-codex-acp' || source === 'opencode' || source === 'copilot-cli') {
      const parsed = safeJsonParse(content);
      const result = extractClaudeCodeInput(parsed, content, metadata);
      return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
    }
    const result = extractGenericInput(content, metadata);
    return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
  }

  // direction === 'output'
  if (source === 'claude-code') {
    const parsed = safeJsonParse(content);
    const result = extractClaudeCodeOutput(parsed, content);
    return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
  }
  if (source === 'openai-codex' || source === 'openai-codex-acp' || source === 'opencode' || source === 'copilot-cli') {
    const parsed = safeJsonParse(content);
    const result = extractCodexOutput(parsed, content);
    return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
  }
  const result = extractGenericOutput(content);
  return { searchableText: capLen(result.searchableText), messageKind: result.messageKind };
}
