/**
 * Shared utility for extracting text content from Codex SDK events.
 *
 * Used by codexEventParser.ts for parsing events at save time.
 */

/**
 * Extracts text from an array of content items.
 * Handles both string items and objects with text/content/value fields.
 */
function getTextFromContentArray(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item === 'object') {
        const entry = item as Record<string, unknown>;
        // Check common text field names
        if (typeof entry.text === 'string') return entry.text;
        if (typeof entry.content === 'string') return entry.content;
        if (typeof entry.value === 'string') return entry.value;
        // Handle nested content objects (e.g., { type: 'text', text: '...' })
        if (entry.type === 'text' && typeof entry.text === 'string') return entry.text;
      }
      return '';
    })
    .filter(Boolean);

  return textParts.length > 0 ? textParts.join('\n') : null;
}

/**
 * Recursively extracts text from various Codex SDK event structures.
 *
 * Handles:
 * - Direct string values (with trimming)
 * - Arrays of content items
 * - Objects with text/message/content/delta/output_text fields
 * - Nested structures (item.text, item.content, delta.content, etc.)
 */
function getTextCandidate(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }

  if (Array.isArray(value)) {
    return getTextFromContentArray(value);
  }

  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return (
      getTextCandidate(item.text) ??
      getTextCandidate(item.message) ??
      getTextCandidate(item.content) ??
      getTextCandidate(item.delta) ??
      getTextCandidate(item.output_text) ??
      null
    );
  }

  return null;
}

/**
 * Extracts text content from a Codex SDK event.
 *
 * This function is used by both the event parser (for storage) and the output renderer (for display).
 * It handles all known Codex SDK event formats and extracts text from nested structures.
 *
 * @param event - Raw Codex SDK event object
 * @returns Extracted text or null if no text found
 *
 * @example
 * // Direct item.text field
 * extractTextFromCodexEvent({ item: { text: "Hello" } }) // "Hello"
 *
 * @example
 * // item.content array with text objects
 * extractTextFromCodexEvent({
 *   item: {
 *     content: [{ type: "text", text: "Hello" }]
 *   }
 * }) // "Hello"
 *
 * @example
 * // delta.content array
 * extractTextFromCodexEvent({
 *   delta: {
 *     content: [{ type: "text", text: "Hello" }]
 *   }
 * }) // "Hello"
 */
export function extractTextFromCodexEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const record = event as Record<string, unknown>;

  // Try direct item.text field first (most common in Codex SDK)
  if (record.item && typeof record.item === 'object') {
    const item = record.item as Record<string, unknown>;

    // Direct text field
    const directText = getTextCandidate(item.text);
    if (directText) return directText;

    // item.content array (e.g., [{ type: "text", text: "..." }])
    const contentText = getTextCandidate(item.content);
    if (contentText) return contentText;
  }

  // Try delta.content for streaming updates
  if (record.delta && typeof record.delta === 'object') {
    const delta = record.delta as Record<string, unknown>;
    const deltaText = getTextCandidate(delta.content);
    if (deltaText) return deltaText;
  }

  // Try top-level text fields as fallback
  return getTextCandidate(record);
}
