// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  loadOrgDirectory,
  matchOrgMembers,
  readResourceSharingStatus,
} from '../collabReadToolHandlers';
import type { TeamDetails, TeamMember } from '../../../services/TeamService';

const TEAM = {
  orgId: 'org-design',
  name: 'Design Team',
  teamProjectId: 'project-design',
} as TeamDetails;

function member(memberId: string, name: string, email: string): TeamMember {
  return { memberId: asTeamMemberId(memberId), name, email, status: 'active', role: 'member', createdAt: '2026-01-01' };
}

describe('collaboration read tools', () => {
  it('keeps ambiguous name matches distinguishable from a missing person', () => {
    const roster = [
      member('member-karl-one', 'Karl Jones', 'karl.jones@example.test'),
      member('member-karl-two', 'Karl Smith', 'karl.smith@example.test'),
      member('member-dana', 'Dana Lee', 'dana@example.test'),
    ];

    expect(matchOrgMembers(TEAM, roster, 'Karl')).toMatchObject({
      status: 'ambiguous',
      org: { teamProjectId: 'project-design' },
      members: [
        { memberId: 'member-karl-one', displayName: 'Karl Jones', email: 'karl.jones@example.test' },
        { memberId: 'member-karl-two', displayName: 'Karl Smith', email: 'karl.smith@example.test' },
      ],
    });
    expect(matchOrgMembers(TEAM, roster, 'Mo')).toMatchObject({
      status: 'notFound',
      members: [],
    });
  });

  it('refuses the directory read when team authorization is unavailable', async () => {
    const listMembers = vi.fn(async () => ({ members: [] }));

    await expect(loadOrgDirectory('/workspace/design', 'Karl', {
      findTeam: vi.fn(async () => TEAM),
      getTeamJwt: vi.fn(async () => { throw new Error('No team JWT is available'); }),
      listMembers,
    })).rejects.toThrow('No team JWT is available');

    expect(listMembers).not.toHaveBeenCalled();
  });
});

describe('readResourceSharingStatus', () => {
  function sharingDeps(overrides: Partial<Parameters<typeof readResourceSharingStatus>[3]> = {}) {
    return {
      findTeam: vi.fn(async () => TEAM),
      readDocument: vi.fn(async () => { throw new Error('readDocument not expected'); }),
      readTracker: vi.fn(async () => ({ found: true, teamVisible: true })),
      findLinkedDocument: vi.fn(async () => null),
      ...overrides,
    } as Parameters<typeof readResourceSharingStatus>[3];
  }

  it('resolves a relative file sourceId against the workspace before looking up its binding', async () => {
    const findLinkedDocument = vi.fn(async (_workspacePath: string, _sourceFilePath: string) => ({ orgId: 'org-design' }));
    const deps = sharingDeps({ findLinkedDocument });

    const relative = await readResourceSharingStatus('file', 'docs/spec.md', '/workspace/design', deps);
    await readResourceSharingStatus('file', '/workspace/design/docs/spec.md', '/workspace/design', deps);

    // A raw relative path here would be resolved against the main process cwd
    // by the binding lookup, silently reporting a shared file as unshared.
    expect(findLinkedDocument.mock.calls.map((call) => call[1])).toEqual([
      '/workspace/design/docs/spec.md',
      '/workspace/design/docs/spec.md',
    ]);
    expect(relative).toMatchObject({ teamVisible: true, orgId: 'org-design', reason: 'shared' });
  });

  it('reports an unbound file as not shared', async () => {
    const status = await readResourceSharingStatus('file', 'docs/spec.md', '/workspace/design', sharingDeps());

    expect(status).toMatchObject({ teamVisible: false, orgId: null, reason: 'notShared' });
  });

  it('separates a missing tracker item, an unpublished one, and one with no owning team', async () => {
    const missing = await readResourceSharingStatus('tracker', 'item-missing', '/workspace/design', sharingDeps({
      readTracker: vi.fn(async () => ({ found: false, teamVisible: false })),
    }));
    const unpublished = await readResourceSharingStatus('tracker', 'item-unpublished', '/workspace/design', sharingDeps({
      readTracker: vi.fn(async () => ({ found: true, teamVisible: false })),
    }));
    const teamless = await readResourceSharingStatus('tracker', 'item-teamless', '/workspace/design', sharingDeps({
      findTeam: vi.fn(async () => null),
    }));
    const shared = await readResourceSharingStatus('tracker', 'item-shared', '/workspace/design', sharingDeps());

    expect(missing).toMatchObject({ teamVisible: false, orgId: null, reason: 'notFound' });
    expect(unpublished).toMatchObject({ teamVisible: false, orgId: null, reason: 'notShared' });
    expect(teamless).toMatchObject({ teamVisible: false, orgId: null, reason: 'noTeam' });
    expect(shared).toMatchObject({ teamVisible: true, orgId: 'org-design', reason: 'shared' });
  });
});
