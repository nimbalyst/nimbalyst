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

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractFromContentArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === 'string') {
      const t = block.trim();
      if (t) parts.push(t);
      continue;
    }
    if (!isObject(block)) continue;
    const blockType = block.type;
    if ((blockType === 'text' || blockType === 'output_text') && typeof block.text === 'string') {
      const t = block.text.trim();
      if (t) parts.push(t);
      continue;
    }
    const direct = trimmedString(block.text) ?? trimmedString(block.content) ?? trimmedString(block.value);
    if (direct) parts.push(direct);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Extract assistant text from a Codex / OpenCode raw SDK event.
 *
 * Mirrors the subset of shapes that codexEventParser.parseCodexEvent treats
 * as text-bearing. Tool calls, usage, and reasoning-without-text are
 * intentionally ignored -- the meta-agent only cares about user-visible
 * assistant prose for its summaries.
 */
function extractCodexText(record: Record<string, unknown>): string | null {
  const eventType = typeof record.type === 'string' ? record.type : '';

  if (eventType === 'task_complete') {
    const text = trimmedString(record.last_agent_message);
    if (text) return text;
  }

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
      const text = trimmedString(item.text) ?? extractFromContentArray(item.content);
      if (text) return text;
    }
  }

  if (eventType === 'event_msg' && isObject(record.payload)) {
    const payload = record.payload as Record<string, unknown>;
    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    if (payloadType.includes('message') || payloadType.includes('text')) {
      const text =
        trimmedString(payload.text) ??
        trimmedString(payload.delta) ??
        trimmedString(payload.message) ??
        extractFromContentArray(payload.content);
      if (text) return text;
    }
  }

  if (record.delta != null) {
    const deltaText = trimmedString(record.delta);
    if (deltaText) return deltaText;
    if (isObject(record.delta)) {
      const text = trimmedString((record.delta as Record<string, unknown>).text) ??
        extractFromContentArray((record.delta as Record<string, unknown>).content);
      if (text) return text;
    }
  }

  const direct = trimmedString(record.text);
  if (direct) return direct;

  return null;
}
