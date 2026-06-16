/**
 * Chunk-safe Server-Sent-Events block parser for the Claude CLI proxy
 * observation backend (NIM-806, Phase 3 / B3).
 *
 * The loopback proxy tees the Anthropic `/v1/messages` SSE response back to us
 * in arbitrary network chunks. SSE events are `\n\n`-delimited blocks of
 * `event:` / `data:` lines; a single TCP chunk may split a block mid-way, so we
 * parse what's complete and hand back the trailing partial for the next chunk.
 *
 */

export interface SSEEvent {
  /** The `event:` field (e.g. `content_block_delta`), if present. */
  event?: string;
  /** The raw joined `data:` payload. */
  data: string;
  /** `JSON.parse(data)` when it parses, else undefined. */
  parsed?: unknown;
}

export interface SSEExtractResult {
  complete: SSEEvent[];
  /** Trailing partial block — feed it back prepended to the next chunk. */
  remainder: string;
}

/**
 * Extract complete SSE blocks from a buffer, returning any trailing partial
 * block so callers can parse across arbitrary network chunk boundaries.
 *
 * Usage:
 *   let buf = '';
 *   onChunk(chunk) {
 *     buf += chunk;
 *     const { complete, remainder } = extractSSEEvents(buf);
 *     buf = remainder;
 *     complete.forEach(handle);
 *   }
 */
export function extractSSEEvents(buffer: string): SSEExtractResult {
  const complete: SSEEvent[] = [];
  const blocks = buffer.split("\n\n");
  // The last element is either '' (buffer ended on a delimiter) or a partial
  // block; either way it is not yet complete, so hold it as the remainder.
  const remainder = blocks.pop() ?? "";

  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) eventType = line.slice(7).trim();
      else if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      else if (line.startsWith("data:")) dataLines.push(line.slice(5));
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Non-JSON data (e.g. the `[DONE]` sentinel) — leave parsed undefined.
    }
    complete.push({ event: eventType, data, parsed });
  }

  return { complete, remainder };
}
