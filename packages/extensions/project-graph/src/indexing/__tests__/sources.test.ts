// @vitest-environment node

/**
 * Source-level behavior: the SQL each source issues, how it pages, and what it
 * refuses to claim when a backend or a service does not cooperate.
 *
 * The database cases run each assertion against BOTH backend encodings —
 * PGLite hands back parsed JSON and real booleans, better-sqlite3 hands back
 * JSON strings and 0/1 — because a mapping that reads correctly on one and
 * silently wrong on the other is this codebase's recurring database defect.
 */
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../adapters/__tests__/testHost';
import { createSessionsSource } from '../sources/sessionsSource';
import { createTrackersSource } from '../sources/trackersSource';
import { createGitSource, loadCommitFileEvidence } from '../sources/gitSource';
import { createGitHubSource } from '../sources/githubSource';
import { createDocsSource, createMemorySource, createPlansSource } from '../sources/fileSources';
import { resolveOptions, type CancelSignal, type IndexSourceContext } from '../types';
import { resolveEventWindows } from '../eventScope';
import type { PanelHost } from '@nimbalyst/extension-sdk';

const WS = '/ws';
const SIGNAL: CancelSignal = { cancelled: false, throwIfCancelled: () => {} };

function ctxFor(host: PanelHost, options = {}): IndexSourceContext {
  const resolved = resolveOptions(options);
  return {
    host,
    options: resolved,
    eventScope: resolveEventWindows(resolved, { nowMs: Date.now() }),
    signal: SIGNAL,
  };
}

