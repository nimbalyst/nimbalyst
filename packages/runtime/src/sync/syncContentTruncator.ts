/**
 * syncContentTruncator
 *
 * Trims large `tool_result` block contents out of Claude Code raw SDK messages
 * before they get encrypted and uploaded to a SessionRoom. Local raw log
 * (`ai_agent_messages`) keeps the full payload untouched -- this only changes
 * what crosses the wire / lands in the Durable Object.
 *
 * Why this exists: per-DO storage audits showed ~90% of SessionRoom bytes are
 * `tool_result` payloads (Bash stdout, Read of large files, Grep over big
 * repos, WebFetch HTML). Those are rarely worth viewing on mobile; the
 * `tool_use` block (what the agent did) is the small, useful part.
 *
 * Strategy:
 *   - Per large tool/output block: cap content at TRUNCATE_THRESHOLD_BYTES and
 *     splice in a human-readable marker explaining the elision.
 *   - Reduce disposable output fields within a per-message budget; preserve
 *     conversation and actionable envelopes regardless of their size.
 *   - Leave `tool_use` blocks alone regardless of size; that's the "what
 *     happened" signal users actually want on mobile.
 *   - Keep inline image blocks (screenshots), downscaling instead of eliding.
 *     They are the one large payload whose whole point is being looked at on
 *     the phone, and there is no other channel that can deliver them.
 *   - Plain-text and unknown-provider rows stay whole up to the inline row
 *     limit. Any row still above MAX_SYNC_ROW_CONTENT_BYTES after all of the
 *     above becomes a short elision marker, never a server refusal.
 *
 * Stats: a singleton tracker accumulates byte-savings across the process so we
 * can validate the impact locally before deploying. It self-logs periodically
 * (every N messages or every M seconds, whichever comes first) and exposes a
 * snapshot for inspection.
 */
import { utf8ByteLen, formatBytes, isImageBlock } from '../utils/contentBytes';
import { boundSyncOutputs, isInteractiveSyncItem, isStructuredSyncResult, syncTextPrefix } from './syncSemanticProjection';
import {
  CLAUDE_CODE_TRANSIENT_CHUNK_TYPES,
  CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES,
  CODEX_APP_SERVER_TRANSIENT_EVENT_TYPES,
  CODEX_LEGACY_TRANSIENT_EVENT_TYPES,
} from '../storage/nonRenderingFrames';

const TRUNCATE_THRESHOLD_BYTES = 4 * 1024;
const MAX_SYNC_MESSAGE_BYTES = 16 * 1024;
// The server (SessionRoom.MAX_ENCRYPTED_CONTENT_BYTES) refuses a row whose
// base64 ciphertext exceeds 512 KiB: 393,216 raw bytes, less the 16-byte
// AES-GCM tag, is the largest plaintext envelope
// `{"content":...,"metadata":...,"hidden":...}` that fits. encryptSessionMessage
// enforces it on the whole envelope. The content clamp below reserves 32 KiB
// for the rest of the envelope, so a row with ordinary metadata is elided here
// and counted in the stats. Semantic projection keeps real rows far below both;
// a row still above them becomes the elision marker instead of a refusal.
const SERVER_MAX_ENCRYPTED_CONTENT_CHARS = 512 * 1024;
const AES_GCM_TAG_BYTES = 16;
const ENVELOPE_RESERVE_BYTES = 32 * 1024;
export const MAX_SYNC_ROW_PLAINTEXT_BYTES = (SERVER_MAX_ENCRYPTED_CONTENT_CHARS / 4) * 3 - AES_GCM_TAG_BYTES;
/** Measured on the content as JSON-escaped into the envelope, quotes included. */
export const MAX_SYNC_ROW_CONTENT_BYTES = MAX_SYNC_ROW_PLAINTEXT_BYTES - ENVELOPE_RESERVE_BYTES;
/** tool_use_result keys that hold the user's answers, never disposable output. */
const TOOL_USE_RESULT_PROTECTED_KEYS = new Set(['answers', 'questions']);

// Messages carrying an inline image block (capture_editor_screenshot and other
// MCP tools that return pictures) get their own, much larger ceiling. Mobile
// has no second way to fetch the image -- the only encrypted attachment channel
// runs mobile -> desktop -- so applying MAX_SYNC_MESSAGE_BYTES here doesn't
// "trim" the message, it deletes the screenshot the user wanted to look at on
// their phone.
//
// Stays well under MAX_SYNC_ROW_CONTENT_BYTES: base64 needs no JSON escaping,
// so 256 KB here lands near 350 KB on the wire.
const MAX_SYNC_MESSAGE_WITH_IMAGE_BYTES = 256 * 1024;

// Largest single image block we will put on the wire, after the downscale pass
// below. Sized for the sync compressor's 150 KB binary target (~200 KB of
// base64) plus the surrounding JSON. Every synced screenshot permanently
// occupies part of a SessionRoom's storage cap, hence the tight budget.
const MAX_SYNC_IMAGE_BLOCK_BYTES = 220 * 1024;

const LOG_EVERY_N_MESSAGES = 25;
const LOG_INTERVAL_MS = 30_000;

