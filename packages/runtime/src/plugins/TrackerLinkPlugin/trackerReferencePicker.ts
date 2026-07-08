/**
 * Picker helpers for the `#` tracker-reference typeahead (V2).
 *
 * The `#` typeahead in the document editor picks an EXISTING tracker item to
 * *reference* (insert a {@link TrackerReferenceNode} pointer), rather than
 * creating a frozen inline `TrackerItemNode` snapshot. These helpers are pure
 * (search/build the option list) plus a single Lexical insertion command, kept
 * separate from the React plugin so they can be unit-tested directly.
 */

import { $createTextNode, $getSelection, $isRangeSelection } from 'lexical';
import type { TrackerRecord } from '../../core/TrackerRecord';
import { $createTrackerReferenceNode } from './TrackerReferenceNode';

/** A single resolved candidate for the `#` reference menu. */
export interface TrackerReferenceOption {
  /** The reference key inserted into the document (issueKey, else record id). */
  referenceKey: string;
  /** Internal record id (stable React key / de-dup). */
  id: string;
  /** Human-readable issue key (NIM-123) when the item is synced. */
  issueKey?: string;
  title: string;
  /** Raw status string (e.g. 'in-progress'). */
  status?: string;
  /** Primary tracker type (bug/task/plan/...). */
  type: string;
}

/**
 * The reference key to embed for a record: prefer the human issue key (NIM-123),
 * else fall back to the raw record id. The raw id is used (not a `tk_…` short id)
 * because {@link trackerItemByReferenceKeyAtom} resolves a key by `map.get(id)`,
 * so the raw id is guaranteed to resolve while an arbitrary short id would not.
 */
export function referenceKeyForRecord(record: TrackerRecord): string {
  return record.issueKey ?? record.id;
}

function toOption(record: TrackerRecord): TrackerReferenceOption {
  const fields = (record.fields ?? {}) as Record<string, unknown>;
  return {
    referenceKey: referenceKeyForRecord(record),
    id: record.id,
    issueKey: record.issueKey,
    title: (fields.title as string) ?? '',
    status: fields.status as string | undefined,
    type: record.primaryType,
  };
}

/**
 * Match the `#…` reference trigger at the end of the given text (the block text
 * up to the caret). Allows word chars, `-` (issue keys like `NIM-13`) and `:`
 * (the `type:` scope prefix). The negative lookbehind rejects `##`/`###` so
 * markdown headings never trigger the picker.
 *
 * Returns the captured query and the full matched `#…` string (used to delete
 * the trigger text on selection), or null when there is no trigger.
 */
export function matchTrackerReferenceTrigger(
  textUpToCaret: string,
): { matchingString: string; replaceableString: string; index: number } | null {
  const m = textUpToCaret.match(/(?<!#)#([\w:-]*)$/);
  if (!m) return null;
  return { matchingString: m[1], replaceableString: m[0], index: m.index ?? 0 };
}

/** True if a record is of (or tagged with) the given type, case-insensitively. */
function recordMatchesType(record: TrackerRecord, type: string): boolean {
  const t = type.toLowerCase();
  if (record.primaryType?.toLowerCase() === t) return true;
  return (record.typeTags ?? []).some((tag) => tag.toLowerCase() === t);
}

/**
 * Split a typed query into an optional type scope and the residual search text.
 * A leading `type:` prefix scopes the picker to that type when `type` is a known
 * tracker type (e.g. `bug:login` → filter to bugs matching "login"). Anything
 * else is treated as a plain search (issue keys contain `-`, never `:`).
 */
export function parseTypeScopedQuery(
  query: string | null,
  knownTypes: Set<string>,
): { typeFilter: string | null; searchQuery: string } {
  const raw = query ?? '';
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const candidate = raw.slice(0, colon).toLowerCase();
    if (knownTypes.has(candidate)) {
      return { typeFilter: candidate, searchQuery: raw.slice(colon + 1) };
    }
  }
  return { typeFilter: null, searchQuery: raw };
}

/**
 * Build the ordered list of reference options for the current query.
 *
 * Searches issue key, title, and description; excludes archived items, and
 * (when `typeFilter` is set) restricts to that tracker type. With no query,
 * returns the most-recent items (highest issue number first). With a query,
 * key-prefix matches sort ahead of substring matches.
 */
export function buildTrackerReferenceOptions(
  records: TrackerRecord[],
  query: string | null,
  options: { typeFilter?: string | null; limit?: number } = {},
): TrackerReferenceOption[] {
  const { typeFilter = null, limit = 25 } = options;
  let active = records.filter((r) => !r.archived);
  if (typeFilter) {
    active = active.filter((r) => recordMatchesType(r, typeFilter));
  }
  const q = query?.trim().toLowerCase() ?? '';

  if (!q) {
    return active
      .slice()
      .sort((a, b) => (b.issueNumber ?? 0) - (a.issueNumber ?? 0))
      .slice(0, limit)
      .map(toOption);
  }

  const scored: Array<{ record: TrackerRecord; score: number }> = [];
  for (const record of active) {
    const key = referenceKeyForRecord(record).toLowerCase();
    const issueKey = record.issueKey?.toLowerCase() ?? '';
    const fields = (record.fields ?? {}) as Record<string, unknown>;
    const title = ((fields.title as string) ?? '').toLowerCase();
    const description = ((fields.description as string) ?? '').toLowerCase();

    let score = -1;
    if (key.startsWith(q) || issueKey.startsWith(q)) score = 0;
    else if (key.includes(q) || issueKey.includes(q)) score = 1;
    else if (title.startsWith(q)) score = 2;
    else if (title.includes(q)) score = 3;
    else if (description.includes(q)) score = 4;

    if (score >= 0) scored.push({ record, score });
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return (b.record.issueNumber ?? 0) - (a.record.issueNumber ?? 0);
    })
    .slice(0, limit)
    .map(({ record }) => toOption(record));
}

/**
 * Insert a tracker reference node at the current selection, followed by a
 * trailing space (so the caret has somewhere to land). Assumes the typeahead
 * has already removed the `#query` trigger text. Returns false if there is no
 * range selection.
 */
export function $insertTrackerReference(referenceKey: string): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;

  const node = $createTrackerReferenceNode(referenceKey);
  selection.insertNodes([node]);

  const space = $createTextNode(' ');
  node.insertAfter(space);
  space.select();
  return true;
}
