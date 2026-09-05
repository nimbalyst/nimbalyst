// @vitest-environment node

/**
 * Regressions from the September 5 project-understanding review. Each case here
 * is a claim the data layer was making that the sources do not support:
 *
 *  - `in-review` was stamped as a closure, so Pulse's "open now" hid items that
 *    are still open.
 *  - archiving was folded into completion, so an archived-but-unfinished record
 *    reported a close time it never had.
 *  - directory rollups were emitted with no provenance, so Trails described a
 *    path-derived relation as an explicitly recorded link.
 *  - edges to records outside the loaded page were dropped before any consumer
 *    saw them, so "the sources recorded none" was indistinguishable from "the
 *    other end was not loaded".
 *  - a failed `gh` invocation returned an empty success, which reads as
 *    "GitHub has no PRs" rather than "GitHub could not be read".
 */
import { describe, expect, it } from 'vitest';
import { createTestHost, gitLogBlock } from './testHost';
import { databaseAdapter } from '../databaseAdapter';
import { gitAdapter } from '../gitAdapter';
import { githubAdapter } from '../githubAdapter';
import { docAdapter } from '../docAdapter';
import { loadProjectSnapshot } from '../loader';
import { sessionRowEdges, trackerRowToNode } from '../recordMapping';
import type { ProjectGraphEdge, ProjectGraphNode } from '../../types';

const WS = '/ws';

function trackerRow(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    issue_number: 1,
    issue_key: 'NIM-1',
    type: 'bug',
    data: {},
    document_path: null,
    title: 'A bug',
    status: 'open',
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-02T00:00:00.000Z',
    archived: false,
    ...over,
  };
}

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    title: 'A session',
    provider: 'claude',
    model: 'opus',
    status: 'active',
    session_type: null,
    agent_role: null,
    worktree_id: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    last_activity: '2026-09-02T00:00:00.000Z',
    metadata: {},
    is_archived: false,
    ...over,
  };
}

async function runDatabaseAdapter(opts: {
  sessions?: unknown[];
  files?: unknown[];
  trackers?: unknown[];
}) {
  const { host } = createTestHost({
    workspacePath: WS,
    queries: [
      { match: /FROM session_files/, handle: () => opts.files ?? [] },
      { match: /FROM ai_sessions/, handle: () => opts.sessions ?? [] },
      { match: /FROM tracker_items/, handle: () => opts.trackers ?? [] },
    ],
  });
  return databaseAdapter.run(host);
}

function byId<T extends { id: string }>(items: T[], id: string): T {
  const found = items.find(i => i.id === id);
  if (!found) throw new Error(`no ${id} in ${items.map(i => i.id).join(', ')}`);
  return found;
}

describe('tracker lifecycle is not conflated with review or archival', () => {
  it('leaves an in-review item open', async () => {
    const result = await runDatabaseAdapter({
      trackers: [trackerRow({ id: 'r1', status: 'in-review' })],
    });

    // `in-review` is a working state: the item is still open, still assigned,
    // and still needs someone. Stamping closedAt made "open now" omit it.
    expect(byId(result.nodes, 'tracker:r1').closedAt).toBeUndefined();
  });

  it('still closes a genuinely terminal item', async () => {
    const result = await runDatabaseAdapter({
      trackers: [trackerRow({ id: 'r2', status: 'done' })],
    });

    expect(byId(result.nodes, 'tracker:r2').closedAt).toBe(Date.parse('2026-09-02T00:00:00.000Z'));
  });

  it('reports archival as a flag, never as a closure', async () => {
    const result = await runDatabaseAdapter({
      trackers: [trackerRow({ id: 'r3', status: 'open', archived: true })],
      sessions: [sessionRow({ id: 'a1', status: 'active', is_archived: 1 })],
    });

    const tracker = byId(result.nodes, 'tracker:r3');
    expect(tracker.fields?.archived).toBe(true);
    expect(tracker.closedAt).toBeUndefined();

    // A session can be filed away while its work was never finished; the
    // archive flag is a shelf location, not an outcome.
    const session = byId(result.nodes, 'session:a1');
    expect(session.fields?.archived).toBe(true);
    expect(session.closedAt).toBeUndefined();
  });

  it('closes an archived session that also reached a completed status', async () => {
    const result = await runDatabaseAdapter({
      sessions: [sessionRow({ id: 'a2', status: 'completed', is_archived: true })],
    });

    const session = byId(result.nodes, 'session:a2');
    expect(session.fields?.archived).toBe(true);
    expect(session.closedAt).toBe(Date.parse('2026-09-02T00:00:00.000Z'));
  });
});