describe('sessions source', () => {
  it('pages by key through sessions and then through their edited files', async () => {
    const sessions = [
      { id: 's1', title: 'One' },
      { id: 's2', title: 'Two' },
    ].map(s => ({
      ...s,
      provider: 'claude', model: 'opus', status: 'active', session_type: null, agent_role: null,
      worktree_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
      last_activity: '2026-01-02T00:00:00Z', metadata: {}, is_archived: false,
    }));
    const files = [
      { session_id: 's1', file_path: `${WS}/packages/electron/src/main/a.ts` },
      { session_id: 's1', file_path: `${WS}/packages/electron/src/main/b.ts` },
    ];
    const { host, queryCalls } = createTestHost({
      workspacePath: WS,
      queries: [
        { match: /COUNT\(\*\)/, handle: () => [{ n: 2 }] },
        {
          match: /FROM ai_sessions/,
          handle: ({ params }) => (params[1] === '' ? [sessions[0]!] : params[1] === 's1' ? [sessions[1]!] : []),
        },
        { match: /FROM session_files/, handle: ({ params }) => (params[1] === '' ? files : []) },
      ],
    });
    const source = createSessionsSource();
    const ctx = ctxFor(host);

    expect((await source.prepare(ctx)).total).toBe(2);

    const first = await source.page(ctx, undefined, 1);
    expect(first.records.map(r => r.id)).toEqual(['session:s1']);
    // A full page hands back a keyset cursor, not an offset: OFFSET re-walks
    // every skipped row and turns a full enumeration quadratic.
    expect(first.cursor).toBe('s:s1');

    const second = await source.page(ctx, first.cursor, 1);
    expect(second.records.map(r => r.id)).toEqual(['session:s2']);

    // A short session page hands off to the file phase rather than ending.
    const third = await source.page(ctx, second.cursor, 1);
    expect(third.cursor).toBe('f:');

    const fourth = await source.page(ctx, third.cursor, 100);
    const edge = fourth.edges.find(e => e.sourceId === 'session:s1');
    expect(edge?.type).toBe('edited_in');
    // Two files in one directory is ONE edge carrying the count, not two edges.
    expect(fourth.edges).toHaveLength(1);
    expect(edge?.strength).toBe(2);
    expect(edge?.provenance?.kind).toBe('derived');
    expect(fourth.records.find(r => r.id === 'dir:packages/electron/main')?.badges).toEqual([
      { key: 'edits', value: 2 },
    ]);

    expect(queryCalls.every(c => !/OFFSET/i.test(c.sql))).toBe(true);
  });

  it('carries an edit count across page boundaries without re-emitting settled pairs', async () => {
    // The rows are ordered by (session_id, file_path), so a session's files can
    // straddle a page boundary and its count must keep accumulating. Pairs that
    // a page did not touch must NOT be re-emitted: doing so is quadratic in the
    // page count against a ~74k-row table.
    const pages: Record<string, Array<{ session_id: string; file_path: string }>> = {
      '': [
        { session_id: 's1', file_path: `${WS}/packages/electron/src/main/a.ts` },
        { session_id: 's1', file_path: `${WS}/packages/electron/src/main/b.ts` },
      ],
      's1': [
        { session_id: 's1', file_path: `${WS}/packages/electron/src/main/c.ts` },
        { session_id: 's2', file_path: `${WS}/docs/x.md` },
      ],
    };
    const { host } = createTestHost({
      workspacePath: WS,
      queries: [
        { match: /FROM ai_sessions/, handle: () => [] },
        { match: /FROM session_files/, handle: ({ params }) => pages[String(params[1])] ?? [] },
      ],
    });
    const source = createSessionsSource();
    const ctx = ctxFor(host);
    await source.prepare(ctx);

    const start = await source.page(ctx, undefined, 2);
    const first = await source.page(ctx, start.cursor, 2);
    expect(first.edges.find(e => e.sourceId === 'session:s1')?.strength).toBe(2);

    const second = await source.page(ctx, first.cursor, 2);
    const s1 = second.edges.find(e => e.sourceId === 'session:s1');
    expect(s1?.strength).toBe(3);
    // s2's pair is new this page; nothing else settled is repeated.
    expect(second.edges.map(e => e.sourceId).sort()).toEqual(['session:s1', 'session:s2']);
  });

  it('includes archived sessions by default and excludes them only on request', async () => {
    const capture = (includeArchived: boolean) => {
      const { host, queryCalls } = createTestHost({
        workspacePath: WS,
        queries: [{ match: /./, handle: () => [] }],
      });
      return createSessionsSource()
        .page(ctxFor(host, { includeArchived }), undefined, 10)
        .then(() => queryCalls[0]!.sql);
    };

    // `is_archived` is still SELECTed either way — the flag travels on the node.
    // What must not appear by default is a predicate that hides those rows.
    expect(await capture(true)).not.toMatch(/COALESCE\(is_archived/);
    // `false` rather than `0`: it is the one literal both PGLite (real boolean)
    // and better-sqlite3 (INTEGER 0/1) accept.
    expect(await capture(false)).toMatch(/COALESCE\(is_archived, false\) = false/);
  });
});

describe('tracker source reads both backend encodings identically', () => {
  const base = {
    id: 't1', issue_number: 5, issue_key: 'NIM-5', type: 'bug', document_path: null,
    title: 'A bug', status: 'in-review', created: '2026-01-01T00:00:00Z',
    updated: '2026-01-05T00:00:00Z',
  };
  const payload = { tags: ['collab'], priority: 'high', linkedSessions: ['s9'] };

  it.each([
    ['PGLite (parsed object, real boolean)', { data: payload, archived: true }],
    ['better-sqlite3 (JSON string, integer flag)', { data: JSON.stringify(payload), archived: 1 }],
  ])('%s', async (_label, encoding) => {
    const { host } = createTestHost({
      workspacePath: WS,
      queries: [
        { match: /COUNT\(\*\)/, handle: () => [{ n: 1 }] },
        { match: /FROM tracker_items/, handle: () => [{ ...base, ...encoding }] },
      ],
    });
    const source = createTrackersSource();
    const ctx = ctxFor(host);

    const { total } = await source.prepare(ctx);
    const page = await source.page(ctx, undefined, 10);
    const node = page.records[0]!;

    expect(total).toBe(1);
    expect(node.tags).toEqual(['collab']);
    expect(node.severity).toBe('high');
    expect(node.fields?.archived).toBe(true);
    // Archived and in-review are both non-terminal; neither may produce a
    // close time.
    expect(node.closedAt).toBeUndefined();
    expect(page.edges.map(e => e.targetId)).toEqual(['session:s9']);
    expect(page.edges[0]!.provenance?.kind).toBe('recorded');
  });

  it('emits recorded relationship edges, and none for a type whose schema is missing', async () => {
    const typeDefs = [
      {
        type: 'product-feature',
        model: JSON.stringify({
          displayName: 'Product Feature',
          fields: [
            { name: 'title', type: 'string' },
            { name: 'modules', type: 'relationship', relationshipTypeKey: 'child-of' },
          ],
        }),
        deleted_at: null,
      },
    ];
    const item = (id: string, type: string) => ({
      id, issue_number: null, issue_key: null, type, document_path: null,
      title: id, status: 'open', created: null, updated: null, archived: false,
      data: { customFields: { modules: [{ itemId: 'mod_1', trackerType: 'feature-module' }] } },
    });
    const { host } = createTestHost({
      workspacePath: WS,
      queries: [
        { match: /FROM tracker_type_defs/, handle: () => typeDefs },
        { match: /COUNT\(\*\)/, handle: () => [{ n: 2 }] },
        { match: /FROM tracker_items/, handle: () => [item('feat_1', 'product-feature'), item('x_1', 'unknown-type')] },
      ],
    });
    const source = createTrackersSource();
    const ctx = ctxFor(host);
    await source.prepare(ctx);

    const page = await source.page(ctx, undefined, 10);

    expect(page.edges.map(e => `${e.sourceId}->${e.targetId}`)).toEqual(['tracker:feat_1->tracker:mod_1']);
    expect(page.edges[0]!.provenance).toMatchObject({ kind: 'recorded' });
    expect(page.edges[0]!.provenance!.basis).toContain('modules');
    // `x_1` holds an identically-shaped value, but its type's schema was not
    // read, so nothing says that field is a relationship. Guessing from the
    // name is what produces phantom edges.
    expect(page.edges.some(e => e.sourceId === 'tracker:x_1')).toBe(false);
  });

  it('reports a count that did not parse as unknown rather than as zero', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      queries: [{ match: /COUNT\(\*\)/, handle: () => [{ n: null }] }],
    });

    // "Unknown" blocks a completeness claim; "0" would assert the corpus is
    // empty and make any indexed page look complete.
    expect((await createTrackersSource().prepare(ctxFor(host))).total).toBeNull();
  });
});

