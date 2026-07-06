/**
 * PR reference resolution — which tracker items are "about" a pull request.
 *
 * The PR view integration is reference-based, never type-based: no tracker
 * type name (like "github-pr") is privileged. An item of ANY type references
 * PR (remote, number) when either:
 *
 *   1. Zero-config URL match — any url-type field value (a string, or a
 *      { url, label } object) matches the PR's canonical GitHub URL.
 *   2. Explicit link — a system.linkedPullRequests[] entry, written by the
 *      PR view's "Link tracker item" action or agent tooling.
 *
 * Pure functions + derived atoms; no IPC. The atoms derive from the already
 * loaded trackerItemsMapAtom, so resolution is reactive and free of extra
 * round-trips.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TrackerRecord } from '../../core/TrackerRecord';
import { trackerItemsMapAtom } from './trackerDataAtoms';

export interface PrReference {
  /** GitHub remote as "owner/repo" (lowercase). */
  remote: string;
  number: number;
}

/**
 * Matches GitHub PR URLs, tolerating http(s), www., trailing slashes, and
 * sub-pages like /files or /commits: github.com/<owner>/<repo>/pull/<n>[...]
 */
const PR_URL_RE = /(?:^|\/\/)(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/i;

/** Parse a GitHub PR URL into a reference, or null when it isn't one. */
export function parsePrUrl(url: string): PrReference | null {
  if (typeof url !== 'string' || !url) return null;
  const m = PR_URL_RE.exec(url);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { remote: `${m[1]}/${m[2]}`.toLowerCase(), number };
}

/** Build the canonical GitHub URL for a PR reference. */
export function buildPrUrl(remote: string, number: number): string {
  return `https://github.com/${remote}/pull/${number}`;
}

function pushUnique(refs: PrReference[], ref: PrReference): void {
  if (!refs.some((r) => r.remote === ref.remote && r.number === ref.number)) {
    refs.push(ref);
  }
}

/**
 * All PR references carried by a tracker record, from both the explicit
 * linkedPullRequests entries and any field value that looks like a PR URL.
 * Field values may arrive as JSON strings on SQLite — parse defensively.
 */
export function getRecordPrReferences(record: TrackerRecord): PrReference[] {
  const refs: PrReference[] = [];

  const linked = record.system?.linkedPullRequests;
  if (Array.isArray(linked)) {
    for (const entry of linked) {
      if (entry && typeof entry.remote === 'string' && Number.isSafeInteger(entry.number) && entry.number > 0) {
        pushUnique(refs, { remote: entry.remote.toLowerCase(), number: entry.number });
      }
    }
  }

  for (let value of Object.values(record.fields)) {
    if (typeof value === 'string' && value.startsWith('{')) {
      try { value = JSON.parse(value); } catch { /* plain string, fall through */ }
    }
    if (typeof value === 'string') {
      const ref = parsePrUrl(value);
      if (ref) pushUnique(refs, ref);
    } else if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') {
      const ref = parsePrUrl((value as { url: string }).url);
      if (ref) pushUnique(refs, ref);
    }
  }

  return refs;
}

/**
 * Non-archived tracker records referencing each PR number of a remote.
 * Keyed by lowercase "owner/repo". Items in each bucket are sorted most
 * recently updated first, so `[0]` is the primary item for badges.
 */
export const prTrackerReferencesAtom = atomFamily((remote: string) =>
  atom((get) => {
    const wanted = remote.toLowerCase();
    const byNumber = new Map<number, TrackerRecord[]>();
    for (const record of get(trackerItemsMapAtom).values()) {
      if (record.archived) continue;
      for (const ref of getRecordPrReferences(record)) {
        if (ref.remote !== wanted) continue;
        const bucket = byNumber.get(ref.number);
        if (bucket) bucket.push(record);
        else byNumber.set(ref.number, [record]);
      }
    }
    for (const bucket of byNumber.values()) {
      bucket.sort((a, b) => (b.system.updatedAt || '').localeCompare(a.system.updatedAt || ''));
    }
    return byNumber;
  })
);