/**
 * Optional platform hook for shrinking an oversized image before it is synced.
 * Electron's main process registers the same nativeImage-backed compressor the
 * MCP layer uses; platforms without it (mobile) simply fall back to dropping
 * images past MAX_SYNC_IMAGE_BLOCK_BYTES. Observed screenshots run from 200 KB
 * to 1.7 MB, so without this ~20% of them would never reach the phone.
 */
export type SyncImageCompressor = (
  base64Data: string,
  mimeType: string,
) => { data: string; mimeType: string };

let syncImageCompressor: SyncImageCompressor | null = null;

export function setSyncImageCompressor(compressor: SyncImageCompressor | null): void {
  syncImageCompressor = compressor;
}

// The three "renders nothing" sets below are shared with the provider write
// path and the storage backfill -- see `storage/nonRenderingFrames`. They used
// to be a private copy here, which is how `thinking_tokens` ended up filtered
// on the wire and persisted to disk for months.
//
// This sync-side filter still earns its keep independently of the write-path
// gate: it catches chunks already sitting in ai_agent_messages from before that
// gate landed (older sessions replayed on first reconnect).

// System subtypes that ARE persisted locally (so the desktop's own transcript
// build can read e.g. the SDK session_id) but must NOT cross the sync wire.
// `system/init` is ~17 KB of tools / mcp_servers / slash_commands metadata that
// no transcript consumer renders (the raw-message parsers ignore it entirely).
// Worse, it tripped MAX_SYNC_MESSAGE_BYTES and the whole-message clamp rewrote
// it into a bare "[Full claude-code message elided...]" marker string. On
// mobile that string fails JSON.parse and falls through to the plain-text
// assistant branch, rendering a stray bubble desktop never shows. Drop it.
const CLAUDE_CODE_NON_SYNCED_SYSTEM_SUBTYPES = new Set(['init']);

// Legacy codex `event_msg` envelopes are additionally unwrapped below; the bare
// event-type set itself lives in `storage/nonRenderingFrames`.

// OpenCode SSE event types that can produce something the mobile transcript
// renders, mirroring the switch in OpenCodeRawParser.parseOutputMessage. That
// parser returns [] for every type not listed there, so anything outside this
// set is dead weight on the wire. `message.updated` renders nothing itself but
// MUST sync: it builds the user/assistant role map that stops user-message
// part deltas rendering as assistant text. `session.idle` only yields a
// turn_ended descriptor, which the projector drops, so it is excluded.
// KEEP IN SYNC with OpenCodeRawParser -- if the parser learns to render a new
// SSE type, add it here or mobile will never see it.
const OPENCODE_SYNCED_EVENT_TYPES = new Set([
  'message.updated',
  'file.edited',
  'session.error',
  'todo.updated',
  'permission.asked',
  'permission.updated',
  'permission.replied',
]);

/** OpenCode `message.part.updated` renders only tool parts; text/reasoning
 * parts on this event are cumulative snapshots the parser suppresses (text
 * arrives via `message.part.delta`), so syncing them is O(n^2) dead weight. */
function isOpenCodeSyncedPartUpdated(content: string | undefined): boolean {
  if (!content) return true;
  try {
    const parsed = JSON.parse(content) as { properties?: { part?: { type?: string } } };
    return parsed?.properties?.part?.type === 'tool';
  } catch {
    return true;
  }
}

/** OpenCode `message.part.delta` renders only non-empty text-field deltas. */
function isOpenCodeSyncedPartDelta(content: string | undefined): boolean {
  if (!content) return true;
  try {
    const parsed = JSON.parse(content) as { properties?: { field?: string; delta?: unknown } };
    return (
      parsed?.properties?.field === 'text'
      && typeof parsed.properties.delta === 'string'
      && parsed.properties.delta.length > 0
    );
  } catch {
    return true;
  }
}

export interface PerMessageTruncationStats {
  bytesBefore: number;
  bytesAfter: number;
  blocksTruncated: number;
  elidedBytes: number;
  largestBlockElidedBytes: number;
}

/**
 * Record types the headless-agent parser turns into canonical events.
 *
 * `thought` and `text` are deliberately absent: both are per-token deltas that
 * the parser drops in favour of the turn-final `item.completed`.
 */
export const HEADLESS_AGENT_SYNCED_EVENT_TYPES = new Set([
  'item.completed',
  // Grok
  'tool_call',
  'tool_call_update',
  // Cursor -- its records carry the same `type` discriminator
  'result',
]);