describe('git source', () => {
  it('reads headers across all refs and pages with an offset cursor', async () => {
    const commits = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) =>
        `__COMMIT__${String(from + i).padStart(40, '0')}\x1Fsubject ${from + i}\x1Fme\x1F2026-01-01T00:00:00Z`,
      ).join('\n');
    const { host, execCalls } = createTestHost({
      workspacePath: WS,
      execs: [
        { match: /rev-parse/, handle: () => ({ stdout: 'true\n' }) },
        { match: /rev-list --count/, handle: () => ({ stdout: '900\n' }) },
        { match: /git log/, handle: ({ command }) => ({ stdout: commits(2, /skip=2/.test(command) ? 2 : 0) }) },
      ],
    });
    const source = createGitSource();
    const ctx = ctxFor(host);

    expect((await source.prepare(ctx)).total).toBe(900);

    const first = await source.page(ctx, undefined, 2);
    expect(first.records).toHaveLength(2);
    expect(first.cursor).toBe('2');

    const logCommand = execCalls.find(c => /git log/.test(c.command))!.command;
    // HEAD-only was a second, unstated limit on top of the commit cap: work on
    // any other branch was simply absent.
    expect(logCommand).toMatch(/--all/);
    // The header pass must stay lightweight; --name-only across a full history
    // is the expensive part and is fetched on demand instead.
    expect(logCommand).not.toMatch(/--name-only/);
  });

  it('fetches file evidence separately and names the commits it covers', async () => {
    const sha = 'a'.repeat(40);
    const { host, execCalls } = createTestHost({
      workspacePath: WS,
      execs: [
        {
          match: /git log/,
          handle: () => ({ stdout: `__COMMIT__${sha}\npackages/electron/src/main/a.ts\ndocs/x.md\n` }),
        },
      ],
    });

    const evidence = await loadCommitFileEvidence(host, SIGNAL, { shas: [sha] });

    expect(evidence.covered).toEqual([sha]);
    expect(evidence.edges.map(e => e.targetId).sort()).toEqual(['dir:docs', 'dir:packages/electron/main']);
    expect(evidence.edges[0]!.provenance?.kind).toBe('derived');
    // Asking about specific commits must not walk their whole ancestry.
    expect(execCalls[0]!.command).toMatch(/--no-walk/);
    // ...and must not carry `--all`, which git ADDS to the requested set under
    // `--no-walk`: one requested commit came back as every ref tip plus that
    // commit when this was run against the real repository.
    expect(execCalls[0]!.command).not.toMatch(/--all/);
  });

  it('does use every ref for a windowed lookup', async () => {
    const { host, execCalls } = createTestHost({
      workspacePath: WS,
      execs: [{ match: /git log/, handle: () => ({ stdout: '' }) }],
    });

    await loadCommitFileEvidence(host, SIGNAL, { sinceMs: Date.UTC(2026, 0, 1) });

    // A commit on another branch is still evidence of what changed that week.
    expect(execCalls[0]!.command).toMatch(/--all/);
    expect(execCalls[0]!.command).toMatch(/--since=/);
  });

  it('reports a failed evidence lookup instead of returning an empty one', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [{ match: /git log/, handle: () => ({ success: false, stderr: 'bad revision' }) }],
    });

    const evidence = await loadCommitFileEvidence(host, SIGNAL, { shas: ['nope'] });

    expect(evidence.error).toMatch(/bad revision/);
    expect(evidence.covered).toEqual([]);
  });
});

