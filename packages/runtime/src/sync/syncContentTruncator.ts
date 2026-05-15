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
 *   - Per `tool_result` block: cap content at TRUNCATE_THRESHOLD_BYTES and
 *     splice in a human-readable marker explaining the elision.
 *   - Truncate per-block, not per-message -- a message with one big result and
 *     three small ones keeps the small ones intact.
 *   - Leave `tool_use` blocks alone regardless of size; that's the "what
 *     happened" signal users actually want on mobile.
 *   - Pass-through if the content doesn't parse as the expected Claude Code
 *     SDK shape; Codex and other providers go through unmodified for now.
 *
 * Stats: a singleton tracker accumulates byte-savings across the process so we
 * can validate the impact locally before deploying. It self-logs periodically
 * (every N messages or every M seconds, whichever comes first) and exposes a
 * snapshot for inspection.
 */

const TRUNCATE_THRESHOLD_BYTES = 8 * 1024;
const LOG_EVERY_N_MESSAGES = 25;
const LOG_INTERVAL_MS = 30_000;

export interface PerMessageTruncationStats {
  bytesBefore: number;
  bytesAfter: number;
  blocksTruncated: number;
  elidedBytes: number;
  largestBlockElidedBytes: number;
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
    console.log(
      `[CollabV3] sync footprint: ${s.totalMessages} msgs, ` +
        `raw=${formatBytes(s.totalBytesBefore)} → on-wire=${formatBytes(s.totalBytesAfter)} ` +
        `(saved ${formatBytes(saved)}, ${pct.toFixed(1)}%)`,
    );

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
      console.log(`[CollabV3] sync footprint by source: ${formatted}`);
    }

    if (s.blocksTruncated > 0) {
      const buckets = s.blockSizeBuckets;
      // eslint-disable-next-line no-console
      console.log(
        `[CollabV3] sync truncations: ${s.messagesWithTruncation} msgs hit, ` +
          `${s.blocksTruncated} blocks trimmed, max single block elided ${formatBytes(s.largestBlockElidedBytes)} | ` +
          `pre-trim block sizes [8-32K:${buckets['8K-32K']} 32-128K:${buckets['32K-128K']} ` +
          `128K-1M:${buckets['128K-1M']} 1-10M:${buckets['1M-10M']} >10M:${buckets['>10M']}]`,
      );
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
  for (const block of blocks as Array<{ type?: string; content?: unknown }>) {
    if (!block || block.type !== 'tool_result') continue;
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
    syncTruncationTracker.record(stats, [], sourceKey);
    return { content: rawContent, stats };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    syncTruncationTracker.record(stats, [], sourceKey);
    return { content: rawContent, stats };
  }

  const blockBytesBefore: number[] = [];
  const modified = isClaudeCode
    ? truncateBlocksInPlace(parsed, stats, blockBytesBefore)
    : truncateCodexItemInPlace(parsed, stats, blockBytesBefore);
  if (!modified) {
    syncTruncationTracker.record(stats, [], sourceKey);
    return { content: rawContent, stats };
  }

  const newContent = JSON.stringify(parsed);
  stats.bytesAfter = utf8ByteLen(newContent);

  syncTruncationTracker.record(stats, blockBytesBefore, sourceKey);

  // Per-message log so we can see truncation happening in real time. The
  // running-totals suffix gives a "is this a drop in the bucket or huge"
  // sense without having to wait for the periodic rollup line.
  // eslint-disable-next-line no-console
  console.log(
    `[CollabV3] sync-truncation: msg ${formatBytes(stats.bytesBefore)} → ${formatBytes(stats.bytesAfter)} ` +
      `(saved ${formatBytes(stats.elidedBytes)} across ${stats.blocksTruncated} block(s)) | ` +
      syncTruncationTracker.runningTotalsString(),
  );

  return { content: newContent, stats };
}