export function shouldSyncMessageForSessionRoom(
  source: string,
  metadata?: Record<string, unknown> | null,
  content?: string,
  hidden?: boolean,
): boolean {
  // Hidden rows never render on mobile: every raw-message parser early-returns
  // on `msg.hidden` -- EXCEPT OpenCode, whose entire SSE event stream is
  // persisted with hidden:true and re-rendered from those hidden output rows.
  if (hidden && !source.startsWith('opencode')) {
    return false;
  }

  // Codex ACP and Gemini ACP share the ACP raw envelope format. Their parsers
  // return [] for metadata updates (usage_update, available_commands_update,
  // config_option_update, session_info_update) and permission previews.
  if (source.startsWith('openai-codex-acp') || source.startsWith('antigravity-gemini-agent')) {
    if (
      content
      && (
        content.includes('"usage_update"')
        || content.includes('"available_commands_update"')
        || content.includes('"config_option_update"')
        || content.includes('"session_info_update"')
        || content.includes('"session/request_permission_preview"')
      )
    ) {
      try {
        const parsed = JSON.parse(content) as { type?: string; update?: { sessionUpdate?: string } };
        if (parsed?.type === 'session/request_permission_preview') return false;
        const kind = parsed?.update?.sessionUpdate;
        if (
          kind === 'usage_update'
          || kind === 'available_commands_update'
          || kind === 'config_option_update'
          || kind === 'session_info_update'
        ) {
          return false;
        }
      } catch {
        // Unparseable -- let it through.
      }
    }
    return true;
  }

  // Copilot CLI streams agent_message_chunk rows (text and thinking) that the
  // parser never renders: text is re-delivered self-contained on the separate
  // item.completed row, and thinking chunks are dropped by design.
  if (source.startsWith('copilot-cli')) {
    if (content && content.includes('"agent_message_chunk"')) {
      try {
        const parsed = JSON.parse(content) as { params?: { update?: { sessionUpdate?: string } } };
        if (parsed?.params?.update?.sessionUpdate === 'agent_message_chunk') return false;
      } catch {
        // Unparseable -- let it through.
      }
    }
    return true;
  }

  // Grok Build and Cursor Agent persist every NDJSON record their CLI emits.
  // HeadlessAgentRawParser renders only the turn-final `item.completed`, the
  // tool_call / tool_call_update (Grok) or tool_call started/completed
  // (Cursor) rows, and errors. Text and reasoning deltas are dropped by design
  // -- the full response arrives self-contained on item.completed -- and Grok
  // emits one `thought` row per word, so syncing them would be pure waste.
  //
  // Keep this in sync with `HeadlessAgentRawParser`: a record type the parser
  // learns to render must be added here, or mobile silently shows less than
  // the desktop does. `headlessAgentSyncParity.test.ts` is the gate.
  if (source.startsWith('grok-build') || source.startsWith('cursor-agent')) {
    const eventType = typeof metadata?.eventType === 'string' ? metadata.eventType : '';
    if (!eventType) return true;
    return HEADLESS_AGENT_SYNCED_EVENT_TYPES.has(eventType);
  }

  if (source.startsWith('opencode')) {
    const eventType = typeof metadata?.eventType === 'string' ? metadata.eventType : '';
    // Rows without an eventType are not SSE events (e.g. user input) -- sync.
    if (!eventType) return true;
    if (OPENCODE_SYNCED_EVENT_TYPES.has(eventType)) return true;
    if (eventType === 'message.part.updated') return isOpenCodeSyncedPartUpdated(content);
    if (eventType === 'message.part.delta') return isOpenCodeSyncedPartDelta(content);
    // session.idle and every SSE type outside the parser's switch render
    // nothing -- drop.
    return false;
  }

  if (source.startsWith('openai-codex')) {
    const transport = typeof metadata?.transport === 'string' ? metadata.transport : '';
    const eventType = typeof metadata?.eventType === 'string' ? metadata.eventType : '';

    if (transport !== 'app-server') {
      // Legacy SDK/exec transport persists every raw event. Drop the ones
      // that render nothing; text deltas and item events DO render.
      if (CODEX_LEGACY_TRANSIENT_EVENT_TYPES.has(eventType)) return false;
      if (eventType === 'event_msg' && content && content.includes('"token_count"')) {
        try {
          const parsed = JSON.parse(content) as { payload?: { type?: string } };
          if (parsed?.payload?.type === 'token_count') return false;
        } catch {
          // Unparseable -- let it through.
        }
      }
      return true;
    }

    return !CODEX_APP_SERVER_TRANSIENT_EVENT_TYPES.has(eventType);
  }

  // startsWith (not ===) so claude-code-cli sessions get the same filtering.
  if (source.startsWith('claude-code') && content) {
    // Cheap structural prefilter: only parse JSON when the content could
    // be one of the transient chunk shapes. Skips the JSON.parse for the
    // overwhelmingly common assistant / user chunks.
    if (
      content.includes('"type":"system"')
      || content.includes('"type":"tool_progress"')
      || content.includes('"type":"tool_use_summary"')
      || content.includes('"type":"auth_status"')
      || content.includes('"type":"rate_limit_event"')
      || content.includes('"type":"result"')
    ) {
      try {
        const parsed = JSON.parse(content) as {
          type?: string;
          subtype?: string;
          num_turns?: number;
          result?: unknown;
        };
        if (parsed?.type === 'system' && typeof parsed.subtype === 'string') {
          return (
            !CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES.has(parsed.subtype)
            && !CLAUDE_CODE_NON_SYNCED_SYSTEM_SUBTYPES.has(parsed.subtype)
          );
        }
        // Result chunks duplicate the final assistant text and carry
        // usage/cost fields no mobile consumer reads (mobile context display
        // is fed by the index clientMetadata channel, not this row). The one
        // case the parser renders a result chunk is num_turns === 0 with
        // result text -- e.g. an unknown slash command, where the result
        // chunk is the turn's entire output. Sync only that case.
        if (parsed?.type === 'result') {
          return (
            parsed.num_turns === 0
            && typeof parsed.result === 'string'
            && parsed.result.trim().length > 0
          );
        }
        if (typeof parsed?.type === 'string') {
          return !CLAUDE_CODE_TRANSIENT_CHUNK_TYPES.has(parsed.type);
        }
      } catch {
        // Non-JSON content -- let it through; the persistence path only
        // writes plain text via a wrapper, never as a transient type.
      }
    }
    return true;
  }

  // Everything else, including Gemini. Gemini has no branch on purpose: it
  // writes three row kinds (prompt, answer, tool) and its parser renders all
  // three, so a filter here could only take something off mobile that desktop
  // shows. `syncContentTruncator.test.ts` pins that.
  return true;
}

