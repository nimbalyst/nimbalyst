// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `nimbalyst://invite/{orgId}?email=...` carries no Stytch token — the desktop
 * app accepts an invitation by exchanging a session it already holds. That makes
 * the email in the link the only thing tying the link to an identity, and it is
 * attacker-supplied. These tests pin the guard: a link is only ever acted on by
 * a signed-in account that owns the invited address.
 */

const { accountsMock, authenticatedMock, fetchMock } = vi.hoisted(() => ({
  accountsMock: vi.fn(() => [{
    personalOrgId: 'personal-1',
    email: 'invitee@test.com',
    sessionStatus: 'active',
  }] as Array<Record<string, unknown>>),
  authenticatedMock: vi.fn(() => true),
  fetchMock: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

const gitRemoteFnMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/gitUtils', () => ({
  getNormalizedGitRemote: gitRemoteFnMock,
  getRawGitRemote: gitRemoteFnMock,
  normalizeGitRemote: (url: string | null) => url,
  getGitRemoteIdentities: async (workspacePath: string) => {
    const remote = await gitRemoteFnMock(workspacePath);
    return remote ? { canonical: remote, legacy: remote } : null;
  },
}));

vi.mock('../teamProjectResolver', () => ({ resolveTeamForRemoteHash: vi.fn() }));

vi.mock('../../window/WindowManager', () => ({
  createWindow: vi.fn(),
  windows: new Map(),
  windowStates: new Map(),
}));

vi.mock('../../window/windowState', () => ({
  windowReferencesWorkspace: vi.fn(() => false),
}));

vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));

vi.mock('../jwtOrg', () => ({
  assertJwtMatchesOrg: vi.fn(),
  getJwtExp: vi.fn(() => Math.floor(Date.now() / 1000) + 300),
  AuthContextMismatchError: class AuthContextMismatchError extends Error {},
}));

vi.mock('../StytchAuthService', () => ({
  getAccounts: accountsMock,
  getPersonalSessionJwt: vi.fn(() => 'personal-jwt'),
  getPersonalSessionJwtForAccount: vi.fn(() => 'personal-jwt'),
  getSessionToken: vi.fn(() => 'session-token'),
  getSessionTokenForAccount: vi.fn(() => 'session-token'),
  isAuthenticated: authenticatedMock,
  refreshSession: vi.fn(async () => false),
  refreshSessionForAccount: vi.fn(async () => null),
  refreshPersonalSessionForAccount: vi.fn(async () => null),
  onAuthStateChange: vi.fn(() => () => {}),
  updateSessionToken: vi.fn(),
  updateSessionTokenForAccount: vi.fn(),
  getStytchUserId: vi.fn(() => 'user-1'),
  getUserEmail: vi.fn(() => 'invitee@test.com'),
  getPersonalOrgId: vi.fn(() => 'personal-1'),
  getPersonalUserId: vi.fn(() => 'user-1'),
}));

vi.mock('@nimbalyst/runtime', () => ({
  asPersonalJwt: (jwt: string) => jwt,
  asPersonalMemberId: (id: string) => id,
  asTeamJwt: (jwt: string) => jwt,
  asTeamMemberId: (id: string) => id,
}));

vi.mock('../../menu/organizationMenuState', () => ({ setHasOrganizationsForMenu: vi.fn() }));

vi.mock('../../database/initialize', () => ({}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import { invalidateListTeamsCache, resolveInviteDeepLink } from '../TeamService';

/**
 * Number of org session exchanges. This is the call that actually joins a team
 * (Stytch promotes pending -> active_member on exchange), so it is the thing a
 * refused invitation must never trigger.
 */
function sessionExchangeCallCount(): number {
  return fetchMock.mock.calls.filter((call: unknown[]) =>
    String(call[0]).endsWith('/switch')).length;
}

function respondWithTeams(teams: Array<Record<string, unknown>>): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/teams') && !url.includes('/api/teams/')) {
      return { ok: true, status: 200, json: async () => ({ teams }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

const PENDING_TEAM = {
  orgId: 'org-acme',
  name: 'Acme',
  gitRemoteHash: null,
  createdAt: new Date(0).toISOString(),
  role: 'member',
  membershipType: 'invited_member',
  sourcePersonalOrgId: 'personal-1',
  sourceEmail: 'invitee@test.com',
};

describe('resolveInviteDeepLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    authenticatedMock.mockReturnValue(true);
    accountsMock.mockReturnValue([{
      personalOrgId: 'personal-1',
      email: 'invitee@test.com',
      sessionStatus: 'active',
    }]);
    invalidateListTeamsCache();
  });

  it('refuses to accept an invitation addressed to an email no signed-in account owns', async () => {
    respondWithTeams([PENDING_TEAM]);

    const outcome = await resolveInviteDeepLink('org-acme', 'someone-else@test.com');

    expect(outcome).toEqual({
      status: 'sign-in-required',
      orgId: 'org-acme',
      email: 'someone-else@test.com',
    });
    // The guard has to short-circuit before any join: joining under the
    // signed-in account would put the wrong identity in the team.
    expect(sessionExchangeCallCount()).toBe(0);
  });

  it('reports sign-in-required rather than throwing when no account is signed in', async () => {
    authenticatedMock.mockReturnValue(false);
    respondWithTeams([PENDING_TEAM]);

    const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com');

    expect(outcome).toEqual({
      status: 'sign-in-required',
      orgId: 'org-acme',
      email: 'invitee@test.com',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a membership the console already activated as already-member, not a fresh join', async () => {
    respondWithTeams([{ ...PENDING_TEAM, membershipType: 'active_member' }]);

    const outcome = await resolveInviteDeepLink('org-acme', 'INVITEE@Test.com');

    expect(outcome).toEqual({ status: 'already-member', orgId: 'org-acme', teamName: 'Acme' });
    expect(sessionExchangeCallCount()).toBe(0);
  });

  it('reports not-found when the invitation is no longer in the account directory', async () => {
    respondWithTeams([]);

    const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com');

    expect(outcome).toEqual({
      status: 'not-found',
      orgId: 'org-acme',
      email: 'invitee@test.com',
    });
  });
});
