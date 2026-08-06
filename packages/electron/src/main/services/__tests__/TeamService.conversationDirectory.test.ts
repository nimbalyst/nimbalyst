import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));
vi.mock('../../utils/gitUtils', () => ({ getNormalizedGitRemote: vi.fn() }));
vi.mock('../teamProjectResolver', () => ({ resolveTeamForRemoteHash: vi.fn() }));
vi.mock('../../utils/collabSyncUrl', () => ({
  getCollabSyncHttpUrl: () => 'https://sync.test',
}));
vi.mock('../jwtOrg', () => ({
  assertJwtMatchesOrg: vi.fn(),
  getJwtExp: vi.fn(() => Math.floor(Date.now() / 1000) + 300),
  AuthContextMismatchError: class AuthContextMismatchError extends Error {},
}));
vi.mock('../StytchAuthService', () => ({
  getAccounts: vi.fn(() => [{
    personalOrgId: 'personal-1',
    email: 'user@test.com',
  }]),
  getPersonalSessionJwt: vi.fn(() => 'personal-jwt'),
  getPersonalSessionJwtForAccount: vi.fn(() => 'personal-jwt'),
  getSessionToken: vi.fn(() => 'session-token'),
  getSessionTokenForAccount: vi.fn(() => 'session-token'),
  isAuthenticated: vi.fn(() => true),
  refreshPersonalSession: vi.fn(async () => false),
  refreshPersonalSessionForAccount: vi.fn(async () => null),
  onAuthStateChange: vi.fn(() => () => {}),
  updateSessionToken: vi.fn(),
  updateSessionTokenForAccount: vi.fn(),
  getUserEmail: vi.fn(() => 'user@test.com'),
  getPersonalOrgId: vi.fn(() => 'personal-1'),
  getPersonalUserId: vi.fn(() => 'user-1'),
}));
vi.mock('@nimbalyst/runtime', () => ({
  asTeamJwt: (jwt: string) => jwt,
}));
vi.mock('../../database/initialize', () => ({}));
vi.mock('../AccountOrgBindingService', () => ({
  repairAccountOrgBindingFromEmail: vi.fn(),
  resolveTeamOrgAccountBinding: vi.fn(),
  upsertAccountOrgBinding: vi.fn(),
}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../TeamCustodyService', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
vi.mock('../TeamAuthBootstrap', () => ({
  createTeamAuthBootstrap: (fn: unknown) => fn,
}));

import {
  archiveConversation,
  createConversation,
  listConversationMembers,
  listConversations,
  renameOrganization,
  setAgentPosting,
  setConversationMembership,
  updateConversation,
} from '../TeamService';

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('TeamService conversation directory REST client', () => {
  function lastRequest(): { method: string; body?: string } {
    const calls = fetchMock.mock.calls as Array<[
      string,
      { method: string; body?: string },
    ]>;
    return calls[calls.length - 1][1];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.endsWith('/api/teams/org-directory/switch')) {
        return jsonResponse({
          sessionJwt: 'team-jwt',
          sessionToken: 'team-session-token',
        });
      }
      if (rawUrl.includes('/conversations?')) {
        return jsonResponse({ conversations: [] });
      }
      if (rawUrl.endsWith('/conversations')) {
        return jsonResponse({
          descriptor: { id: 'design' },
          memberships: [],
        });
      }
      if (rawUrl.endsWith('/conversations/design/members')) {
        return jsonResponse({
          memberships: [{
            conversationId: 'design',
            userId: 'member-b',
            role: 'member',
            addedByUserId: 'member-a',
            createdAt: 1,
          }],
        });
      }
      if (rawUrl.endsWith('/archive')) {
        return jsonResponse({ descriptor: { id: 'design' } });
      }
      if (rawUrl.includes('/members/')) {
        return jsonResponse({ memberships: [] });
      }
      if (rawUrl.endsWith('/agent-posting')) {
        return jsonResponse({ descriptor: { id: 'design' } });
      }
      if (rawUrl.endsWith('/api/teams/org-directory')) {
        return jsonResponse({});
      }
      if (/\/conversations\/[^/]+$/.test(rawUrl)) {
        return jsonResponse({ descriptor: { id: 'design' } });
      }
      throw new Error(`Unexpected fetch: ${rawUrl}`);
    });
  });

  it('uses the team JWT for every endpoint and preserves the server wire shape', async () => {
    const orgId = 'org-directory';
    await listConversations(orgId, { includeArchived: true });
    await listConversationMembers(orgId, 'design');
    await createConversation(orgId, {
      id: 'design',
      kind: 'orgRoom',
      visibility: 'private',
      title: 'Design',
      topic: 'Design discussions',
      memberships: [{ userId: 'member-b', role: 'member' }],
      agentPostingEnabled: true,
    });
    await archiveConversation(orgId, 'design');
    await setConversationMembership(
      orgId,
      'design',
      'member-b',
      { active: true, role: 'roomAdmin' },
    );
    await setConversationMembership(
      orgId,
      'design',
      'member-b',
      { active: false },
    );
    await setAgentPosting(orgId, 'design', false);
    await renameOrganization(orgId, 'Acme Labs');

    const requests = fetchMock.mock.calls.slice(1) as Array<[
      string,
      { method: string; headers: Record<string, string>; body?: string },
    ]>;
    expect(requests).toHaveLength(8);
    expect(requests.every(([, init]) =>
      init.headers.Authorization === 'Bearer team-jwt')).toBe(true);
    expect(requests[0][0]).toBe(
      'https://sync.test/api/teams/org-directory/conversations'
      + '?includeDirect=true&includeArchived=true',
    );
    expect(requests[0][1].method).toBe('GET');
    expect(requests[1][0]).toMatch(/\/conversations\/design\/members$/);
    expect(requests[1][1].method).toBe('GET');
    expect(JSON.parse(requests[2][1].body!)).toEqual({
      id: 'design',
      kind: 'orgRoom',
      visibility: 'private',
      title: 'Design',
      topic: 'Design discussions',
      memberships: [{ userId: 'member-b', role: 'member' }],
      agentPostingEnabled: true,
    });
    expect(requests[3][0]).toMatch(/\/conversations\/design\/archive$/);
    expect(requests[3][1].method).toBe('POST');
    expect(requests[4][1].method).toBe('PUT');
    expect(JSON.parse(requests[4][1].body!)).toEqual({
      role: 'roomAdmin',
    });
    expect(requests[5][1].method).toBe('DELETE');
    expect(requests[5][1].body).toBeUndefined();
    expect(JSON.parse(requests[6][1].body!)).toEqual({ enabled: false });
    expect(requests[7][0]).toBe(
      'https://sync.test/api/teams/org-directory',
    );
    expect(requests[7][1].method).toBe('PUT');
    expect(JSON.parse(requests[7][1].body!)).toEqual({ name: 'Acme Labs' });
  });

  it('sends only the conversation fields that were supplied', async () => {
    const orgId = 'org-directory';

    await updateConversation(orgId, 'design', { title: '  Design HQ  ' });
    expect(JSON.parse(lastRequest().body!)).toEqual({ title: 'Design HQ' });
    expect(lastRequest().method).toBe('PUT');

    // An emptied topic clears it; an absent one must not appear at all, or the
    // server would read it as "replace with nothing" on a plain rename.
    await updateConversation(orgId, 'design', { topic: '   ' });
    expect(JSON.parse(lastRequest().body!)).toEqual({ topic: null });

    await updateConversation(orgId, 'design', { title: 'Design', topic: 'Reviews' });
    expect(JSON.parse(lastRequest().body!)).toEqual({
      title: 'Design',
      topic: 'Reviews',
    });
  });

  it('defaults missing capabilities rather than handing the renderer a broken row', async () => {
    fetchMock.mockImplementation(async (rawUrl: string) => {
      if (rawUrl.endsWith('/api/teams/org-directory/switch')) {
        return jsonResponse({
          sessionJwt: 'team-jwt',
          sessionToken: 'team-session-token',
        });
      }
      // A server old enough to predate capability resolution.
      return jsonResponse({ conversations: [{ id: 'design', orgId: 'org-directory' }] });
    });

    const conversations = await listConversations('org-directory');

    expect(conversations).toEqual([
      expect.objectContaining({ id: 'design', capabilities: [] }),
    ]);
  });

  it('rejects an empty conversation update before I/O', async () => {
    await expect(updateConversation('org-directory', 'design', {})).rejects.toThrow(
      'Conversation title or topic is required',
    );
    await expect(
      updateConversation('org-directory', 'design', { title: '  ' }),
    ).rejects.toThrow('Conversation title must be a non-empty string');
  });

  it('fails before I/O when an explicit organization id is missing', async () => {
    await expect(listConversations('')).rejects.toThrow(
      'Organization id is required',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