interface PerSourceStats {
  messages: number;
  bytesBefore: number;
  bytesAfter: number;
}

interface CumulativeSyncTruncationStats {
  totalMessages: number;
  messagesWithTruncation: number;
  totalBytesBefore: number;
  totalBytesAfter: number;
  blocksTruncated: number;
  elidedBytes: number;
  largestBlockElidedBytes: number;
  /** Per-source totals so we can see e.g. how much codex traffic is going
   *  through untruncated vs how much claude-code is being trimmed. */
  bySource: Record<string, PerSourceStats>;
  /** Histogram of pre-truncation block sizes (only counts blocks that crossed the threshold). */
  blockSizeBuckets: {
    '8K-32K': number;
    '32K-128K': number;
    '128K-1M': number;
    '1M-10M': number;
    '>10M': number;
  };
}

function emptyPerMessage(bytesBefore: number): PerMessageTruncationStats {
  return {
    bytesBefore,
    bytesAfter: bytesBefore,
    blocksTruncated: 0,
    elidedBytes: 0,
    largestBlockElidedBytes: 0,
  };
}

/**
 * Find which size bucket a block belongs to. Mirrors the cleanup script's
 * bucket scheme so we can correlate "bytes elided here" with "bytes saved
 * on the DO side".
 */
function bucketForSize(bytes: number): keyof CumulativeSyncTruncationStats['blockSizeBuckets'] {
  if (bytes < 32 * 1024) return '8K-32K';
  if (bytes < 128 * 1024) return '32K-128K';
  if (bytes < 1024 * 1024) return '128K-1M';
  if (bytes < 10 * 1024 * 1024) return '1M-10M';
  return '>10M';
}

/**
 * Replace the `content` of one tool_result block with a truncated version.
 * Returns null when the block was already under threshold (caller should skip).
 *
 * tool_result `content` can be:
 *   - a plain string (the common case for Bash, Grep, etc.)
 *   - an array of `{ type: 'text', text }` items (sometimes with image blocks)
 *   - some other JSON shape (rare; we leave it alone)
 */
function truncateBlockContent(
  content: unknown,
): { content: string | unknown[]; originalBytes: number; truncatedBytes: number } | null {
  if (typeof content === 'string') {
    const originalBytes = utf8ByteLen(content);
    if (originalBytes <= TRUNCATE_THRESHOLD_BYTES || isStructuredSyncResult(content)) return null;
    // Keep a complete UTF-8 prefix, including for emoji and non-Latin output.
    const keep = syncTextPrefix(content, TRUNCATE_THRESHOLD_BYTES);
    const elided = originalBytes - utf8ByteLen(keep);
    const marker = `\n\n[... ${formatBytes(elided)} elided from mobile sync; view on desktop for full output]`;
    const out = keep + marker;
    return { content: out, originalBytes, truncatedBytes: utf8ByteLen(out) };
  }

  if (Array.isArray(content)) {
    const originalBytes = utf8ByteLen(JSON.stringify(content));
    if (originalBytes <= TRUNCATE_THRESHOLD_BYTES) return null;
    // Truncate the text-type entries. Image entries pass through so the phone
    // can actually render the screenshot, unless a single one is too big to be
    // worth the wire cost -- then it alone is swapped for a marker.
    const out: unknown[] = [];
    let budget = TRUNCATE_THRESHOLD_BYTES;
    let elided = 0;
    for (const item of content) {
      if (
        item != null &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        const text = (item as { text: string }).text;
        if (isStructuredSyncResult(text)) {
          out.push(item);
          continue;
        }
        if (budget <= 0) {
          elided += utf8ByteLen(text);
          continue;
        }
        if (utf8ByteLen(text) <= budget) {
          out.push(item);
          budget -= utf8ByteLen(text);
        } else {
          const kept = syncTextPrefix(text, budget);
          out.push({ ...(item as object), text: kept });
          elided += utf8ByteLen(text) - utf8ByteLen(kept);
          budget = 0;
        }
      } else if (isImageBlock(item)) {
        const bytes = utf8ByteLen(JSON.stringify(item));
        const shrunk = shrinkImageBlockForSync(item);
        if (shrunk === null) {
          out.push(makeImageMarkerBlock(bytes));
          elided += bytes;
        } else {
          out.push(shrunk);
          elided += bytes - utf8ByteLen(JSON.stringify(shrunk));
        }
      } else {
        out.push(item);
      }
    }
    if (elided > 0) {
      out.push({
        type: 'text',
        text: `\n\n[... ${formatBytes(elided)} elided from mobile sync; view on desktop for full output]`,
      });
    }
    return { content: out, originalBytes, truncatedBytes: utf8ByteLen(JSON.stringify(out)) };
  }

  return null;
}