describe('github source', () => {
  it('distinguishes not-installed, not-authenticated, and empty', async () => {
    const missing = createTestHost({ execs: [{ match: /command -v gh/, handle: () => ({ success: false }) }] });
    expect(await createGitHubSource().prepare(ctxFor(missing.host))).toMatchObject({
      availability: 'unavailable',
      message: expect.stringMatching(/not installed/),
    });

    const unauthed = createTestHost({
      execs: [
        { match: /command -v gh/, handle: () => ({ stdout: '/usr/bin/gh' }) },
        { match: /gh repo view/, handle: () => ({ success: false, stderr: 'gh auth login required' }) },
      ],
    });
    expect(await createGitHubSource().prepare(ctxFor(unauthed.host))).toMatchObject({
      availability: 'unavailable',
      message: expect.stringMatching(/auth login/),
    });
  });

  it('pages pull requests then issues, and never double-counts a PR as an issue', async () => {
    const { host } = createTestHost({
      execs: [
        { match: /command -v gh/, handle: () => ({ stdout: '/usr/bin/gh' }) },
        { match: /gh repo view/, handle: () => ({ stdout: '{"nameWithOwner":"o/r"}' }) },
        {
          match: /gh api/,
          handle: ({ command }) =>
            /pulls\?/.test(command)
              ? {
                  stdout: JSON.stringify([
                    { number: 1, title: 'PR', state: 'closed', created_at: '2026-01-01T00:00:00Z', merged_at: '2026-01-02T00:00:00Z' },
                  ]),
                }
              : {
                  stdout: JSON.stringify([
                    { number: 1, title: 'PR', state: 'closed', pull_request: {} },
                    { number: 2, title: 'Issue', state: 'open', created_at: '2026-01-03T00:00:00Z' },
                  ]),
                },
        },
      ],
    });
    const source = createGitHubSource();
    const ctx = ctxFor(host);

    const prepared = await source.prepare(ctx);
    expect(prepared.availability).toBe('available');
    // The REST list endpoints do not report a total without walking every page.
    expect(prepared.total).toBeNull();

    const pulls = await source.page(ctx, undefined, 100);
    expect(pulls.records.map(r => r.id)).toEqual(['pr:1']);
    expect(pulls.records[0]!.status).toBe('merged');
    expect(pulls.records[0]!.fields?.mergedAt).toBe('2026-01-02T00:00:00Z');
    expect(pulls.cursor).toBe('issue:1');

    const issues = await source.page(ctx, pulls.cursor, 100);
    // The issues endpoint returns pull requests too; counting them twice would
    // inflate every issue aggregate.
    expect(issues.records.map(r => r.id)).toEqual(['issue:2']);
    expect(issues.cursor).toBeUndefined();
  });

  it('raises a failed api call rather than yielding an empty page', async () => {
    const { host } = createTestHost({
      execs: [
        { match: /command -v gh/, handle: () => ({ stdout: '/usr/bin/gh' }) },
        { match: /gh repo view/, handle: () => ({ stdout: '{"nameWithOwner":"o/r"}' }) },
        { match: /gh api/, handle: () => ({ success: false, stderr: 'HTTP 403: rate limit exceeded' }) },
      ],
    });
    const source = createGitHubSource();
    const ctx = ctxFor(host);
    await source.prepare(ctx);

    await expect(source.page(ctx, undefined, 100)).rejects.toThrow(/rate limit/);
  });
});

