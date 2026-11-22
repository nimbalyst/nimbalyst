// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  loadOrgDirectory,
  matchOrgMembers,
  readResourceSharingStatus,
  readSharedDocumentFromRenderer,
} from '../collabReadToolHandlers';
import { findWorkspaceWindowMatch } from '../../../window/WindowManager';
import { requestFromRenderer } from '../../rendererRequest';
import type { TeamDetails, TeamMember } from '../../../services/TeamService';

vi.mock('../../../services/TeamService', () => ({
  findTeamForWorkspace: vi.fn(async () => null),
  resolveTeamForWorkspace: vi.fn(async () => ({ team: null, complete: false })),
  getOrgScopedJwt: vi.fn(),
  listMembersWithTeamJwt: vi.fn(),
}));

vi.mock('../../../window/WindowManager', () => ({
  documentServices: new Map(),
  findWorkspaceWindowMatch: vi.fn(() => null),
}));

vi.mock('../../rendererRequest', () => ({
  requestFromRenderer: vi.fn(async () => ({
    status: 'answered',
    response: { success: true, result: { kind: 'document', sourceId: 'doc-1', teamVisible: false, orgId: null, reason: 'notShared' } },
  })),
}));

const TEAM = {
  orgId: 'org-design',
  name: 'Design Team',
  teamProjectId: 'project-design',
} as TeamDetails;

function member(memberId: string, name: string, email: string): TeamMember {
  return { memberId: asTeamMemberId(memberId), name, email, status: 'active', role: 'member', createdAt: '2026-01-01' };
}

describe('collaboration read tools', () => {
  it('reports unavailable discovery instead of telling the assistant the workspace has no organization', async () => {
    await expect(loadOrgDirectory('/workspace/design', undefined)).rejects.toThrow('Organization directory is unavailable');
  });

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
    const findLinkedDocument = vi.fn(async (_workspacePath: string, _sourceFilePath: string) => ({
      orgId: 'org-design',
      documentId: 'doc-spec',
    }));
    const deps = sharingDeps({ findLinkedDocument });

    const relative = await readResourceSharingStatus('file', 'docs/spec.md', '/workspace/design', deps);
    await readResourceSharingStatus('file', '/workspace/design/docs/spec.md', '/workspace/design', deps);

    // A raw relative path here would be resolved against the main process cwd
    // by the binding lookup, silently reporting a shared file as unshared.
    expect(findLinkedDocument.mock.calls.map((call) => call[1])).toEqual([
      '/workspace/design/docs/spec.md',
      '/workspace/design/docs/spec.md',
    ]);
    // The document id rides along because a `file` ref is only meaningful on
    // the machine that reported it; a caller handing the resource to someone
    // else has nothing else to name it by.
    expect(relative).toMatchObject({
      teamVisible: true,
      orgId: 'org-design',
      documentId: 'doc-spec',
      reason: 'shared',
    });
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

describe('readSharedDocumentFromRenderer', () => {
  // The renderer keys a team index by the project path its window holds. A
  // worktree (or a symlinked spelling) of that project must ask about the
  // project, or the open project answers "not loaded".
  it('asks the window about the project the request resolves to, not the worktree path', async () => {
    const window = { isDestroyed: () => false };
    vi.mocked(findWorkspaceWindowMatch).mockReturnValue({
      window, windowId: 1, matchedPath: '/projects/app', isActive: true, kind: 'worktree-parent',
    } as never);

    await readSharedDocumentFromRenderer('doc-1', '/projects/app_worktrees/brave-otter');

    expect(findWorkspaceWindowMatch).toHaveBeenCalledWith('/projects/app_worktrees/brave-otter');
    expect(requestFromRenderer).toHaveBeenCalledWith(
      window,
      'mcp:getResourceSharingStatus',
      { sourceId: 'doc-1', workspacePath: '/projects/app' },
      expect.anything(),
    );
  });
});