/** Read the base64 payload out of either image block shape. */
function readImageBlockData(block: unknown): { data: string; mimeType: string } | null {
  const b = block as {
    data?: unknown;
    mimeType?: unknown;
    source?: { data?: unknown; media_type?: unknown };
  };
  if (typeof b.source?.data === 'string') {
    return {
      data: b.source.data,
      mimeType: typeof b.source.media_type === 'string' ? b.source.media_type : 'image/png',
    };
  }
  if (typeof b.data === 'string') {
    return {
      data: b.data,
      mimeType: typeof b.mimeType === 'string' ? b.mimeType : 'image/png',
    };
  }
  return null;
}

/** Rebuild an image block with new bytes, preserving whichever shape it had. */
function withImageBlockData(block: unknown, data: string, mimeType: string): unknown {
  const b = block as { source?: { data?: unknown } };
  if (typeof b.source?.data === 'string') {
    return { ...(block as object), source: { ...b.source, data, media_type: mimeType } };
  }
  return { ...(block as object), data, mimeType };
}

/**
 * Bring one image block under MAX_SYNC_IMAGE_BLOCK_BYTES, downscaling via the
 * registered compressor when one is available. Returns null when the image is
 * still too large to sync (caller substitutes a marker).
 */
function shrinkImageBlockForSync(block: unknown): unknown | null {
  if (utf8ByteLen(JSON.stringify(block)) <= MAX_SYNC_IMAGE_BLOCK_BYTES) return block;
  if (!syncImageCompressor) return null;

  const image = readImageBlockData(block);
  if (!image) return null;

  try {
    const compressed = syncImageCompressor(image.data, image.mimeType);
    if (!compressed?.data || compressed.data.length >= image.data.length) return null;
    const rebuilt = withImageBlockData(block, compressed.data, compressed.mimeType);
    return utf8ByteLen(JSON.stringify(rebuilt)) <= MAX_SYNC_IMAGE_BLOCK_BYTES ? rebuilt : null;
  } catch {
    // A corrupt or undecodable image must never break the sync of the message
    // around it -- fall through to the marker.
    return null;
  }
}

function makeImageMarkerBlock(bytes: number): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: `[Image (${formatBytes(bytes)}) elided from mobile sync; view on desktop]`,
  };
}

/** Does this claude-code message still carry an image the phone can render? */
function messageCarriesImageBlock(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const blocks = (parsed as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => {
    if (isImageBlock(block)) return true;
    const content = (block as { content?: unknown } | null)?.content;
    return Array.isArray(content) && content.some(isImageBlock);
  });
}

/**
 * Retain the existing image-size policy independently of logical row size.
 * Conversation, tool identities and schemas remain parseable and intact.
 */
function stripImageBlocksInPlace(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const blocks = (parsed as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(blocks)) return false;

  let modified = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (isImageBlock(block)) {
      blocks[i] = makeImageMarkerBlock(utf8ByteLen(JSON.stringify(block)));
      modified = true;
      continue;
    }
    const content = (block as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      if (!isImageBlock(content[j])) continue;
      content[j] = makeImageMarkerBlock(utf8ByteLen(JSON.stringify(content[j])));
      modified = true;
    }
  }
  return modified;
}

/**
 * Replace a row that would still exceed the server's inline limit with the
 * pre-#1711 marker, which phones already render. Sets `stats.bytesAfter`.
 */
/** The pre-#1711 whole-row marker, which phones already render. */
export function wholeRowElisionMarker(source: string, rawBytes: number): string {
  return `[Full ${source || 'unknown'} message elided from mobile sync: ${formatBytes(rawBytes)} raw. View on desktop for the full content.]`;
}

function clampWholeRow(content: string, source: string, stats: PerMessageTruncationStats): string {
  const bytes = utf8ByteLen(content);
  // Escaping at most sextuples a byte (\u00XX), so short rows skip the stringify.
  if (bytes * 6 + 2 <= MAX_SYNC_ROW_CONTENT_BYTES || utf8ByteLen(JSON.stringify(content)) <= MAX_SYNC_ROW_CONTENT_BYTES) {
    stats.bytesAfter = bytes;
    return content;
  }
  const marker = wholeRowElisionMarker(source, stats.bytesBefore);
  const elided = bytes - utf8ByteLen(marker);
  stats.bytesAfter = utf8ByteLen(marker);
  stats.blocksTruncated++;
  stats.elidedBytes += elided;
  if (elided > stats.largestBlockElidedBytes) stats.largestBlockElidedBytes = elided;
  return marker;
}

class SyncTruncationTracker {
  private stats: CumulativeSyncTruncationStats = {
    totalMessages: 0,
    messagesWithTruncation: 0,
    totalBytesBefore: 0,
    totalBytesAfter: 0,
    blocksTruncated: 0,
    elidedBytes: 0,
    largestBlockElidedBytes: 0,
    bySource: {},
    blockSizeBuckets: { '8K-32K': 0, '32K-128K': 0, '128K-1M': 0, '1M-10M': 0, '>10M': 0 },
  };
  private lastLogAt = Date.now();