describe('plan fields come only from real frontmatter', () => {
  async function planNode(body: string, path = 'nimbalyst-local/plans/p.md') {
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [
        { match: /find /, handle: () => ({ stdout: `${path}\n` }) },
        { match: /rev-parse/, handle: () => ({ stdout: 'false\n' }) },
        { match: /stat /, handle: () => ({ success: false }) },
        { match: /head -c/, handle: () => ({ stdout: `__PG_FILE__:${path}\n${body}` }) },
      ],
    });
    const source = createPlansSource();
    const ctx = ctxFor(host);
    await source.prepare(ctx);
    return (await source.page(ctx, undefined, 10)).records[0]!;
  }

  it('reads fields from the leading frontmatter block', async () => {
    const node = await planNode(
      '---\nplanStatus:\n  title: Real Plan\n  status: in-development\n  progress: 40\n  tags:\n    - collab\n---\n\n# Body\n',
    );

    expect(node.label).toBe('Real Plan');
    expect(node.status).toBe('in-development');
    expect(node.progress).toBe(40);
    expect(node.tags).toEqual(['collab']);
  });

  it('ignores a status that is prose or a code example in the body', async () => {
    // Both of these are real strings this workspace produced: scanning the
    // whole 4KB head made a TypeScript field declaration and a doc's prose into
    // plan statuses, and they surfaced in the live view as unknown statuses.
    const node = await planNode(
      '# Tracker Item Types\n\nSome prose.\n\n```ts\ninterface Item {\n' +
        '  title: string;                        // Item title (required)\n' +
        '  status: TrackerItemStatus;            // Current status (type-specific)\n' +
        '  progress: number;\n}\n```\n\ntags: [not, frontmatter]\n',
    );

    expect(node.status).toBeUndefined();
    expect(node.progress).toBeUndefined();
    expect(node.tags).toBeUndefined();
    // With no frontmatter title, the filename is the honest fallback.
    expect(node.label).toBe('p');
  });

  it('treats a --- block that follows a heading as body, not frontmatter', async () => {
    // Frontmatter is only frontmatter at the very start of the file. After a
    // heading, `---` is a thematic break; one real plan here has that shape.
    const node = await planNode(
      '# Editor Content Ownership Cleanup\n\n---\nplanStatus:\n  status: in-development\n  progress: 67\n---\n',
    );

    expect(node.status).toBeUndefined();
    expect(node.progress).toBeUndefined();
    expect(node.label).toBe('p');
  });

  it('does not let a later --- block supply fields', async () => {
    const node = await planNode(
      '---\nplanStatus:\n  title: First\n---\n\n## Later\n\n---\nstatus: sneaky\n---\n',
    );

    expect(node.label).toBe('First');
    expect(node.status).toBeUndefined();
  });
});

describe('visibility reflects where a file actually lives', () => {
  const enumerating = (path: string) =>
    createTestHost({
      workspacePath: WS,
      execs: [
        { match: /find /, handle: () => ({ stdout: `${path}\n` }) },
        { match: /rev-parse/, handle: () => ({ stdout: 'false\n' }) },
        { match: /stat /, handle: () => ({ success: false }) },
        { match: /head -c/, handle: () => ({ stdout: `__PG_FILE__:${path}\n# t\n` }) },
      ],
    });

  it('marks gitignored nimbalyst-local documents local, not workspace-shared', async () => {
    // `nimbalyst-local/` is gitignored (`.gitignore:168`). A plan there is not
    // shared with the workspace or the team at all, so reporting it as
    // workspace-shared overstates who can see it.
    const plans = enumerating('nimbalyst-local/plans/a.md');
    const plansSource = createPlansSource();
    const plansCtx = ctxFor(plans.host);
    await plansSource.prepare(plansCtx);
    const plan = (await plansSource.page(plansCtx, undefined, 10)).records[0]!;

    expect(plan.visibility).toBe('local');
  });

  it('keeps a tracked document workspace-shared', async () => {
    const docs = enumerating('docs/E2E_TESTING.md');
    const docsSource = createDocsSource();
    const docsCtx = ctxFor(docs.host);
    await docsSource.prepare(docsCtx);
    const doc = (await docsSource.page(docsCtx, undefined, 10)).records[0]!;

    expect(doc.visibility).toBe('workspace-shared');
  });

  it('marks an architecture diagram under nimbalyst-local local even though the docs root is shared', async () => {
    // The docs source spans BOTH tracked and gitignored roots, so a per-source
    // constant cannot be right for all of its records.
    const local = enumerating('nimbalyst-local/architecture/x.excalidraw');
    const source = createDocsSource();
    const ctx = ctxFor(local.host);
    await source.prepare(ctx);
    const node = (await source.page(ctx, undefined, 10)).records[0]!;

    expect(node.visibility).toBe('local');
  });
});