describe('every edge states how it was produced', () => {
  it('marks directory rollups derived and explicit links recorded', async () => {
    const result = await runDatabaseAdapter({
      sessions: [sessionRow({ id: 's1' })],
      files: [{ session_id: 's1', file_path: `${WS}/packages/electron/src/main/a.ts` }],
      trackers: [
        trackerRow({
          id: 't1',
          type: 'bug',
          data: { linkedSessions: ['s1'], linkedCommitSha: 'abc123' },
        }),
        trackerRow({ id: 't2', type: 'decision', data: { linkedCommitSha: 'def456' } }),
      ],
    });

    const kinds = new Map(result.edges.map(e => [e.type, e.provenance?.kind]));

    // The session recorded a FILE; the directory is this adapter's rollup of
    // that path. Calling it a recorded link overstates what the source said.
    expect(kinds.get('edited_in')).toBe('derived');
    expect(kinds.get('worked_on_in')).toBe('recorded');
    // The sha is recorded on the item; "fixes" is inferred from the item's type.
    expect(kinds.get('fixes')).toBe('derived');
    expect(kinds.get('references')).toBe('recorded');
    for (const edge of result.edges) {
      expect(edge.provenance?.basis, `${edge.type} needs a basis`).toBeTruthy();
    }
  });

  it('marks commit-to-directory rollups derived', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [
        { match: /rev-parse/, handle: () => ({ stdout: 'true\n' }) },
        {
          match: /git log/,
          handle: () => ({
            stdout: gitLogBlock('a'.repeat(40), 'subject', 'me', '2026-09-01T00:00:00Z', [
              'packages/electron/src/main/a.ts',
            ]),
          }),
        },
      ],
    });

    const result = await gitAdapter.run(host);
    const touches = result.edges.find(e => e.type === 'touches');

    expect(touches?.provenance?.kind).toBe('derived');
  });
});

describe('indexed tracker projection', () => {
  it('keeps links, status, tags and activity and drops the rest', () => {
    const node = trackerRowToNode(
      trackerRow({
        data: {
          tags: ['collab'],
          priority: 'high',
          linkedSessions: ['s1'],
          linkedCommitSha: 'abc',
          customFields: {
            modules: [{ itemId: 'mod_1', trackerType: 'feature-module' }],
            sourceDocument: 'docs/FEATURE_INVENTORY.md',
          },
          activity: [
            { id: 'a1', action: 'status_changed', field: 'status', timestamp: 1, from: 'to-do', to: 'done',
              authorIdentity: { email: 'x@y.z', displayName: 'x', gitName: 'X', gitEmail: 'x@y.z' } },
          ],
          description: 'a very long body',
          comments: [{ text: 'hi' }],
          arbitraryVendorBlob: { deeply: { nested: 'junk' } },
        },
      }),
      { dataProjection: 'indexed' },
    );

    const data = node.fields?.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([
      'activity', 'customFields', 'linkedCommitSha', 'linkedSessions', 'priority', 'tags',
    ]);
    // Relationship-shaped entries survive inside customFields; a stray scalar
    // does not.
    expect(Object.keys(data.customFields as object)).toEqual(['modules']);
    // Activity keeps what reconstructs a phase segment and drops the identity
    // blob repeated on every entry.
    expect(Object.keys((data.activity as Array<Record<string, unknown>>)[0]!).sort()).toEqual([
      'action', 'field', 'from', 'id', 'timestamp', 'to',
    ]);
    expect(node.fields?.dataProjection).toBe('indexed');
    expect(node.fields?.droppedKeys).toEqual(
      expect.arrayContaining(['description', 'comments', 'arbitraryVendorBlob']),
    );
    // The projection must not change what the record says about itself.
    expect(node.tags).toEqual(['collab']);
    expect(node.severity).toBe('high');
  });

  it('leaves the legacy adapter path on the full blob', async () => {
    const result = await runDatabaseAdapter({
      trackers: [trackerRow({ data: { description: 'body', arbitraryVendorBlob: 1 } })],
    });

    const data = byId(result.nodes, 'tracker:t1').fields?.data as Record<string, unknown>;
    // The old graph's inspector reads arbitrary fields; only the index projects.
    expect(data.arbitraryVendorBlob).toBe(1);
  });
});