  record(stats: PerMessageTruncationStats, blockBytesBefore: number[], source: string): void {
    this.stats.totalMessages++;
    this.stats.totalBytesBefore += stats.bytesBefore;
    this.stats.totalBytesAfter += stats.bytesAfter;
    this.stats.blocksTruncated += stats.blocksTruncated;
    this.stats.elidedBytes += stats.elidedBytes;
    if (stats.largestBlockElidedBytes > this.stats.largestBlockElidedBytes) {
      this.stats.largestBlockElidedBytes = stats.largestBlockElidedBytes;
    }
    if (stats.blocksTruncated > 0) this.stats.messagesWithTruncation++;
    for (const size of blockBytesBefore) {
      this.stats.blockSizeBuckets[bucketForSize(size)]++;
    }

    const sourceKey = source || 'unknown';
    const bucket = this.stats.bySource[sourceKey] ?? { messages: 0, bytesBefore: 0, bytesAfter: 0 };
    bucket.messages++;
    bucket.bytesBefore += stats.bytesBefore;
    bucket.bytesAfter += stats.bytesAfter;
    this.stats.bySource[sourceKey] = bucket;

    const now = Date.now();
    const byCount = this.stats.totalMessages % LOG_EVERY_N_MESSAGES === 0;
    const byTime = now - this.lastLogAt >= LOG_INTERVAL_MS;
    if (byCount || byTime) {
      this.logSummary();
      this.lastLogAt = now;
    }
  }

  /** Snapshot of the on-wire totals, suitable for inlining into a single
   *  per-message log line so each per-message savings shows up against the
   *  running total. */
  runningTotalsString(): string {
    const s = this.stats;
    const saved = s.totalBytesBefore - s.totalBytesAfter;
    const pct = s.totalBytesBefore > 0 ? (saved / s.totalBytesBefore) * 100 : 0;
    return (
      `total sync ${formatBytes(s.totalBytesBefore)} → ${formatBytes(s.totalBytesAfter)} ` +
      `(saved ${formatBytes(saved)}, ${pct.toFixed(1)}%) over ${s.totalMessages} msgs`
    );
  }

  logSummary(): void {
    const s = this.stats;
    const saved = s.totalBytesBefore - s.totalBytesAfter;
    const pct = s.totalBytesBefore > 0 ? (saved / s.totalBytesBefore) * 100 : 0;

    // Lead with the big-picture line so the answer to "is my saving big or
    // small in context?" is the first thing you see.
    // eslint-disable-next-line no-console
    // console.log(
    //   `[CollabV3] sync footprint: ${s.totalMessages} msgs, ` +
    //     `raw=${formatBytes(s.totalBytesBefore)} → on-wire=${formatBytes(s.totalBytesAfter)} ` +
    //     `(saved ${formatBytes(saved)}, ${pct.toFixed(1)}%)`,
    // );

    // Per-source breakdown. Sorted by raw bytes so the heaviest source is
    // first; makes it obvious if e.g. codex is dominating untruncated.
    const sourceEntries = Object.entries(s.bySource).sort(
      (a, b) => b[1].bytesBefore - a[1].bytesBefore,
    );
    if (sourceEntries.length > 0) {
      const formatted = sourceEntries
        .map(([name, src]) => {
          const sourceSaved = src.bytesBefore - src.bytesAfter;
          const sourcePct = src.bytesBefore > 0 ? (sourceSaved / src.bytesBefore) * 100 : 0;
          const tag =
            sourceSaved === 0 && src.bytesBefore > 0 ? ' [passthrough]' : ` (${sourcePct.toFixed(0)}% saved)`;
          return `${name}: ${src.messages} msgs, ${formatBytes(src.bytesBefore)} → ${formatBytes(src.bytesAfter)}${tag}`;
        })
        .join(' | ');
      // eslint-disable-next-line no-console
      // console.log(`[CollabV3] sync footprint by source: ${formatted}`);
    }

    if (s.blocksTruncated > 0) {
      const buckets = s.blockSizeBuckets;
      // eslint-disable-next-line no-console
      // console.log(
      //   `[CollabV3] sync truncations: ${s.messagesWithTruncation} msgs hit, ` +
      //     `${s.blocksTruncated} blocks trimmed, max single block elided ${formatBytes(s.largestBlockElidedBytes)} | ` +
      //     `pre-trim block sizes [8-32K:${buckets['8K-32K']} 32-128K:${buckets['32K-128K']} ` +
      //     `128K-1M:${buckets['128K-1M']} 1-10M:${buckets['1M-10M']} >10M:${buckets['>10M']}]`,
      // );
    }
  }

  snapshot(): CumulativeSyncTruncationStats {
    return {
      ...this.stats,
      bySource: Object.fromEntries(
        Object.entries(this.stats.bySource).map(([k, v]) => [k, { ...v }]),
      ),
      blockSizeBuckets: { ...this.stats.blockSizeBuckets },
    };
  }
}

export const syncTruncationTracker = new SyncTruncationTracker();

/**
 * Walk a parsed Claude Code SDK chunk and truncate any oversize tool_result
 * blocks in place. Returns whether anything was modified and per-block sizes
 * for stats. Mutates `parsed`.
 */
