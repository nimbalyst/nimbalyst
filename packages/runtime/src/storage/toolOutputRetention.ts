/**
 * toolOutputRetention -- rewrite aged tool output into a tombstone.
 *
 * Layer 2 of the storage plan. `toolOutputBudget` bounds what a NEW message
 * costs; this reclaims what is already on disk. On the measured install, tool
 * results older than 30 days were 3.1 GB of a 7.1 GB table.
 *
 * The transcript is projected from raw messages on read (migration 0005
 * dropped the canonical events table), so raw is the only copy. We therefore
 * rewrite the payload rather than deleting the row: the tool card still
 * renders in sequence with its name, arguments and success/error status, and
 * only the output body reads as discarded. Deleting the row instead would make
 * the call render as though it never returned.
 *
 * This module is pure -- it takes a content string and returns a content
 * string. Row selection, batching and lane discipline are the driver's job
 * (see `toolOutputRetentionPass` in the electron package). Keeping the rewrite
 * pure is what lets a test assert that a tombstoned row still parses to the
 * same transcript event shape.
 */
import { formatBytes, utf8ByteLen, isImageBlock } from '../utils/contentBytes';
import { providerPayloadSlots, type PayloadSlot, type PayloadSlotKind } from './providerPayloadSlots';

/** Recognizable in the UI and greppable in a bug report. */
export function tombstoneMarker(bytes: number, isoDate: string): string {
  const day = isoDate.slice(0, 10);
  return `[Output discarded to reclaim disk — ${formatBytes(bytes)}, ${day}]`;
}

/**
 * Marker for a discarded image. Shares the tombstone prefix so `isTombstoned`
 * and a grep both find it, and names the media type so the card can still say
 * what was there.
 */
export function imageTombstoneMarker(block: unknown, bytes: number, isoDate: string): string {
  const b = block as { mimeType?: unknown; source?: { media_type?: unknown } } | null;
  const mediaType = typeof b?.source?.media_type === 'string'
    ? b.source.media_type
    : typeof b?.mimeType === 'string' ? b.mimeType : 'image';
  const day = isoDate.slice(0, 10);
  return `[Output discarded to reclaim disk — ${mediaType}, ${formatBytes(bytes)}, ${day}]`;
}

/**
 * Already-tombstoned payloads must not be rewritten again (the pass has to be
 * idempotent so it can resume after a crash without compounding markers).
 */
const TOMBSTONE_PREFIX = '[Output discarded to reclaim disk';

export function isTombstoned(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(TOMBSTONE_PREFIX);
}

/** Below this, the marker would cost about as much as the payload it replaces. */
const TOMBSTONE_MIN_BYTES = 512;

/**
 * Whether the retention pass may rewrite a given slot.
 *
 * Two kinds are deliberately declined:
 *
 * `nimbalystToolResult` -- Nimbalyst's own tool-result envelope. For an
 * AskUserQuestion call, its `result` is the USER'S ANSWERS: their own words,
 * around 1 KB (comfortably over the threshold), with no server copy anywhere.
 * The row records `tool_use_id` but NOT the tool name -- that lives on the
 * separate `nimbalyst_tool_use` row -- so a per-row pure rewrite cannot tell an
 * answer from a database dump. Discriminating by size or by sniffing the body
 * would be destroying user data on a heuristic, which
 * `.claude/rules/destructive-data-paths.md` forbids. We decline the whole shape
 * until a driver can join the call row and supply the name. That leaves real
 * bytes unreclaimed; losing a user's answers is not a trade worth making.
 *
 * `claudeThinkingSignature` -- not tool output, and it wants deletion rather
 * than a marker. `slimClaudeCodeChunkForStorage` already strips it at write
 * time; reclaiming it from history belongs with that pass, not this one.
 */
function isRetentionEligible(kind: PayloadSlotKind): boolean {
  return kind !== 'nimbalystToolResult' && kind !== 'claudeThinkingSignature';
}

/**
 * Tombstone one slot. Returns whether it changed.
 *
 * Idempotency is per SLOT, not per row -- the 2026-08-19 run on the measured
 * install tombstoned `message.content` and left `tool_use_result` intact on
 * roughly one row in four, so "this row has a marker somewhere" is not the same
 * as "this row is done".
 */