describe('session links to file-backed records', () => {
  it('maps a file: reference to the canonical plan or doc id, never to a tracker id', () => {
    const edges = sessionRowEdges(
      sessionRow({
        id: 's1',
        metadata: {
          linkedTrackerItemIds: [
            'bug_1777929869752_gzvvz1',
            'file:nimbalyst-local/plans/multi-desktop-session-sync.md',
            `file:${WS}/docs/E2E_TESTING.md`,
          ],
        },
      }) as never,
      { workspacePath: WS },
    );

    // `tracker:file:...` was a synthetic id that matched no record anywhere, so
    // the relation was permanently unresolvable and the linked plan looked
    // unlinked. Both shapes appear in real session metadata: workspace-relative
    // and absolute.
    expect(edges.map(e => e.sourceId)).toEqual([
      'tracker:bug_1777929869752_gzvvz1',
      'plan:nimbalyst-local/plans/multi-desktop-session-sync.md',
      'doc:docs/E2E_TESTING.md',
    ]);
    expect(edges.every(e => !e.sourceId.startsWith('tracker:file:'))).toBe(true);
  });

  it('preserves an unrecognised file reference under its own identity', () => {
    const edges = sessionRowEdges(
      sessionRow({
        id: 's1',
        metadata: { linkedTrackerItemIds: ['file:some/other/place/notes.md', 'file:/outside/the/workspace.md'] },
      }) as never,
      { workspacePath: WS },
    );

    // Not under a plans or docs root, so no canonical record exists to point
    // at. Keeping the `file:` identity leaves it resolvable later; inventing a
    // tracker id makes it permanently wrong.
    expect(edges.map(e => e.sourceId)).toEqual([
      'file:some/other/place/notes.md',
      'file:/outside/the/workspace.md',
    ]);
  });

  it('dedupes an absolute and a relative reference to the same file', () => {
    const edges = sessionRowEdges(
      sessionRow({
        id: 's1',
        metadata: {
          linkedTrackerItemIds: [
            'file:nimbalyst-local/plans/a.md',
            `file:${WS}/nimbalyst-local/plans/a.md`,
          ],
        },
      }) as never,
      { workspacePath: WS },
    );

    // The same plan written two ways is one relationship, not two.
    expect(edges).toHaveLength(1);
    expect(edges[0]!.sourceId).toBe('plan:nimbalyst-local/plans/a.md');
  });

  it('states the reference kind in the basis and dedupes a repeated pair', () => {
    const edges = sessionRowEdges(
      sessionRow({
        id: 's1',
        metadata: {
          linkedTrackerItemIds: [
            'file:nimbalyst-local/plans/a.md',
            'file:nimbalyst-local/plans/a.md',
          ],
        },
      }) as never,
      { workspacePath: WS },
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.provenance?.kind).toBe('recorded');
    expect(edges[0]!.provenance?.basis).toMatch(/file reference/i);
  });
});

describe('relationships to records outside the loaded page survive', () => {
  it('keeps a dangling edge in the raw set while the drawn set stays resolvable', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      queries: [
        { match: /FROM session_files/, handle: () => [] },
        { match: /FROM ai_sessions/, handle: () => [] },
        {
          match: /FROM tracker_items/,
          handle: () => [trackerRow({ id: 't1', data: { linkedSessions: ['not-loaded'] } })],
        },
      ],
    });

    const loaded = await loadProjectSnapshot(host);
    const dangling = (e: ProjectGraphEdge) => e.targetId === 'session:not-loaded';

    // The drawn graph still cannot render an arrow to a node it does not have.
    expect(loaded.snapshot.edges.some(dangling)).toBe(false);
    // But the relationship was recorded, so a consumer must be able to tell
    // "the other end is not loaded" apart from "there is no link".
    expect(loaded.rawEdges.some(dangling)).toBe(true);
  });
});

describe('a source that failed says so', () => {
  it('does not report an unreadable GitHub as an empty GitHub', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [
        { match: /command -v gh/, handle: () => ({ stdout: 'yes\n' }) },
        {
          match: /gh (pr|issue) list/,
          handle: () => ({ success: false, stdout: '', stderr: 'gh: not authenticated', exitCode: 4 }),
        },
      ],
    });

    const result = await githubAdapter.run(host);

    expect(result.status).not.toBe('ok');
    expect(result.message).toMatch(/authenticated/);
  });

  it('carries native GitHub timestamps into fields', async () => {
    const { host } = createTestHost({
      workspacePath: WS,
      execs: [
        { match: /command -v gh/, handle: () => ({ stdout: 'yes\n' }) },
        {
          match: /gh pr list/,
          handle: () => ({
            stdout: JSON.stringify([
              {
                number: 7,
                title: 'A PR',
                state: 'MERGED',
                createdAt: '2026-08-01T00:00:00Z',
                mergedAt: '2026-08-03T00:00:00Z',
                closedAt: '2026-08-03T00:00:00Z',
              },
            ]),
          }),
        },
        { match: /gh issue list/, handle: () => ({ stdout: '[]' }) },
      ],
    });

    const result = await githubAdapter.run(host);
    const pr = byId(result.nodes as ProjectGraphNode[], 'pr:7');

    // Pulse projects creation events off `fields.createdAt`; without it GitHub
    // activity is invisible even though the service reports an exact time.
    expect(pr.fields?.createdAt).toBe('2026-08-01T00:00:00Z');
    expect(pr.fields?.mergedAt).toBe('2026-08-03T00:00:00Z');
  });
});

describe('filesystem enumeration is complete and quoted', () => {
  it('enumerates without an arbitrary head cap and survives odd path characters', async () => {
    const paths = [
      "docs/it's a doc.md",
      'docs/normal.md',
      'design/$weird `name`.md',
    ];
    const { host, execCalls } = createTestHost({
      workspacePath: WS,
      execs: [
        { match: /find /, handle: () => ({ stdout: paths.join('\n') }) },
        { match: /rev-parse/, handle: () => ({ stdout: 'false\n' }) },
        { match: /stat /, handle: () => ({ success: false }) },
      ],
    });

    const result = await docAdapter.run(host);

    expect(result.nodes.map(n => n.sublabel).sort()).toEqual([...paths].sort());
    // `head -N` silently changes the answer; a truncation must be reported, not
    // baked into the enumeration.
    expect(execCalls.some(c => /find /.test(c.command) && /head -\d/.test(c.command))).toBe(false);
  });
});
