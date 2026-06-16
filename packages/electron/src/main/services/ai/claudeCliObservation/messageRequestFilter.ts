/**
 * Filters which proxied `/v1/messages` requests are worth observing for the
 * Claude CLI proxy observation backend (NIM-806, Phase 3 / B3).
 *
 * The genuine `claude` CLI issues side requests over the same API connection
 * that are NOT part of the user-visible conversation — most notably the
 * "generate a session title" request. Teeing those into the transcript would
 * inject a stray assistant turn, so we skip them. The request still forwards
 * upstream byte-for-byte; we only suppress *observation*, never the proxying.
 *
 */

const SESSION_TITLE_PROMPT_MARKERS = [
  "Generate a concise, sentence-case title",
  'Return JSON with a single "title" field',
];

/** True when this `/v1/messages` body is a real conversational turn to observe. */
export function shouldObserveMessagesRequest(body: Record<string, unknown>): boolean {
  return !isClaudeSessionTitleRequest(body);
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
