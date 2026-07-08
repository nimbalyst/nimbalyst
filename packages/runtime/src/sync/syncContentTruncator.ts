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
 *   - Then clamp the whole sync-bound message at MAX_SYNC_MESSAGE_BYTES so a
 *     few pathological rows cannot still blow up a SessionRoom.
 *   - Leave `tool_use` blocks alone regardless of size; that's the "what
 *     happened" signal users actually want on mobile.
 *   - Unknown providers fall back to a compact opaque marker rather than
 *     syncing arbitrarily large raw payloads.
 *
 * Stats: a singleton tracker accumulates byte-savings across the process so we
 * can validate the impact locally before deploying. It self-logs periodically
 * (every N messages or every M seconds, whichever comes first) and exposes a
 * snapshot for inspection.
 */

const TRUNCATE_THRESHOLD_BYTES = 4 * 1024;
const MAX_SYNC_MESSAGE_BYTES = 16 * 1024;
const LOG_EVERY_N_MESSAGES = 25;
const LOG_INTERVAL_MS = 30_000;

const CODEX_APP_SERVER_TRANSIENT_EVENT_TYPES = new Set([
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'thread/status/changed',
  'mcpServer/startupStatus/updated',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'skills/changed',
]);

// Claude Agent SDK chunk types whose persisted form never renders -- they only
// drive live in-memory side effects in ClaudeCodeProvider. The provider now
// skips persisting these, but this sync-side filter catches the same chunks if
// they're already sitting in ai_agent_messages from before the persistence fix
// (e.g. older sessions replayed on first reconnect).
const CLAUDE_CODE_TRANSIENT_CHUNK_TYPES = new Set([
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'rate_limit_event',
]);
const CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_response',
  'task_started',
  'task_progress',
  'task_notification',
  // Live "estimated thinking tokens" progress ticks. A long turn emits dozens
  // (190 in one observed session, ~37 KB + 190 extra synced rows). They drive a
  // live in-memory indicator only and produce no descriptor on reparse, so they
  // are pure waste on the wire.
  'thinking_tokens',
]);

// System subtypes that ARE persisted locally (so the desktop's own transcript
// build can read e.g. the SDK session_id) but must NOT cross the sync wire.
// `system/init` is ~17 KB of tools / mcp_servers / slash_commands metadata that
// no transcript consumer renders (the raw-message parsers ignore it entirely).
// Worse, it tripped MAX_SYNC_MESSAGE_BYTES and the whole-message clamp rewrote
// it into a bare "[Full claude-code message elided...]" marker string. On
// mobile that string fails JSON.parse and falls through to the plain-text
// assistant branch, rendering a stray bubble desktop never shows. Drop it.
const CLAUDE_CODE_NON_SYNCED_SYSTEM_SUBTYPES = new Set(['init']);

export interface PerMessageTruncationStats {
  bytesBefore: number;
  bytesAfter: number;
  blocksTruncated: number;
  elidedBytes: number;
  largestBlockElidedBytes: number;
}

