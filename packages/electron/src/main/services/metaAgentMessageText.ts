export interface AgentMessageLike {
  direction: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Extracts a short text representation from an `ai_agent_messages.content`
 * row written by an AI provider. Returns null if no text can be extracted
 * or if the message is a non-user system reminder.
 *
 * Used by MetaAgentService to summarize a child session's recent activity
 * for the parent (lastResponse, recentMessages, [Child Session Update]).
 *
 * Must understand both Claude / Claude Code raw shapes AND OpenAI Codex /
 * OpenCode raw SDK event shapes -- see TRANSCRIPT_ARCHITECTURE.md and
 * packages/runtime/src/ai/server/providers/codex/codexEventParser.ts for the
 * canonical Codex shape catalog. Keep this in sync when new shapes are added
 * there.
 */
export function extractMessageText(
  rawContent: string,
  metadata?: Record<string, unknown> | null,
): string | null {
  if (metadata && metadata.promptType === 'system_reminder') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const text = typeof rawContent === 'string' ? rawContent.trim() : '';
    return text || null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  if (typeof record.prompt === 'string' && record.prompt.trim()) {
    return record.prompt.trim();
  }

  if (record.type === 'text' && typeof record.content === 'string' && record.content.trim()) {
    return record.content.trim();
  }

  if (record.type === 'assistant' && isObject(record.message) && Array.isArray(record.message.content)) {
    const text = (record.message.content as unknown[])
      .filter((b): b is { type: string; text: string } =>
        isObject(b) && (b as Record<string, unknown>).type === 'text' && typeof (b as Record<string, unknown>).text === 'string',
      )
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n');
    if (text) {
      return text;
    }
  }

  if (record.type === 'nimbalyst_tool_use' && record.name === 'AskUserQuestion') {
    return 'Interactive prompt: AskUserQuestion';
  }

  if (record.type === 'permission_request') {
    const tool = typeof record.toolName === 'string' ? record.toolName : (typeof record.requestId === 'string' ? record.requestId : 'unknown tool');
    return `Permission request: ${tool}`;
  }

  if (record.type === 'exit_plan_mode_request') {
    const planFilePath = typeof record.planFilePath === 'string' ? record.planFilePath : null;
    return `Plan ready for review${planFilePath ? `: ${planFilePath}` : ''}`;
  }

  const codex = extractCodexText(record);
  if (codex) {
    return codex;
  }

  return null;
}

/**
 * Extract user prompt strings (in order) from a session's raw input messages.
 *
 * Handles both wire shapes seen in `ai_agent_messages.content`:
 * - Claude / Claude Code wraps inputs as `JSON.stringify({ prompt, ... })`.
 * - OpenAI Codex / OpenCode log inputs as the raw prompt string itself.
 *
 * System reminders (e.g. session-naming nudges) carry
 * `metadata.promptType === 'system_reminder'` and are filtered out so they
 * don't pollute `originalPrompt` / `userPrompts` / parent notifications.
 */
export function extractUserPrompts(messages: ReadonlyArray<AgentMessageLike>): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.direction !== 'input') continue;
    if (message.metadata && message.metadata.promptType === 'system_reminder') continue;

    let text: string | null = null;
    let parsedAsJson = false;
    try {
      const parsed = JSON.parse(message.content);
      parsedAsJson = parsed !== null && typeof parsed === 'object';
      if (parsedAsJson) {
        const prompt = (parsed as Record<string, unknown>).prompt;
        if (typeof prompt === 'string' && prompt.trim()) {
          text = prompt.trim();
        }
      }
    } catch {
      // Not JSON -- fall through to the plain-text branch below
    }

    if (!text && !parsedAsJson && typeof message.content === 'string') {
      const trimmed = message.content.trim();
      if (trimmed) text = trimmed;
    }

    if (text) prompts.push(text);
  }
  return prompts;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively descend a Codex SDK event/object looking for assistant text.
 *
 * Mirrors `getTextCandidate` from
 * `packages/runtime/src/ai/server/providers/codex/textExtraction.ts` so the
 * meta-agent's extraction stays structurally identical to the canonical
 * parser used by codexEventParser and the transcript renderer. The previous
 * bespoke implementation only inspected `item.text` / `item.content`
 * shallowly, so Codex SDK events for `send_prompt` follow-up turns whose
 * assistant text lived under `item.message`, `item.delta`, or
 * `item.output_text` returned null. The meta-agent's `extractLastAgentResponse`
 * then walked further back through the message log and surfaced a stale
 * older turn instead. Fixes #270.
 *
 * Keep in sync with the canonical textExtraction.ts. Cross-package deep
 * imports aren't available, so the algorithm is inlined here.
 */
