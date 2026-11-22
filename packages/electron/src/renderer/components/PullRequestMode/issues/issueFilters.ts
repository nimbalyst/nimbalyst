/**
 * Client-side narrowing and sorting for the issue list, plus the identity test
 * the detail pane renders through.
 *
 * Only `state` is a server-side (cache query) filter; everything else runs over
 * the cached rows, mirroring how the PR list splits the two. Kept as plain
 * functions so the rules are testable without rendering the list.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { isTerminalStatus } from '@nimbalyst/tracker-schema';
import type { GithubIssueRow } from '../../../services/RendererGithubIssueService';
import {
  detectGithubIssueDivergence,
  type GithubIssueDivergenceResult,
  type GithubIssueLocalSnapshot,
} from '../../../services/githubIssueDivergence';
import type { PrSortKey } from '../../../store/atoms/pullRequests';
import { matchesGithubListSearch } from '../githubListSearch';

export type IssueFilterChip =
  | 'open'
  | 'closed'
  | 'assigned-to-me'
  | 'authored-by-me'
  | 'unlabeled'
  | 'has-linked-pr';

/** Which issue the detail pane is showing, in full. */
export interface IssueIdentity {
  workspacePath: string;
  remote: string;
  number: number;
}

/**
 * Whether a cached row is the issue the pane is showing.
 *
 * An issue number is not an identity — every repository has a #42. The detail
 * atoms are global (as `prListAtom` is), so the row fetched for the previous
 * selection sits in them while the new one loads, and stays there for good if
 * the new fetch fails. Rendering is gated on the whole identity so another
 * repository's body can never appear under this issue's header.
 *
 * Remote is compared case-insensitively because GitHub treats owner and repo
 * that way; workspace path and number are exact.
 */
export function isSameIssue<T extends { workspacePath: string; remote: string; number: number }>(
  row: T | null | undefined,
  identity: IssueIdentity,
): row is T {
  if (!row) return false;
  return (
    row.workspacePath === identity.workspacePath &&
    row.remote.toLowerCase() === identity.remote.toLowerCase() &&
    row.number === identity.number
  );
}

/** `open` / `closed` are mutually exclusive; the rest toggle independently. */
export function toggleIssueFilter(
  active: ReadonlyArray<IssueFilterChip>,
  filter: IssueFilterChip,
): IssueFilterChip[] {
  let current = [...active];
  if (filter === 'open') current = current.filter((f) => f !== 'closed');
  if (filter === 'closed') current = current.filter((f) => f !== 'open');
  return current.includes(filter)
    ? current.filter((f) => f !== filter)
    : [...current, filter];
}

/** Which upstream state the cache query asks for. */
export function issueStateParam(
  active: ReadonlyArray<IssueFilterChip>,
): 'open' | 'closed' {
  return active.includes('closed') ? 'closed' : 'open';
}

/**
 * PR numbers keyed by the issue number they reference, from `#123` mentions
 * and full issue URLs in each PR's title and body.
 *
 * This is a heuristic over what the PR cache already holds — GitHub's issue
 * list payload carries no linked-PR field, and the authoritative
 * cross-reference lives in the per-issue timeline, which the list cannot
 * fetch per row. It therefore only sees issues referenced by PRs already
 * cached, and a `#123` that meant something else counts as a reference.
 */