export function shouldSyncMessageForSessionRoom(
  source: string,
  metadata?: Record<string, unknown> | null,
  content?: string,
): boolean {
  if (source.startsWith('openai-codex') || source.startsWith('opencode')) {
    const transport = typeof metadata?.transport === 'string' ? metadata.transport : '';
    const eventType = typeof metadata?.eventType === 'string' ? metadata.eventType : '';

    if (transport !== 'app-server') {
      return true;
    }

    return !CODEX_APP_SERVER_TRANSIENT_EVENT_TYPES.has(eventType);
  }

  if (source === 'claude-code' && content) {
    // Cheap structural prefilter: only parse JSON when the content could
    // be one of the transient chunk shapes. Skips the JSON.parse for the
    // overwhelmingly common assistant / user / result chunks.
    if (
      content.includes('"type":"system"')
      || content.includes('"type":"tool_progress"')
      || content.includes('"type":"tool_use_summary"')
      || content.includes('"type":"auth_status"')
      || content.includes('"type":"rate_limit_event"')
    ) {
      try {
        const parsed = JSON.parse(content) as { type?: string; subtype?: string };
        if (parsed?.type === 'system' && typeof parsed.subtype === 'string') {
          return (
            !CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES.has(parsed.subtype)
            && !CLAUDE_CODE_NON_SYNCED_SYSTEM_SUBTYPES.has(parsed.subtype)
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

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** UTF-8 byte length of a string. JSON.stringify result is ASCII-heavy but
 * tool output may include non-ASCII; use Blob to get the real wire size. */
function utf8ByteLen(s: string): number {
  // TextEncoder is available in both Node and Workers; fall back to char count
  // if missing (vanishingly unlikely in our runtime).
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  return s.length;
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
    if (originalBytes <= TRUNCATE_THRESHOLD_BYTES) return null;
    // We slice on character count; the resulting byte count is close enough to
    // the threshold for our purposes (no need to be perfectly precise).
    const keep = content.slice(0, TRUNCATE_THRESHOLD_BYTES);
    const elided = originalBytes - utf8ByteLen(keep);
    const marker = `\n\n[... ${formatBytes(elided)} elided from mobile sync; view on desktop for full output]`;
    const out = keep + marker;
    return { content: out, originalBytes, truncatedBytes: utf8ByteLen(out) };
  }

  if (Array.isArray(content)) {
    const originalBytes = utf8ByteLen(JSON.stringify(content));
    if (originalBytes <= TRUNCATE_THRESHOLD_BYTES) return null;
    // Truncate only the text-type entries. Non-text entries (images, etc.)
    // pass through unchanged -- they're small and structurally important.
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
        if (budget <= 0) {
          elided += utf8ByteLen(text);
          continue;
        }
        if (text.length <= budget) {
          out.push(item);
          budget -= text.length;
        } else {
          const kept = text.slice(0, budget);
          out.push({ ...(item as object), text: kept });
          elided += utf8ByteLen(text) - utf8ByteLen(kept);
          budget = 0;
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

function makeWholeMessageMarker(source: string, originalBytes: number): string {
  const label = source || 'unknown';
  return (
    `[Full ${label} message elided from mobile sync: ${formatBytes(originalBytes)} raw. ` +
    `View on desktop for the full content.]`
  );
}

function clampWholeMessage(
  content: string,
  source: string,
): { content: string; bytesAfter: number; elidedBytes: number } {
  const bytesBefore = utf8ByteLen(content);
  if (bytesBefore <= MAX_SYNC_MESSAGE_BYTES) {
    return { content, bytesAfter: bytesBefore, elidedBytes: 0 };
  }

  const marker = makeWholeMessageMarker(source, bytesBefore);
  return {
    content: marker,
    bytesAfter: utf8ByteLen(marker),
    elidedBytes: bytesBefore - utf8ByteLen(marker),
  };
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
 * Walk a parsed Codex SDK event and truncate any oversize string fields on
 * its `item` record in place. Codex events look like
 *   { type: 'item.completed', item: { type: 'command_execution',
 *     aggregated_output: '...full shell stdout...' } }
 * with the bloat almost always in `aggregated_output`. `output` and `result`
 * are also listed because the Codex tool-call extractor in
 * `codexEventParser.ts` accepts them as aliases for the same payload.
 */
const CODEX_TRUNCATE_FIELDS = ['aggregated_output', 'output', 'result'] as const;

function truncateCodexItemInPlace(
  parsed: unknown,
  stats: PerMessageTruncationStats,
  blockBytesBefore: number[],
): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const item = (parsed as { item?: unknown }).item;
  if (!item || typeof item !== 'object') return false;

  const itemObj = item as Record<string, unknown>;
  let modified = false;

  for (const field of CODEX_TRUNCATE_FIELDS) {
    const value = itemObj[field];
    if (typeof value !== 'string') continue;
    const result = truncateBlockContent(value);
    if (!result) continue;
    itemObj[field] = result.content;
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

  // Route to a provider-specific walker. Sources we don't yet understand pass
  // through unchanged so we don't risk corrupting messages, but their bytes
  // still feed the cumulative tracker so the rollup can surface "X MB of
  // provider Y went through untruncated".
  const sourceKey = source || 'unknown';
  const isClaudeCode = source != null && source.startsWith('claude-code');
  const isCodex =
    source != null && (source.startsWith('openai-codex') || source.startsWith('opencode'));
  if (!isClaudeCode && !isCodex) {
    const wholeClamp = clampWholeMessage(rawContent, sourceKey);
    stats.bytesAfter = wholeClamp.bytesAfter;
    if (wholeClamp.elidedBytes > 0) {
      stats.blocksTruncated = 1;
      stats.elidedBytes = wholeClamp.elidedBytes;
      stats.largestBlockElidedBytes = wholeClamp.elidedBytes;
    }
    syncTruncationTracker.record(stats, [], sourceKey);
    return { content: wholeClamp.content, stats };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const wholeClamp = clampWholeMessage(rawContent, sourceKey);
    stats.bytesAfter = wholeClamp.bytesAfter;
    if (wholeClamp.elidedBytes > 0) {
      stats.blocksTruncated = 1;
      stats.elidedBytes = wholeClamp.elidedBytes;
      stats.largestBlockElidedBytes = wholeClamp.elidedBytes;
    }
    syncTruncationTracker.record(stats, [], sourceKey);
    return { content: wholeClamp.content, stats };
  }

  const blockBytesBefore: number[] = [];
  let modified: boolean;
  if (isClaudeCode) {
    // Run both: tool_result blocks live in message.content, tool_use_result is a
    // top-level sibling. Either can be the oversized part.
    const blocksModified = truncateBlocksInPlace(parsed, stats, blockBytesBefore);
    const turModified = truncateClaudeToolUseResultInPlace(parsed, stats, blockBytesBefore);
    modified = blocksModified || turModified;
  } else {
    modified = truncateCodexItemInPlace(parsed, stats, blockBytesBefore);
  }
  const providerContent = modified ? JSON.stringify(parsed) : rawContent;
  const wholeClamp = clampWholeMessage(providerContent, sourceKey);
  stats.bytesAfter = wholeClamp.bytesAfter;
  if (wholeClamp.elidedBytes > 0) {
    stats.blocksTruncated++;
    stats.elidedBytes += wholeClamp.elidedBytes;
    if (wholeClamp.elidedBytes > stats.largestBlockElidedBytes) {
      stats.largestBlockElidedBytes = wholeClamp.elidedBytes;
    }
  }

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

  return { content: wholeClamp.content, stats };
}