function tombstoneSlot(slot: PayloadSlot, isoDate: string): boolean {
  const value = slot.value;

  // An image block in a tool result. Replaced by a text block, which every
  // transcript parser already renders inside a tool result, so the card keeps
  // its place and says an image was here. Images are kept for the retention
  // window like any other output and then go: a screenshot's purpose is being
  // looked at, and nobody looks at a months-old one often enough to justify
  // 300 KB each forever (decision 2026-11-12, NIM-7735 plan).
  if (slot.kind === 'toolResultImage') {
    if (!isImageBlock(value)) return false;
    const bytes = utf8ByteLen(JSON.stringify(value));
    if (bytes < TOMBSTONE_MIN_BYTES) return false;
    slot.set({ type: 'text', text: imageTombstoneMarker(value, bytes, isoDate) });
    return true;
  }

  if (typeof value === 'string') {
    if (isTombstoned(value)) return false;
    const bytes = utf8ByteLen(value);
    if (bytes < TOMBSTONE_MIN_BYTES) return false;
    slot.set(tombstoneMarker(bytes, isoDate));
    return true;
  }

  // Structured payloads -- `structuredPatch` arrays, MCP result objects. The
  // sync truncator already collapses these to a marker string on the same
  // reasoning: no transcript consumer reads them, and leaving tens of KB of
  // duplicated file state on disk forever is the whole problem.
  if (value != null && typeof value === 'object') {
    if (isImageBlock(value)) return false;
    const bytes = utf8ByteLen(JSON.stringify(value));
    if (bytes < TOMBSTONE_MIN_BYTES) return false;
    slot.set(tombstoneMarker(bytes, isoDate));
    return true;
  }

  // Numbers, booleans, null: the scalars that keep the tool card renderable.
  return false;
}

/** Rewrite every eligible slot in place. Returns whether anything changed. */
function tombstoneInPlace(chunk: unknown, source: string, isoDate: string): boolean {
  let changed = false;
  for (const slot of providerPayloadSlots(chunk, source)) {
    if (!isRetentionEligible(slot.kind)) continue;
    if (tombstoneSlot(slot, isoDate)) changed = true;
  }
  return changed;
}

/**
 * Non-mutating wrapper for the exported per-provider helpers. The live dispatch
 * loop hands us chunks it still holds references to, so these must not write
 * through; `tombstoneRawContent` skips the clone because it owns a freshly
 * parsed object.
 */
function tombstoneClone(chunk: unknown, source: string, isoDate: string): unknown | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const clone = JSON.parse(JSON.stringify(chunk));
  return tombstoneInPlace(clone, source, isoDate) ? clone : null;
}

/**
 * Rewrite a claude-code raw chunk's heavy payloads into tombstones: the
 * `tool_result` blocks inside `message.content`, and the top-level
 * `tool_use_result` sidecar that holds the pre-edit file. Returns null when
 * there was nothing eligible, so the driver can skip the UPDATE entirely.
 */
export function tombstoneClaudeCodeChunk(chunk: unknown, isoDate: string): unknown | null {
  return tombstoneClone(chunk, 'claude-code', isoDate);
}

/**
 * Codex analog, covering every transport shape observed on disk: SDK events
 * (`item.aggregated_output`), app-server (`params.item.aggregatedOutput`), MCP
 * results (`item.result`), and ACP (`update.rawOutput.stdout`). Scalars the
 * tool card renders -- id, type, status, command, exitCode -- are untouched.
 */
export function tombstoneAppServerEnvelope(envelope: unknown, isoDate: string): unknown | null {
  return tombstoneClone(envelope, 'openai-codex', isoDate);
}

/**
 * Rewrite one row's `content` column. Returns null when the row is not
 * eligible or already tombstoned, so the driver issues no UPDATE.
 *
 * `source` selects the shape; anything unrecognized is left alone rather than
 * guessed at. Silently rewriting an unknown provider's rows would corrupt a
 * transcript we have no parser knowledge of.
 */
export function tombstoneRawContent(
  content: string,
  source: string,
  isoDate: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  // `parsed` is ours alone -- freshly built from the row's string -- so the
  // slots may write through it without a defensive clone. Shape dispatch lives
  // in `providerPayloadSlots`; an unrecognized source yields no slots and the
  // row is left alone rather than guessed at.
  if (!tombstoneInPlace(parsed, source, isoDate)) return null;

  const out = JSON.stringify(parsed);
  // Never grow a row. A pathological shape (many tiny blocks, each swapped for
  // a longer marker) would otherwise cost more than it reclaims.
  if (out.length >= content.length) return null;
  return out;
}
