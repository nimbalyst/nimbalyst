/**
 * Parses and serializes the body of a ```decision fence.
 *
 * The fence body is YAML, chosen so the block reads correctly on GitHub with no
 * Nimbalyst and so an agent can take the outcome off the raw file with no tool
 * call. YAML parsing lives here rather than in `@nimbalyst/collab-protocol`
 * because that package carries no runtime dependencies at all; it owns the
 * model and the pure logic, this owns the text.
 *
 * **Unknown keys survive.** Once a `decision` fence exists in a user's file the
 * syntax is effectively frozen: a v1 parser that dropped a key a later version
 * wrote would silently destroy it on the next save, in a file whose whole
 * purpose is being a durable record. So the parsed mapping is kept whole on
 * `DecisionBlockSource.raw`, and serialization writes the known keys back over
 * it in a stable order and then appends whatever it did not recognize. The
 * round-trip test that matters is the idempotence one -- export, import, export
 * again, and compare -- not merely that a known fence survives.
 */

import yaml from "js-yaml";
import {
  DECISION_ID_PREFIX,
  buildDecisionSealedRecord,
  checkDecisionSeal,
  isDecisionAskType,
  decisionDefaultVisibility,
  type DecisionBlockSource,
  type DecisionEntrySource,
  type DecisionSealBlockedReason,
  type DecisionSealedRecord,
  type DecisionSealedVote,
  type DecisionResolvedValue,
  type DecisionVote,
} from "@nimbalyst/collab-protocol";

/**
 * Key order for serialization. The question comes first because that is what a
 * reader scanning a diff needs; the sealed record comes last because it is
 * appended by the app and grows.
 */
const KNOWN_KEY_ORDER = [
  "id",
  "ask",
  "description",
  "type",
  "options",
  "items",
  "allowOther",
  "minSelected",
  "maxSelected",
  "minItems",
  "seed",
  "format",
  "placeholder",
  "minLength",
  "maxLength",
  "min",
  "max",
  "step",
  "minLabel",
  "maxLabel",
  "asked",
  "visibility",
  "resolved",
  "resolvedAt",
  "resolvedBy",
  "resolvedFrom",
  "removed",
  "score",
  "distribution",
  "votes",
] as const;

const KNOWN_KEYS = new Set<string>(KNOWN_KEY_ORDER);

/** `options:` and `items:` are interchangeable, so hand-authoring is forgiving. */
const ENTRY_KEYS = ["options", "items"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asIsoString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Accepts both `asked: greg, karl` and a YAML list. The inline comma form is
 * what a person writing the fence by hand reaches for first, and rejecting it
 * would make the syntax feel like a config file rather than a sentence.
 */
function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }
  const text = asString(value);
  if (!text) return [];
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseEntries(raw: Record<string, unknown>): DecisionEntrySource[] {
  for (const key of ENTRY_KEYS) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    const entries: DecisionEntrySource[] = [];
    value.forEach((candidate, index) => {
      // A bare string entry (`- gutter`) is its own id and label. Cheap to
      // support and it is what a short poll looks like when typed by hand.
      if (typeof candidate === "string") {
        entries.push({ id: candidate, label: candidate });
        return;
      }
      const record = asRecord(candidate);
      if (!record) return;
      const id = asString(record.id) ?? `entry-${index + 1}`;
      const entry: DecisionEntrySource = { id, raw: { ...record } };
      const label = asString(record.label);
      const title = asString(record.title);
      const description = asString(record.description);
      const subtitle = asString(record.subtitle);
      const badge = asString(record.badge);
      const artifact = asString(record.artifact);
      const removable = asBoolean(record.removable);
      const defaultChecked = asBoolean(record.defaultChecked);
      if (label !== undefined) entry.label = label;
      if (title !== undefined) entry.title = title;
      if (description !== undefined) entry.description = description;
      if (subtitle !== undefined) entry.subtitle = subtitle;
      if (badge !== undefined) entry.badge = badge;
      if (artifact !== undefined) entry.artifact = artifact;
      if (removable !== undefined) entry.removable = removable;
      if (defaultChecked !== undefined) entry.defaultChecked = defaultChecked;
      entries.push(entry);
    });
    return entries;
  }
  return [];
}