describe('memory source indexes only what a fact actually records', () => {
  it('discloses the memory roots it does not read', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [{ match: /find /, handle: () => ({ stdout: '' }) }],
    });

    const prepared = await createMemorySource().prepare(ctxFor(host));

    // The memory engine indexes more than the FactsStore: a second root under
    // the user's home is flagged `personal` by the engine. This source reads
    // the workspace facts directory ONLY, and coverage has to say so — a user
    // reading "memory: 2 records" should not conclude their memory is nearly
    // empty when the engine holds far more.
    expect(prepared.scope).toMatch(/personal/i);
    expect(prepared.scope).toMatch(/not indexed|does not/i);
  });

  it('states that facts carry no citations rather than inventing relationships', async () => {
    const path = 'nimbalyst-local/voice-memory/20260627-a-fact-06ec0ff6.md';
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [
        { match: /find /, handle: () => ({ stdout: `${path}\n` }) },
        { match: /rev-parse/, handle: () => ({ stdout: 'false\n' }) },
        { match: /stat /, handle: () => ({ success: false }) },
        {
          match: /head -c/,
          handle: () => ({
            stdout:
              `__PG_FILE__:${path}\n---\ncategory: "collab"\nscope: "teams"\npriority: 2\n` +
              `created: "2026-06-27T18:18:50.210Z"\n---\n\nWe are finishing Teams.\n`,
          }),
        },
      ],
    });
    const source = createMemorySource();
    const ctx = ctxFor(host);

    const prepared = await source.prepare(ctx);
    expect(prepared.availability).toBe('available');
    expect(prepared.message).toMatch(/no citations/);

    const page = await source.page(ctx, undefined, 10);
    const node = page.records[0]!;

    expect(node.source).toBe('memory');
    expect(node.label).toBe('We are finishing Teams.');
    expect(node.fields?.scope).toBe('teams');
    expect(node.fields?.priority).toBe(2);
    // `created` is written by `remember` at write time, so it is recorded, not
    // inferred from a file's mtime.
    expect(node.createdAt).toBe(Date.parse('2026-06-27T18:18:50.210Z'));
    // A fact file has no link fields at all. Emitting even one edge here would
    // manufacture the provenance the redesign exists to protect.
    expect(page.edges).toEqual([]);
    expect(node.fields?.citationsAvailable).toBe(false);
  });

  it('says the store is absent instead of reporting zero facts as a clean result', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [{ match: /find /, handle: () => ({ stdout: '' }) }],
    });

    const prepared = await createMemorySource().prepare(ctxFor(host));

    expect(prepared.availability).toBe('unavailable');
    expect(prepared.message).toMatch(/voice-memory/);
  });
});


describe('commit evidence paging', () => {
  it('exhausts the requested window beyond 2000 commits and only caps explicitly', async () => {
    const all = Array.from({ length: 2105 }, (_, i) => `__COMMIT__${i.toString(16).padStart(40, '0')}\ndocs/a.md\n`);
    const { host, execCalls } = createTestHost({ execs: [{ match: /git log/, handle: ({ command }) => {
      const skip = Number(command.match(/--skip=(\d+)/)?.[1] ?? 0);
      const limit = Number(command.match(/-n (\d+)/)?.[1] ?? all.length);
      return { stdout: all.slice(skip, skip + limit).join('') };
    } }] });
    const full = await loadCommitFileEvidence(host, SIGNAL, { sinceMs: 0 });
    expect(full.covered).toHaveLength(2105);
    expect(full.truncated).toBe(false);
    expect(execCalls.length).toBeGreaterThan(1);
    const capped = await loadCommitFileEvidence(host, SIGNAL, { sinceMs: 0, maxCommits: 2104 });
    expect(capped.covered).toHaveLength(2104);
    expect(capped.truncated).toBe(true);
    const exact = await loadCommitFileEvidence(host, SIGNAL, { sinceMs: 0, maxCommits: 2105 });
    expect(exact.truncated).toBe(false);
  });
});