export function collectPrsByIssueNumber(
  prs: ReadonlyArray<{ number: number; title: string; body?: string | null }>,
): Map<number, number[]> {
  const byIssue = new Map<number, number[]>();
  for (const pr of prs) {
    const text = `${pr.title}\n${pr.body ?? ''}`;
    const seen = new Set<number>();
    for (const match of text.matchAll(/(?:#|\/issues\/)(\d+)\b/g)) {
      const issueNumber = Number(match[1]);
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) continue;
      if (issueNumber === pr.number || seen.has(issueNumber)) continue;
      seen.add(issueNumber);
      const bucket = byIssue.get(issueNumber);
      if (bucket) bucket.push(pr.number);
      else byIssue.set(issueNumber, [pr.number]);
    }
  }
  return byIssue;
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

/**
 * Days without upstream activity after which an issue nobody has touched
 * locally counts as neglected. Invented here — the plan says "older than N
 * days" without fixing N. Measured against last activity rather than creation
 * date, so an old issue with a live discussion is not called neglected.
 */
export const STALE_UNTRIAGED_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The two Needs-attention queues. `diverged` is the reconciliation instrument
 * — it counts only issues we hold a *copy* of — while `stale` is the untouched
 * backlog. They are deliberately separate chips: folding hundreds of stale
 * rows into the same count would bury the handful of diverged ones, and the
 * diverged count is the number that says when real sync machinery is due.
 */
export type IssueAttentionChip = 'diverged' | 'stale';

/** One imported copy of an issue that has drifted from upstream. */
export interface IssueDivergentCopy {
  itemId: string;
  /** The importer URN, for re-snapshot and the apply/dismiss body actions. */
  urn: string;
  divergence: GithubIssueDivergenceResult;
}

/** The upstream facts divergence is measured against. */
export type UpstreamIssueFacts = Pick<GithubIssueRow, 'number' | 'state' | 'title' | 'labels'>;

function importerUrn(remote: string, number: number): string {
  return `github://${remote.toLowerCase()}#${number}`;
}

/** `labels` may arrive as a JSON string on SQLite (see DATABASE.md). */
function readImportedLabels(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Normalize a tracker record into the divergence reducer's `local` shape, or
 * null when the record is not a copy of this issue.
 *
 * Only a record carrying importer provenance for *this* issue is a copy.
 * Everything else — the overlay (which holds no GitHub content), the ~12
 * legacy native bugs that merely link an issue, an item imported from another
 * provider — has no snapshot to diverge from, and treating a missing snapshot
 * as "everything changed" would fill the queue with items nothing can be done
 * about. So they are skipped rather than compared against defaults.
 */
export function issueLocalSnapshot(
  record: TrackerRecord,
  remote: string,
  number: number,
): GithubIssueLocalSnapshot | null {
  const origin = record.system.origin;
  const external = origin?.kind === 'external' ? origin.external : null;
  if (!external?.urn || external.urn.toLowerCase() !== importerUrn(remote, number)) return null;

  return {
    state: isTerminalStatus(record.primaryType, getRecordStatus(record)) ? 'closed' : 'open',
    titleSnapshot: external.titleSnapshot || null,
    labels: readImportedLabels(record.fields.labels),
    upstreamBodyChanged: external.upstreamBodyChanged === true,
  };
}

/**
 * Every local copy of `issue` among `records` that has drifted from upstream.
 * Records that are not copies contribute nothing (see issueLocalSnapshot).
 */
export function findIssueDivergentCopies(
  issue: UpstreamIssueFacts,
  remote: string,
  records: ReadonlyArray<TrackerRecord>,
): IssueDivergentCopy[] {
  const upstream = {
    state: issue.state === 'closed' ? ('closed' as const) : ('open' as const),
    title: issue.title,
    labels: issue.labels,
  };
  const copies: IssueDivergentCopy[] = [];
  for (const record of records) {
    const local = issueLocalSnapshot(record, remote, issue.number);
    if (!local) continue;
    const divergence = detectGithubIssueDivergence(upstream, local);
    if (!divergence.needsAttention) continue;
    const origin = record.system.origin;
    const urn = origin?.kind === 'external' ? origin.external.urn : '';
    copies.push({ itemId: record.id, urn, divergence });
  }
  return copies;
}

const IMPORTER_URN_RE = /^github:\/\/([^/\s]+\/[^/\s#]+)#(\d+)$/i;

/**
 * Imported copies of this remote's issues, keyed by issue number.
 *
 * This index exists because an imported item's only pointer at the issue is
 * `system.origin.external`, which reference resolution deliberately does not
 * scan (it matches url-type *fields* and explicit links). So the 24 items
 * already imported — and every item adopted from this panel — are invisible to
 * `issueTrackerReferencesAtom`, and a reconciliation view built on references
 * alone would find nothing to reconcile.
 */
export function collectImportedIssueCopies(
  records: Iterable<TrackerRecord>,
  remote: string,
): Map<number, TrackerRecord[]> {
  const wanted = remote.toLowerCase();
  const byIssue = new Map<number, TrackerRecord[]>();
  for (const record of records) {
    if (record.archived) continue;
    const origin = record.system.origin;
    const urn = origin?.kind === 'external' ? origin.external.urn : null;
    const match = urn ? IMPORTER_URN_RE.exec(urn) : null;
    if (!match || match[1].toLowerCase() !== wanted) continue;
    const number = Number(match[2]);
    const bucket = byIssue.get(number);
    if (bucket) bucket.push(record);
    else byIssue.set(number, [record]);
  }
  return byIssue;
}

export interface IssueAttentionInput {
  issues: ReadonlyArray<GithubIssueRow>;
  remote: string | null;
  /** Tracker items referencing each issue number (see issueReferences.ts). */
  referencesByIssue: ReadonlyMap<number, ReadonlyArray<TrackerRecord>>;
  /** Every tracker item, for indexing imported copies by URN. */
  items: Iterable<TrackerRecord>;
  now: number;
}

/** Which Needs-attention queues each issue belongs to; absent means neither. */
export function collectIssueAttention({
  issues,
  remote,
  referencesByIssue,
  items,
  now,
}: IssueAttentionInput): Map<number, IssueAttentionChip[]> {
  const byIssue = new Map<number, IssueAttentionChip[]>();
  if (!remote) return byIssue;
  const importedByIssue = collectImportedIssueCopies(items, remote);
  const staleBefore = now - STALE_UNTRIAGED_DAYS * DAY_MS;

  for (const issue of issues) {
    const copies = importedByIssue.get(issue.number) ?? [];
    const references = referencesByIssue.get(issue.number) ?? [];
    const chips: IssueAttentionChip[] = [];

    if (findIssueDivergentCopies(issue, remote, copies).length > 0) {
      chips.push('diverged');
    } else if (
      references.length === 0 &&
      copies.length === 0 &&
      issue.state !== 'closed' &&
      issue.updatedAt < staleBefore
    ) {
      // Nobody has formed an opinion about this one and upstream went quiet.
      chips.push('stale');
    }

    if (chips.length > 0) byIssue.set(issue.number, chips);
  }
  return byIssue;
}

export interface IssueNarrowing {
  issues: ReadonlyArray<GithubIssueRow>;
  activeFilters: ReadonlyArray<IssueFilterChip>;
  search: string;
  sortKey: PrSortKey;
  /** `gh` login of the signed-in user; null disables the "me" filters. */
  viewerLogin: string | null;
  /** PR numbers per issue number (see collectPrsByIssueNumber). */
  linkedPrsByIssue: ReadonlyMap<number, ReadonlyArray<number>>;
  /** Local workflow statuses to keep; empty (the default) keeps everything. */
  localStatusFilters?: ReadonlyArray<string>;
  /** Workflow statuses of the tracker items about each issue number. */
  localStatusesByIssue?: ReadonlyMap<number, ReadonlyArray<string>>;
  /** Needs-attention queues to keep; empty (the default) keeps everything. */
  attentionFilters?: ReadonlyArray<IssueAttentionChip>;
  /** Needs-attention queues per issue number (see collectIssueAttention). */
  attentionByIssue?: ReadonlyMap<number, ReadonlyArray<IssueAttentionChip>>;
}

export function selectVisibleIssues({
  issues,
  activeFilters,
  search,
  sortKey,
  viewerLogin,
  linkedPrsByIssue,
  localStatusFilters = [],
  localStatusesByIssue,
  attentionFilters = [],
  attentionByIssue,
}: IssueNarrowing): GithubIssueRow[] {
  let rows = [...issues];

  // Like the local statuses below, a union: picking both attention chips asks
  // for both queues rather than their intersection (which is always empty —
  // an issue with a diverged copy is by definition not untouched).
  if (attentionFilters.length > 0) {
    rows = rows.filter((r) =>
      (attentionByIssue?.get(r.number) ?? []).some((chip) => attentionFilters.includes(chip)),
    );
  }

  // Local statuses are a union — picking Ready and Needs design asks for both
  // queues at once — while the upstream chips above narrow cumulatively. An
  // issue with no local state matches no local status, so any local filter
  // hides the untouched long tail.
  if (localStatusFilters.length > 0) {
    rows = rows.filter((r) =>
      (localStatusesByIssue?.get(r.number) ?? []).some((status) =>
        localStatusFilters.includes(status),
      ),
    );
  }

  if (activeFilters.includes('assigned-to-me')) {
    rows = viewerLogin
      ? rows.filter((r) => r.assignees.some((a) => a.login === viewerLogin))
      : [];
  }
  if (activeFilters.includes('authored-by-me')) {
    rows = viewerLogin ? rows.filter((r) => r.authorLogin === viewerLogin) : [];
  }
  if (activeFilters.includes('unlabeled')) {
    rows = rows.filter((r) => r.labels.length === 0);
  }
  if (activeFilters.includes('has-linked-pr')) {
    rows = rows.filter((r) => linkedPrsByIssue.has(r.number));
  }

  if (search.trim()) {
    rows = rows.filter((r) => matchesGithubListSearch(r, search));
  }

  rows.sort((a, b) => {
    if (sortKey === 'number') return b.number - a.number;
    if (sortKey === 'created') return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });
  return rows;
}