function parseResolved(value: unknown): DecisionResolvedValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return undefined;
}

/**
 * The sealed record's `votes:` is a list of single-key mappings (`- greg:
 * gutter`) rather than a mapping, so two people cannot collide on a key and so
 * the order the app wrote them in is preserved.
 */
function parseSealedVotes(value: unknown): DecisionSealedVote[] {
  if (!Array.isArray(value)) return [];
  const votes: DecisionSealedVote[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (record) {
      const explicit = asString(record.voter);
      if (explicit !== undefined) {
        votes.push({ voter: explicit, value: String(record.value ?? "") });
        continue;
      }
      const [voter, voteValue] = Object.entries(record)[0] ?? [];
      if (voter !== undefined) {
        votes.push({ voter, value: String(voteValue ?? "") });
      }
      continue;
    }
    const text = asString(candidate);
    if (text !== undefined) votes.push({ voter: text, value: "" });
  }
  return votes;
}

function parseSealed(
  raw: Record<string, unknown>
): DecisionSealedRecord | undefined {
  const resolved = parseResolved(raw.resolved);
  if (resolved === undefined) return undefined;

  const sealed: DecisionSealedRecord = {
    resolved,
    resolvedAt: asIsoString(raw.resolvedAt) ?? "",
    resolvedBy: asString(raw.resolvedBy) ?? "",
    votes: parseSealedVotes(raw.votes),
  };

  const resolvedFrom = asString(raw.resolvedFrom);
  if (resolvedFrom !== undefined) sealed.resolvedFrom = resolvedFrom;

  if (Array.isArray(raw.removed)) {
    sealed.removed = raw.removed.map((entry) => String(entry));
  }

  const score = asNumber(raw.score);
  if (score !== undefined) sealed.score = score;

  const distribution = asRecord(raw.distribution);
  if (distribution) {
    const parsed: Record<string, number> = {};
    for (const [key, value] of Object.entries(distribution)) {
      const count = asNumber(value);
      if (count !== undefined) parsed[key] = count;
    }
    sealed.distribution = parsed;
  }

  return sealed;
}