function truncateBlocksInPlace(
  parsed: unknown,
  stats: PerMessageTruncationStats,
  blockBytesBefore: number[],
): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const blocks = (parsed as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(blocks)) return false;

  let modified = false;
  for (const block of blocks as Array<{ type?: string; content?: unknown; signature?: unknown }>) {
    if (!block) continue;

    // Extended-thinking blocks arrive as { type:'thinking', thinking, signature }.
    // The `signature` is a ~12 KB base64 blob used only for Anthropic API
    // continuation; mobile renders `thinking` text and never touches the
    // signature, and claude-code resume is driven by the SDK's own session
    // state, not this synced copy. Drop it -- it's the single largest source of
    // dead weight after tool_use_result (often the whole block, since the
    // thinking text is frequently empty/redacted).
    if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0) {
      const sigBytes = utf8ByteLen(block.signature);
      delete block.signature;
      stats.blocksTruncated++;
      stats.elidedBytes += sigBytes;
      if (sigBytes > stats.largestBlockElidedBytes) {
        stats.largestBlockElidedBytes = sigBytes;
      }
      blockBytesBefore.push(sigBytes);
      modified = true;
      continue;
    }

    if (block.type !== 'tool_result') continue;
    const result = truncateBlockContent(block.content);
    if (!result) continue;
    block.content = result.content;
    const elided = result.originalBytes - result.truncatedBytes;
    stats.blocksTruncated++;
    stats.elidedBytes += elided;
    if (elided > stats.largestBlockElidedBytes) {
      stats.largestBlockElidedBytes = elided;
    }
    blockBytesBefore.push(result.originalBytes);
    modified = true;
  }
  return modified;
}

/**
 * Claude Code attaches a top-level `tool_use_result` object to Edit/Write/Read
 * tool-result user messages (filePath, oldString, newString, originalFile,
 * structuredPatch, ...). It lives OUTSIDE `message.content`, so the tool_result
 * block truncation above never touches it. For a large-file edit it can be tens
 * of KB (the full originalFile + patch) even though the tool_result block itself
 * is tiny ("The file ... has been updated"). That pushes the whole message past
 * MAX_SYNC_MESSAGE_BYTES and into the opaque whole-message marker -- which the
 * mobile parser, unable to JSON.parse it, renders as a stray assistant bubble
 * desktop never shows. No transcript consumer reads tool_use_result, so trim its
 * oversized fields here while keeping the small ones (filePath, userModified)
 * and the surrounding message structure parseable.
 */
function truncateClaudeToolUseResultInPlace(
  parsed: unknown,
  stats: PerMessageTruncationStats,
  blockBytesBefore: number[],
): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const tur = (parsed as { tool_use_result?: unknown }).tool_use_result;
  if (!tur || typeof tur !== 'object') return false;

  const turObj = tur as Record<string, unknown>;
  let modified = false;

  for (const key of Object.keys(turObj)) {
    // #1711: AskUserQuestion-style sidecars carry the user's answers.
    if (TOOL_USE_RESULT_PROTECTED_KEYS.has(key)) continue;
    const value = turObj[key];
    let replacement: string | null = null;
    let originalBytes = 0;
    let truncatedBytes = 0;

    if (typeof value === 'string') {
      const result = truncateBlockContent(value);
      if (result && typeof result.content === 'string') {
        replacement = result.content;
        originalBytes = result.originalBytes;
        truncatedBytes = result.truncatedBytes;
      }
    } else if (value && typeof value === 'object') {
      // Structured fields (e.g. structuredPatch arrays). Collapse to a compact
      // marker when oversized; the renderer doesn't consume them.
      const json = JSON.stringify(value);
      const bytes = utf8ByteLen(json);
      if (bytes > TRUNCATE_THRESHOLD_BYTES) {
        const marker = `[... ${formatBytes(bytes)} elided from mobile sync; view on desktop for full output]`;
        replacement = marker;
        originalBytes = bytes;
        truncatedBytes = utf8ByteLen(marker);
      }
    }

    if (replacement !== null) {
      turObj[key] = replacement;
      const elided = originalBytes - truncatedBytes;
      stats.blocksTruncated++;
      stats.elidedBytes += elided;
      if (elided > stats.largestBlockElidedBytes) {
        stats.largestBlockElidedBytes = elided;
      }
      blockBytesBefore.push(originalBytes);
      modified = true;
    }
  }
  return modified;
}

/**
 * Walk a parsed Codex event and truncate any oversize fields on its `item`
 * record in place. SDK events look like
 *   { type: 'item.completed', item: { type: 'command_execution',
 *     aggregated_output: '...full shell stdout...' } }
 * while app-server events wrap the item under `{ method, params: { item } }`
 * and currently use camel-case command fields. MCP results are structured as
 * `{ result: { content: [{ type: 'text', text: '...' }] } }`.
 */
const CODEX_TRUNCATE_FIELDS = ['aggregated_output', 'aggregatedOutput', 'output', 'result'] as const;

function recordCodexTruncation(
  originalBytes: number,
  truncatedBytes: number,
  stats: PerMessageTruncationStats,
  blockBytesBefore: number[],
): void {
  const elided = originalBytes - truncatedBytes;
  stats.blocksTruncated++;
  stats.elidedBytes += elided;
  if (elided > stats.largestBlockElidedBytes) {
    stats.largestBlockElidedBytes = elided;
  }
  blockBytesBefore.push(originalBytes);
}

