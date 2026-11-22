// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { GithubIssueRow } from '../../../services/RendererGithubIssueService';
import {
  collectImportedIssueCopies,
  collectIssueAttention,
  findIssueDivergentCopies,
  collectPrsByIssueNumber,
  isSameIssue,
  issueStateParam,
  selectVisibleIssues,
  toggleIssueFilter,
  STALE_UNTRIAGED_DAYS,
  type IssueFilterChip,
} from '../issues/issueFilters';

function issue(overrides: Partial<GithubIssueRow> & { number: number }): GithubIssueRow {
  return {
    id: `issue-${overrides.number}`,
    workspacePath: '/workspace',
    remote: 'nimbalyst/nimbalyst',
    title: `Issue ${overrides.number}`,
    body: null,
    state: 'open',
    stateReason: null,
    authorLogin: 'someone',
    authorAvatarUrl: null,
    assignees: [],
    labels: [],
    commentsCount: 0,
    locked: false,
    htmlUrl: `https://github.com/nimbalyst/nimbalyst/issues/${overrides.number}`,
    milestone: null,
    raw: null,
    createdAt: overrides.number,
    updatedAt: overrides.number,
    closedAt: null,
    fetchedAt: 0,
    ...overrides,
  };
}

const NO_LINKS = new Map<number, number[]>();

function visible(
  issues: GithubIssueRow[],
  activeFilters: IssueFilterChip[],
  extra: Partial<Parameters<typeof selectVisibleIssues>[0]> = {},
): number[] {
  return selectVisibleIssues({
    issues,
    activeFilters,
    search: '',
    sortKey: 'updated',
    viewerLogin: 'octocat',
    linkedPrsByIssue: NO_LINKS,
    ...extra,
  }).map((row) => row.number);
}

describe('issue filter state', () => {
  it('keeps open and closed mutually exclusive while other chips toggle freely', () => {
    expect(toggleIssueFilter(['open'], 'closed')).toEqual(['closed']);
    expect(toggleIssueFilter(['closed'], 'open')).toEqual(['open']);
    expect(toggleIssueFilter(['open', 'unlabeled'], 'authored-by-me')).toEqual([
      'open',
      'unlabeled',
      'authored-by-me',
    ]);
    expect(toggleIssueFilter(['open', 'unlabeled'], 'unlabeled')).toEqual(['open']);
    // Only the state chip reaches the cache query; everything else is local.
    expect(issueStateParam(['closed', 'unlabeled'])).toBe('closed');
    expect(issueStateParam(['unlabeled'])).toBe('open');
  });
});

describe('detail-pane identity', () => {
  it('accepts only the row the pane is showing, not another repository with that number', () => {
    // The detail atoms are global, so the previous selection's row is still in
    // them while the new one loads — and stays for good if that load fails.
    // Matching on number alone rendered repo A's body under repo B's #42.
    const identity = { workspacePath: '/workspace', remote: 'nimbalyst/nimbalyst', number: 42 };
    const row = issue({ number: 42 });

    expect(isSameIssue(row, identity)).toBe(true);
    expect(isSameIssue({ ...row, remote: 'someone/private-repo' }, identity)).toBe(false);
    expect(isSameIssue({ ...row, workspacePath: '/other-workspace' }, identity)).toBe(false);
    expect(isSameIssue(issue({ number: 43 }), identity)).toBe(false);
    expect(isSameIssue(null, identity)).toBe(false);
    // GitHub treats owner/repo case-insensitively; a re-cased remote is the
    // same repository, not a different one.
    expect(isSameIssue({ ...row, remote: 'Nimbalyst/Nimbalyst' }, identity)).toBe(true);
  });
});