/** Generates a short, stable-looking block id, e.g. `dcn-7f3a2c`. */
export function createDecisionId(): string {
  const bytes = new Uint8Array(3);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const suffix = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${DECISION_ID_PREFIX}-${suffix}`;
}

/**
 * Parses a fence body.
 *
 * Returns `null` only when the body is not a YAML mapping at all -- a fence
 * with a missing `ask` or an unrecognized `type` still parses, because a block
 * that renders as a broken decision is recoverable and one that silently
 * becomes a code block is not. Callers decide how to present an incomplete one.
 */
export function parseDecisionFence(body: string): DecisionBlockSource | null {
  let loaded: unknown;
  try {
    loaded = yaml.load(body);
  } catch {
    return null;
  }

  const raw = asRecord(loaded);
  if (!raw) return null;

  const rawType = raw.type;
  const type = isDecisionAskType(rawType) ? rawType : "singleSelect";

  const source: DecisionBlockSource = {
    id: asString(raw.id) ?? createDecisionId(),
    ask: asString(raw.ask) ?? "",
    type,
    entries: parseEntries(raw),
    asked: asStringList(raw.asked),
    visibility:
      raw.visibility === "hiddenUntilAnswered" || raw.visibility === "open"
        ? raw.visibility
        : decisionDefaultVisibility(type),
    raw,
  };
  if (typeof rawType === "string" && !isDecisionAskType(rawType)) {
    source.unrecognizedType = rawType;
  }

  const description = asString(raw.description);
  if (description !== undefined) source.description = description;

  const allowOther = asBoolean(raw.allowOther);
  if (allowOther !== undefined) source.allowOther = allowOther;

  const numericKeys = [
    "minSelected",
    "maxSelected",
    "minItems",
    "minLength",
    "maxLength",
    "min",
    "max",
    "step",
  ] as const;
  for (const key of numericKeys) {
    const value = asNumber(raw[key]);
    if (value !== undefined) source[key] = value;
  }

  const seed = asString(raw.seed);
  if (seed !== undefined) source.seed = seed;
  if (raw.format === "markdown" || raw.format === "plain")
    source.format = raw.format;
  const placeholder = asString(raw.placeholder);
  if (placeholder !== undefined) source.placeholder = placeholder;
  const minLabel = asString(raw.minLabel);
  if (minLabel !== undefined) source.minLabel = minLabel;
  const maxLabel = asString(raw.maxLabel);
  if (maxLabel !== undefined) source.maxLabel = maxLabel;

  const sealed = parseSealed(raw);
  if (sealed) source.sealed = sealed;

  return source;
}

export interface SealDecisionInput {
  outcome: DecisionResolvedValue;
  resolvedBy: string;
  resolvedAt: Date;
  votes: readonly DecisionVote[];
  /** `editText` only: the voter whose proposal was accepted. */
  resolvedFrom?: string;
}

export type SealDecisionResult =
  | { ok: true; content: string; source: DecisionBlockSource }
  | { ok: false; reason: DecisionSealBlockedReason | "unparseable" };

/**
 * Seals a fence, given the fence's *current* text.
 *
 * Takes the live content rather than a parsed source on purpose. Sealing is the
 * one operation here that overwrites a durable record, and the thing that must
 * not happen is two clients each appending a `resolved:` line because both were
 * looking at a stale copy. Passing the text forces the caller to re-read the
 * node inside its write transaction, so the guard sees whatever a peer just
 * committed rather than whatever this client rendered a minute ago.
 *
 * Pure, so the guard can be tested without an editor, a Y.Doc, or two clients.
 */
export function sealDecisionFence(
  currentContent: string,
  input: SealDecisionInput
): SealDecisionResult {
  const live = parseDecisionFence(currentContent);
  if (!live) return { ok: false, reason: "unparseable" };

  const check = checkDecisionSeal(live, input.outcome);
  if (!check.ok) return { ok: false, reason: check.reason ?? "noOutcome" };

  const sealed = buildDecisionSealedRecord({
    source: live,
    outcome: input.outcome,
    resolvedBy: input.resolvedBy,
    resolvedAt: input.resolvedAt,
    votes: input.votes,
    ...(input.resolvedFrom !== undefined
      ? { resolvedFrom: input.resolvedFrom }
      : {}),
  });

  const next: DecisionBlockSource = { ...live, sealed };
  return { ok: true, content: serializeDecisionFence(next), source: next };
}

/**
 * Rewrites a seal from an authoritative CRDT claim. Unlike `sealDecisionFence`,
 * this may replace an already-rendered seal after two offline claimants merge;
 * both peers then write the same winning claim and the same converged vote set.
 */
export function reconcileDecisionFence(
  currentContent: string,
  input: SealDecisionInput
): SealDecisionResult {
  const live = parseDecisionFence(currentContent);
  if (!live) return { ok: false, reason: "unparseable" };
  const unsealed: DecisionBlockSource = { ...live };
  delete unsealed.sealed;
  const check = checkDecisionSeal(unsealed, input.outcome);
  if (!check.ok) return { ok: false, reason: check.reason ?? "noOutcome" };
  const sealed = buildDecisionSealedRecord({
    source: unsealed,
    outcome: input.outcome,
    resolvedBy: input.resolvedBy,
    resolvedAt: input.resolvedAt,
    votes: input.votes,
    ...(input.resolvedFrom !== undefined
      ? { resolvedFrom: input.resolvedFrom }
      : {}),
  });
  const next: DecisionBlockSource = { ...live, sealed };
  return { ok: true, content: serializeDecisionFence(next), source: next };
}

function entryToRaw(entry: DecisionEntrySource): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry.raw, id: entry.id };
  if (entry.label !== undefined) out.label = entry.label;
  if (entry.title !== undefined) out.title = entry.title;
  if (entry.description !== undefined) out.description = entry.description;
  if (entry.subtitle !== undefined) out.subtitle = entry.subtitle;
  if (entry.badge !== undefined) out.badge = entry.badge;
  if (entry.removable !== undefined) out.removable = entry.removable;
  if (entry.defaultChecked !== undefined)
    out.defaultChecked = entry.defaultChecked;
  // Last, because it is the longest value and pushes the readable fields down.
  if (entry.artifact !== undefined) out.artifact = entry.artifact;
  return out;
}

/**
 * Rebuilds the fence body.
 *
 * Starts from `raw` so unrecognized keys survive, overwrites the modeled ones,
 * and emits in `KNOWN_KEY_ORDER` with anything unknown appended in its original
 * relative order. Emitting in a fixed order is what makes the round trip
 * idempotent: without it, a parse/serialize cycle would reshuffle keys and
 * every save would produce a spurious diff.
 */
export function serializeDecisionFence(source: DecisionBlockSource): string {
  const out: Record<string, unknown> = { ...source.raw };

  out.id = source.id;
  out.ask = source.ask;
  out.type = source.unrecognizedType ?? source.type;

  if (source.description !== undefined) out.description = source.description;
  else delete out.description;

  // The entry list is written under whichever key the author used, so a fence
  // hand-written with `items:` does not silently become `options:` on first save.
  const entryKey = Array.isArray(source.raw.items) ? "items" : "options";
  const otherEntryKey = entryKey === "items" ? "options" : "items";
  delete out[otherEntryKey];
  if (source.entries.length > 0) out[entryKey] = source.entries.map(entryToRaw);
  else delete out[entryKey];

  const optionalScalars = [
    "allowOther",
    "minSelected",
    "maxSelected",
    "minItems",
    "seed",
    "format",
    "placeholder",
    "minLength",
    "maxLength",
    "min",
    "max",
    "step",
    "minLabel",
    "maxLabel",
  ] as const;
  for (const key of optionalScalars) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
    else delete out[key];
  }

  if (source.asked.length > 0) out.asked = source.asked;
  else delete out.asked;

  // Only written when it differs from the type's default, so the common fence
  // stays short and the key means "the author overrode this".
  if (source.visibility !== decisionDefaultVisibility(source.type)) {
    out.visibility = source.visibility;
  } else {
    delete out.visibility;
  }

  const sealedKeys = [
    "resolved",
    "resolvedAt",
    "resolvedBy",
    "resolvedFrom",
    "removed",
    "score",
    "distribution",
    "votes",
  ] as const;
  for (const key of sealedKeys) delete out[key];

  if (source.sealed) {
    const sealed = source.sealed;
    out.resolved = sealed.resolved;
    out.resolvedAt = sealed.resolvedAt;
    out.resolvedBy = sealed.resolvedBy;
    if (sealed.resolvedFrom !== undefined)
      out.resolvedFrom = sealed.resolvedFrom;
    if (sealed.removed && sealed.removed.length > 0)
      out.removed = sealed.removed;
    if (sealed.score !== undefined) out.score = sealed.score;
    if (sealed.distribution && Object.keys(sealed.distribution).length > 0) {
      out.distribution = sealed.distribution;
    }
    if (sealed.votes.length > 0) {
      out.votes = sealed.votes.map((vote) => ({ [vote.voter]: vote.value }));
    }
  }

  const ordered: Record<string, unknown> = {};
  for (const key of KNOWN_KEY_ORDER) {
    if (key in out) ordered[key] = out[key];
  }
  for (const key of Object.keys(out)) {
    if (!KNOWN_KEYS.has(key)) ordered[key] = out[key];
  }

  return yaml
    .dump(ordered, {
      // Long asks and seeded prose must not be hard-wrapped: a fold would
      // change the text on every round trip through the parser.
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
    })
    .trimEnd();
}
