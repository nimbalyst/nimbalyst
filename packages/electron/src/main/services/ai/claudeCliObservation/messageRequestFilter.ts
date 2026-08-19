/**
 * Filters which proxied `/v1/messages` requests are worth observing for the
 * Claude CLI proxy observation backend (NIM-806, Phase 3 / B3).
 *
 * The genuine `claude` CLI issues side requests over the same API connection
 * that are NOT part of the user-visible conversation — the "generate a session
 * title" request, and the `--prompt-suggestions` fork. Teeing those into the
 * transcript would inject a stray assistant turn, so we skip them. The request
 * still forwards upstream byte-for-byte; we only suppress *observation*, never
 * the proxying.
 *
 */

const SESSION_TITLE_PROMPT_MARKERS = [
  "Generate a concise, sentence-case title",
  'Return JSON with a single "title" field',
];

/**
 * The CLI's prompt-suggestion fork appends this instruction as the final user
 * message. Marker text extracted from CLI 2.1.233 and confirmed against a
 * captured request body; nothing else on the request distinguishes it — headers,
 * model, and sampling params are identical to a real turn's.
 */
const PROMPT_SUGGESTION_PROMPT_MARKER = "[SUGGESTION MODE:";

/** True when this `/v1/messages` body is a real conversational turn to observe. */
export function shouldObserveMessagesRequest(body: Record<string, unknown>): boolean {
  return !isClaudeSessionTitleRequest(body) && !isPromptSuggestionRequest(body);
}

/**
 * The `--prompt-suggestions` fork: after each turn the CLI runs a second,
 * short-lived agent that predicts what the user might type next and renders it
 * as Tab-to-accept ghost text in its own composer. It never reaches the CLI's
 * transcript (the fork carries `skipTranscript`), but it does hit `/v1/messages`
 * through our proxy — so unfiltered, its reply is assembled and persisted as a
 * genuine assistant turn: a message the user never received and the agent never
 * wrote, phrased as something the user would say.
 *
 * Match narrowly — only the LAST message, only when it is the user turn, only on
 * a leading marker. A whole-body scan would drop real turns whose tool_results
 * happen to quote this file.
 */
function isPromptSuggestionRequest(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as Record<string, unknown> | null;
  if (!last || typeof last !== "object" || last.role !== "user") return false;
  return leadingText(last.content).trimStart().startsWith(PROMPT_SUGGESTION_PROMPT_MARKER);
}

/** A message's leading text — content is either a bare string or a block list. */
function leadingText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const obj = block as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") return obj.text;
  }
  return "";
}

function isClaudeSessionTitleRequest(body: Record<string, unknown>): boolean {
  return (
    hasAnyTextMarker(body.system, SESSION_TITLE_PROMPT_MARKERS) &&
    hasSingleTitleJsonSchema(body)
  );
}

function hasAnyTextMarker(value: unknown, markers: string[]): boolean {
  if (typeof value === "string") return markers.some((marker) => value.includes(marker));
  if (Array.isArray(value)) return value.some((item) => hasAnyTextMarker(item, markers));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      hasAnyTextMarker(item, markers),
    );
  }
  return false;
}

function hasSingleTitleJsonSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSingleTitleJsonSchema);
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.type === "json_schema" && schemaOnlyAllowsTitle(obj.schema)) return true;
  return Object.values(obj).some(hasSingleTitleJsonSchema);
}

function schemaOnlyAllowsTitle(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const obj = schema as Record<string, unknown>;
  const properties = obj.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const propertyNames = Object.keys(properties);
  if (propertyNames.length !== 1 || propertyNames[0] !== "title") return false;
  const required = obj.required;
  return !Array.isArray(required) || (required.length === 1 && required[0] === "title");
}