describe('issue narrowing', () => {
  const issues = [
    issue({ number: 10, authorLogin: 'octocat', updatedAt: 300 }),
    issue({
      number: 11,
      assignees: [{ login: 'octocat', avatarUrl: null }],
      labels: [{ name: 'bug', color: null, description: null }],
      updatedAt: 200,
    }),
    issue({ number: 12, title: 'Windows ARM64 terminal', updatedAt: 100 }),
  ];

  it('narrows by author, assignee, and labels, and sorts by the chosen key', () => {
    expect(visible(issues, ['open'])).toEqual([10, 11, 12]);
    expect(visible(issues, ['authored-by-me'])).toEqual([10]);
    expect(visible(issues, ['assigned-to-me'])).toEqual([11]);
    expect(visible(issues, ['unlabeled'])).toEqual([10, 12]);
    expect(visible(issues, ['authored-by-me', 'unlabeled'])).toEqual([10]);
    expect(visible(issues, [], { sortKey: 'number' })).toEqual([12, 11, 10]);
  });

  it('drops every row for the "me" filters when the gh user is unknown', () => {
    // A signed-out gh would otherwise silently show every issue as mine.
    expect(visible(issues, ['assigned-to-me'], { viewerLogin: null })).toEqual([]);
    expect(visible(issues, ['authored-by-me'], { viewerLogin: null })).toEqual([]);
  });

  it('unions the local status filters and drops issues with no local state', () => {
    const localStatusesByIssue = new Map([
      [10, ['ready']],
      [11, ['needs-design', 'in-progress']],
    ]);
    // Upstream chips narrow cumulatively; local statuses are a union, so
    // asking for two queues shows both. #12 has no overlay at all, so no
    // local filter can ever match it.
    expect(visible(issues, [], { localStatusFilters: ['ready'], localStatusesByIssue })).toEqual([10]);
    expect(
      visible(issues, [], { localStatusFilters: ['ready', 'needs-design'], localStatusesByIssue }),
    ).toEqual([10, 11]);
  });

  it('searches title, number, and label text', () => {
    expect(visible(issues, [], { search: 'arm64' })).toEqual([12]);
    expect(visible(issues, [], { search: '11' })).toEqual([11]);
    expect(visible(issues, [], { search: 'bug' })).toEqual([11]);
  });

  it('searches by author with free text or author: tokens', () => {
    const byAuthor = [
      issue({ number: 20, authorLogin: 'Alice-Dev', updatedAt: 3 }),
      issue({ number: 21, authorLogin: 'bob', title: 'alice asked for this', updatedAt: 2 }),
      issue({ number: 22, authorLogin: null, updatedAt: 1 }),
    ];
    // Free text matches the login as well as the title.
    expect(visible(byAuthor, [], { search: 'alice' })).toEqual([20, 21]);
    expect(visible(byAuthor, [], { search: '@bob' })).toEqual([21]);
    // author: matches only the login, case-insensitively, with or without @.
    expect(visible(byAuthor, [], { search: 'author:alice' })).toEqual([20]);
    expect(visible(byAuthor, [], { search: 'Author:@ALICE' })).toEqual([20]);
    // Several author tokens are a union; remaining text still narrows.
    expect(visible(byAuthor, [], { search: 'author:alice author:bob' })).toEqual([20, 21]);
    expect(visible(byAuthor, [], { search: 'author:bob asked' })).toEqual([21]);
    expect(visible(byAuthor, [], { search: 'author:alice asked' })).toEqual([]);
    // A half-typed qualifier narrows nothing.
    expect(visible(byAuthor, [], { search: 'author:' })).toEqual([20, 21, 22]);
  });

  it('unions the needs-attention queues', () => {
    const attentionByIssue = new Map([
      [10, ['diverged' as const]],
      [12, ['stale' as const]],
    ]);
    expect(visible(issues, [], { attentionFilters: ['diverged'], attentionByIssue })).toEqual([10]);
    expect(
      visible(issues, [], { attentionFilters: ['diverged', 'stale'], attentionByIssue }),
    ).toEqual([10, 12]);
  });

  it('filters to issues a cached pull request references', () => {
    const prs = [
      { number: 500, title: 'fix: crash on launch', body: 'Fixes #10 and refs #11' },
      { number: 501, title: 'chore: bump deps #501', body: null },
      {
        number: 502,
        title: 'docs',
        body: 'see https://github.com/nimbalyst/nimbalyst/issues/12',
      },
    ];
    const linkedPrsByIssue = collectPrsByIssueNumber(prs);

    // A PR's own number is not a reference to an issue with that number.
    expect(linkedPrsByIssue.has(501)).toBe(false);
    expect(linkedPrsByIssue.get(10)).toEqual([500]);
    expect(linkedPrsByIssue.get(12)).toEqual([502]);
    expect(visible(issues, ['has-linked-pr'], { linkedPrsByIssue })).toEqual([10, 11, 12]);
  });
});

const REMOTE = 'nimbalyst/nimbalyst';
const NOW = 1_770_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function trackerRecord(
  id: string,
  overrides: Partial<TrackerRecord> & { fields?: Record<string, unknown> } = {},
): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: [],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/workspace', createdAt: '', updatedAt: '' },
    fields: {},
    ...overrides,
  };
}

/** An item the importer created for this issue, with its provenance snapshot. */
function importedCopy(
  id: string,
  snapshot: {
    title: string;
    status?: string;
    labels?: string[];
    upstreamBodyChanged?: boolean;
    urn?: string;
  },
): TrackerRecord {
  return trackerRecord(id, {
    source: 'import',
    fields: { status: snapshot.status ?? 'to-do', labels: snapshot.labels ?? [] },
    system: {
      workspace: '/workspace',
      createdAt: '',
      updatedAt: '',
      origin: {
        kind: 'external',
        external: {
          providerId: 'github-issues',
          externalId: `${REMOTE}#10`,
          urn: snapshot.urn ?? `github://${REMOTE}#10`,
          url: `https://github.com/${REMOTE}/issues/10`,
          titleSnapshot: snapshot.title,
          importedAt: '',
          lastSyncedAt: '',
          upstreamBodyChanged: snapshot.upstreamBodyChanged,
        },
      },
    },
  });
}