function getCodexTextCandidate(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }

  if (Array.isArray(value)) {
    return getCodexTextFromContentArray(value);
  }

  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return (
      getCodexTextCandidate(item.text) ??
      getCodexTextCandidate(item.message) ??
      getCodexTextCandidate(item.content) ??
      getCodexTextCandidate(item.delta) ??
      getCodexTextCandidate(item.output_text) ??
      null
    );
  }

  return null;
}

function getCodexTextFromContentArray(content: unknown[]): string | null {
  const parts = content
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const block = entry as Record<string, unknown>;
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        if (typeof block.value === 'string') return block.value;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
      }
      return '';
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Extract assistant text from a Codex / OpenCode raw SDK event.
 *
 * Delegates to the canonical extraction algorithm so the meta-agent's
 * summaries pick up the same text the renderer does, including `send_prompt`
 * follow-up turns that emit text in nested message/delta/output_text fields.
 */
function extractCodexText(record: Record<string, unknown>): string | null {
  const eventType = typeof record.type === 'string' ? record.type : '';

  // App-server transport envelope: production Codex persists notifications as
  // `JSON.stringify({ method, params })` (see OpenAICodexProvider.storeRawEventIfPresent
  // -> the synthesizedRaw `{ method, params }` row). The discriminator is the
  // slash-delimited `record.method` ('item/completed', 'turn/completed', etc.)
  // and the payload nests under `record.params.item`, NOT the top-level
  // `record.type`/`record.item` SDK shapes handled below. Mirror the canonical
  // reader (CodexAppServerRawParser.parseItemCompleted): an `agentMessage` /
  // `reasoning` item carries the assistant text on `item.text`. Without this
  // branch every SDK-shape check falls through and the meta-agent result API
  // returns lastResponse: null even though the assistant text is in the DB.
  if (typeof record.method === 'string' && isObject(record.params)) {
    const method = record.method;
    if (method === 'item/completed' || method === 'item/updated') {
      const item = (record.params as Record<string, unknown>).item;
      if (isObject(item)) {
        const itemType = typeof item.type === 'string' ? item.type : '';
        if (itemType === 'agentMessage' || itemType === 'reasoning') {
          const text = getCodexTextCandidate(item);
          if (text) return text;
        }
      }
    }
    // turn/completed, item/started (tool calls), turn/failed, error etc. carry
    // no assistant prose -- leave them to the error/text fallbacks (the result
    // API only wants assistant replies, not tool/turn bookkeeping).
  }

  // task_complete emits last_agent_message directly on the event
  if (eventType === 'task_complete') {
    const text = getCodexTextCandidate(record.last_agent_message);
    if (text) return text;
  }

  // item.*  events (item.completed, item.updated, *.message, agent_message,
  // reasoning, etc.). The canonical parser passes the entire item record to
  // getTextCandidate so nested shapes are caught.
  const item = record.item;
  if (isObject(item)) {
    const itemType = typeof item.type === 'string' ? item.type : '';
    const isMessageLike =
      itemType === 'agent_message' ||
      itemType === 'reasoning' ||
      itemType.includes('message') ||
      eventType === 'item.completed' ||
      eventType === 'item.updated';
    if (isMessageLike) {
      const text = getCodexTextCandidate(item);
      if (text) return text;
    }
  }

  // event_msg envelope (older Codex SDK shape, kept for compatibility)
  if (eventType === 'event_msg' && isObject(record.payload)) {
    const payload = record.payload as Record<string, unknown>;
    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    if (payloadType.includes('message') || payloadType.includes('text')) {
      const text = getCodexTextCandidate(payload);
      if (text) return text;
    }
  }

  // Top-level delta / text fallbacks (streaming updates, plain text events)
  const delta = getCodexTextCandidate(record.delta);
  if (delta) return delta;

  const direct = getCodexTextCandidate(record.text);
  if (direct) return direct;

  return null;
}