function truncateCodexStructuredResultInPlace(
  value: unknown,
  stats: PerMessageTruncationStats,
  blockBytesBefore: number[],
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const resultObj = value as Record<string, unknown>;
  let modified = false;

  const result = truncateBlockContent(resultObj.content);
  if (result) {
    resultObj.content = result.content;
    recordCodexTruncation(result.originalBytes, result.truncatedBytes, stats, blockBytesBefore);
    modified = true;
  }

  return modified;
}

function truncateCodexItemInPlace(
  parsed: unknown,
  stats: PerMessageTruncationStats,
  blockBytesBefore: number[],
): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const parsedRecord = parsed as { item?: unknown; params?: { item?: unknown } };
  const item = parsedRecord.item ?? parsedRecord.params?.item;
  if (!item || typeof item !== 'object') return false;

  const itemObj = item as Record<string, unknown>;
  if (isInteractiveSyncItem(itemObj)) return false;
  if (!['commandExecution', 'command_execution', 'mcpToolCall', 'mcp_tool_call'].includes(String(itemObj.type))) return false;
  let modified = false;

  for (const field of CODEX_TRUNCATE_FIELDS) {
    const value = itemObj[field];
    if (field === 'result' && truncateCodexStructuredResultInPlace(value, stats, blockBytesBefore)) {
      modified = true;
      continue;
    }

    const result = truncateBlockContent(value);
    if (!result) continue;
    itemObj[field] = result.content;
    recordCodexTruncation(result.originalBytes, result.truncatedBytes, stats, blockBytesBefore);
    modified = true;
  }
  return modified;
}

/**
 * Trim large tool_result blocks out of a sync-bound message.
 *
 * @param rawContent  The `content` string from AgentMessage (provider's raw
 *                    JSON or text).
 * @param source      The AgentMessage source (e.g. 'claude-code'). Used to
 *                    decide whether to attempt parsing.
 */
export function truncateContentForSync(
  rawContent: string,
  source: string,
): { content: string; stats: PerMessageTruncationStats } {
  const bytesBefore = utf8ByteLen(rawContent);
  const stats = emptyPerMessage(bytesBefore);

  const sourceKey = source || 'unknown';
  const isCodex = sourceKey.startsWith('openai-codex') || sourceKey.startsWith('opencode');
  // Plain-text content is conversation and stays whole up to the row clamp.
  // JSON rows from any source get the shape-based output bounds below, so an
  // unrecognized provider cannot ship raw tool output.
  let parsed: unknown;
  try { parsed = JSON.parse(rawContent); }
  catch {
    const content = clampWholeRow(rawContent, sourceKey, stats);
    syncTruncationTracker.record(stats, [], sourceKey);
    return { content, stats };
  }

  const blockBytesBefore: number[] = [];
  let modified = false;
  if (isCodex) {
    modified = truncateCodexItemInPlace(parsed, stats, blockBytesBefore);
  } else {
    // Run both: tool_result blocks live in message.content, tool_use_result is a
    // top-level sibling. Either can be the oversized part. Both walkers match
    // on shape, so they are also the fallback for unrecognized sources.
    const blocksModified = truncateBlocksInPlace(parsed, stats, blockBytesBefore);
    const turModified = truncateClaudeToolUseResultInPlace(parsed, stats, blockBytesBefore);
    modified = blocksModified || turModified;
  }
  const beforeAggregate = utf8ByteLen(modified ? JSON.stringify(parsed) : rawContent);
  if (boundSyncOutputs(parsed)) {
    modified = true;
    recordCodexTruncation(beforeAggregate, utf8ByteLen(JSON.stringify(parsed)), stats, blockBytesBefore);
  }
  let providerContent = modified ? JSON.stringify(parsed) : rawContent;

  // A surviving image block buys a bigger ceiling -- see
  // MAX_SYNC_MESSAGE_WITH_IMAGE_BYTES. If even that isn't enough, drop the
  // images rather than the message, so mobile gets parseable JSON.
  if (utf8ByteLen(providerContent) > MAX_SYNC_MESSAGE_BYTES && messageCarriesImageBlock(parsed)) {
    if (utf8ByteLen(providerContent) > MAX_SYNC_MESSAGE_WITH_IMAGE_BYTES) {
      if (stripImageBlocksInPlace(parsed)) providerContent = JSON.stringify(parsed);
    }
  }

  providerContent = clampWholeRow(providerContent, sourceKey, stats);

  syncTruncationTracker.record(stats, blockBytesBefore, sourceKey);

  // Per-message log so we can see truncation happening in real time. The
  // running-totals suffix gives a "is this a drop in the bucket or huge"
  // sense without having to wait for the periodic rollup line.
  // eslint-disable-next-line no-console
  // console.log(
  //   `[CollabV3] sync-truncation: msg ${formatBytes(stats.bytesBefore)} → ${formatBytes(stats.bytesAfter)} ` +
  //     `(saved ${formatBytes(stats.elidedBytes)} across ${stats.blocksTruncated} block(s)) | ` +
  //     syncTruncationTracker.runningTotalsString(),
  // );

  return { content: providerContent, stats };
}