function attention(
  rows: GithubIssueRow[],
  referencesByIssue: Map<number, TrackerRecord[]>,
  items: TrackerRecord[] = [],
): Map<number, string[]> {
  return collectIssueAttention({
    issues: rows,
    remote: REMOTE,
    referencesByIssue,
    items,
    now: NOW,
  });
}

describe('needs attention', () => {
  const upstream = issue({
    number: 10,
    title: 'Crash on launch',
    labels: [{ name: 'bug', color: null, description: null }],
    updatedAt: NOW,
  });

  it('keeps records with nothing to diverge from out of the queue', () => {
    // A legacy native bug that merely links the issue holds no upstream
    // snapshot, so its "differences" are not drift and there is no re-snapshot
    // that could resolve them. Same for a copy imported from another provider,
    // or from a different issue in this repo.
    const legacy = trackerRecord('bug-legacy', {
      fields: { status: 'done', title: 'Something else entirely' },
    });
    const otherProvider = importedCopy('bug-linear', {
      title: 'Crash on launch',
      urn: 'linear://NIM-123',
    });
    const otherIssue = importedCopy('bug-11', {
      title: 'A different issue',
      urn: `github://${REMOTE}#11`,
    });

    for (const record of [legacy, otherProvider, otherIssue]) {
      expect(findIssueDivergentCopies(upstream, REMOTE, [record])).toEqual([]);
    }
    const records = [legacy, otherProvider, otherIssue];
    expect(attention([upstream], new Map([[10, records]]), records).get(10)).toBeUndefined();
  });

  it('reports each axis a copy drifted on, and stays quiet when it has not', () => {
    const clean = importedCopy('bug-clean', {
      title: 'Crash on launch',
      // Re-snapshot unions labels, so a local superset is not drift.
      labels: ['bug', 'triaged'],
    });
    expect(findIssueDivergentCopies(upstream, REMOTE, [clean])).toEqual([]);

    const drifted = importedCopy('bug-drifted', {
      title: 'Crash at startup',
      status: 'done',
      labels: [],
      upstreamBodyChanged: true,
    });
    const [copy] = findIssueDivergentCopies(upstream, REMOTE, [drifted]);
    expect(copy.itemId).toBe('bug-drifted');
    expect(copy.urn).toBe(`github://${REMOTE}#10`);
    // `done` is terminal, so the local copy reads as closed while upstream is open.
    expect(copy.divergence.axes).toEqual(['state', 'title', 'body', 'labels']);
    expect(copy.divergence.addedUpstreamLabels).toEqual(['bug']);
    expect(attention([upstream], new Map(), [drifted]).get(10)).toEqual(['diverged']);
  });

  it('finds the imported copy that reference resolution cannot see', () => {
    // An imported item points at the issue only through `origin`, so it never
    // appears in the reference map — the URN index is the only way to it, and
    // without it the diverged queue is empty for every adopted issue.
    const overlay = trackerRecord('gi-1', {
      primaryType: 'github-issue',
      fields: {
        status: 'adopted',
        issueUrl: `https://github.com/${REMOTE}/issues/10`,
        adoptedItemId: 'bug-adopted',
      },
    });
    const adopted = importedCopy('bug-adopted', { title: 'Crash at startup' });
    const archived = importedCopy('bug-archived', { title: 'Older copy' });
    archived.archived = true;

    const byIssue = attention([upstream], new Map([[10, [overlay]]]), [overlay, adopted, archived]);
    expect(byIssue.get(10)).toEqual(['diverged']);
    expect(collectImportedIssueCopies([overlay, adopted, archived], REMOTE).get(10)).toEqual([
      adopted,
    ]);
  });

  it('calls an untouched issue stale only when upstream has gone quiet', () => {
    const quiet = issue({ number: 20, updatedAt: NOW - (STALE_UNTRIAGED_DAYS + 1) * DAY_MS });
    const recent = issue({ number: 21, updatedAt: NOW - DAY_MS });
    const quietButClosed = issue({ ...quiet, number: 22, state: 'closed' });

    const byIssue = attention([quiet, recent, quietButClosed], new Map());
    expect(byIssue.get(20)).toEqual(['stale']);
    expect(byIssue.get(21)).toBeUndefined();
    expect(byIssue.get(22)).toBeUndefined();

    // An overlay means a human already formed an opinion; it is no longer untriaged.
    const overlay = trackerRecord('gi-20', { primaryType: 'github-issue' });
    expect(attention([quiet], new Map([[20, [overlay]]]), [overlay]).get(20)).toBeUndefined();
  });
});
