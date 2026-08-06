import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guard against over-wide handler deletion (the legacy-E2E encryption removal
 * accidentally deleted 14 unrelated team:* registrations along with the
 * intended encryption handlers). This test pins the exact channel list that
 * registerTeamHandlers registers, and cross-checks every team:* channel the
 * preload invokes against a main-process registration, so a silent over-delete
 * fails loudly here instead of at runtime.
 */

const { accountsMock, fetchMock, safeHandleMock, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    accountsMock: vi.fn(() => [{
      personalOrgId: 'personal-1',
      email: 'user@test.com',
      sessionStatus: 'active',
    }]),
    fetchMock: vi.fn(),
    handlers,
    safeHandleMock: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: safeHandleMock, safeOn: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../utils/gitUtils', () => ({ getNormalizedGitRemote: vi.fn() }));

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
  isAuthenticated: vi.fn(() => true),
  refreshSession: vi.fn(async () => false),
  refreshSessionForAccount: vi.fn(async () => null),
  refreshPersonalSessionForAccount: vi.fn(async () => null),
  onAuthStateChange: vi.fn(() => () => {}),
  updateSessionToken: vi.fn(),
  updateSessionTokenForAccount: vi.fn(),
  getStytchUserId: vi.fn(() => 'user-1'),
  getUserEmail: vi.fn(() => 'user@test.com'),
  getPersonalOrgId: vi.fn(() => 'personal-1'),
  getPersonalUserId: vi.fn(() => 'user-1'),
}));

vi.mock('@nimbalyst/runtime', () => ({
  asPersonalJwt: (jwt: string) => jwt,
  asTeamJwt: (jwt: string) => jwt,
}));

vi.mock('../../menu/organizationMenuState', () => ({ setHasOrganizationsForMenu: vi.fn() }));

vi.mock('../../database/initialize', () => ({}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
// createTeamAuthBootstrap is invoked at TeamService module scope (assigned to
// runAuthenticatedTeamBootstrap), so the mock must return a callable factory.
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import {
  invalidateListTeamsCache,
  pendingInviteForEmail,
  registerTeamHandlers,
} from '../TeamService';
import type { TeamDetails } from '../TeamService';
import { registerTeamCustodyHandlers } from '../TeamCustodyService';

const EXPECTED_TEAM_CHANNELS = [
  'team:accept-invite',
  'team:add-project',
  'team:clear-project-identity',
  'team:create',
  'team:delete',
  'team:find-for-workspace',
  'team:find-pending-invite-for-email',
  'team:get',
  'team:get-git-remote',
  'team:invite',
  'team:list',
  'team:list-members',
  'team:list-projects',
  'team:merge-org',
  'team:move-project',
  'team:move-project-preview',
  'team:remove-member',
  'team:rename',
  'team:resolve-org-projects-local-state',
  'team:set-project-identity',
  'team:update-role',
];

const TEAM_CHANNELS_REGISTERED_OUTSIDE_TEAM_SERVICE = [
  'team:open-project-workspace',
];

const EXPECTED_ORG_CHANNELS = [
  'org:apply-member-removed',
  'org:apply-member-role-changed',
  'org:apply-member-upserted',
  'org:apply-project-access',
  'org:can-access',
  'org:grant-project-access',
  'org:list-project-access',
  'org:revoke-project-access',
  'org:sync-projection',
];

describe('registerTeamHandlers channel registration', () => {
  beforeEach(() => {
    handlers.clear();
    safeHandleMock.mockClear();
    registerTeamHandlers();
  });

  it('registers exactly the expected team:* and org:* channels', () => {
    const registered = [...handlers.keys()].sort();
    expect(registered).toEqual([...EXPECTED_ORG_CHANNELS, ...EXPECTED_TEAM_CHANNELS].sort());
  });

  it('covers every team:* channel the preload invokes', async () => {
    registerTeamCustodyHandlers(); // owns team:get-key-custody-status

    const preloadSource = await readFile(
      resolve(__dirname, '../../../preload/index.ts'),
      'utf-8',
    );
    const invoked = new Set(
      [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*'(team:[^']+)'/g)].map((m) => m[1]),
    );
    expect(invoked.size).toBeGreaterThan(0);

    const externallyRegistered = new Set(TEAM_CHANNELS_REGISTERED_OUTSIDE_TEAM_SERVICE);
    const unregistered = [...invoked]
      .filter((channel) => !handlers.has(channel) && !externallyRegistered.has(channel))
      .sort();
    expect(unregistered).toEqual([]);
  });

  it('matches only a pending invitation owned by the signed-in email', () => {
    const teams = [
      {
        orgId: 'org-active',
        name: 'Already joined',
        membershipType: 'active_member',
        sourceEmail: 'member@example.com',
      },
      {
        orgId: 'org-other',
        name: 'Other account',
        membershipType: 'pending_member',
        sourceEmail: 'other@example.com',
      },
      {
        orgId: 'org-invite',
        name: 'Acme Robotics',
        membershipType: 'pending_member',
        sourceEmail: 'MEMBER@example.com',
      },
    ] as TeamDetails[];

    expect(pendingInviteForEmail(teams, 'member@example.com')?.orgId).toBe('org-invite');
    expect(pendingInviteForEmail(teams, 'missing@example.com')).toBeNull();
  });
});

/**
 * Org creation was blocked in every non-development build while Teams was being
 * finished (NIM-2306). That gate is gone; a packaged build must reach the API
 * instead of short-circuiting with "not available yet".
 */
describe('team:create handler', () => {
  beforeEach(() => {
    handlers.clear();
    safeHandleMock.mockClear();
    fetchMock.mockReset();
    registerTeamHandlers();
  });

  it('calls the teams API from a packaged build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ orgId: 'org-new', name: 'Acme', creatorMemberId: 'member-1' }),
    });

    const handler = handlers.get('team:create');
    if (!handler) throw new Error('team:create is not registered');
    const result = await handler({}, 'Acme');

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/teams');
    expect(result.error ?? '').not.toContain('not available yet');

    vi.unstubAllEnvs();
  });
});

/**
 * The wizard's invitation branch is only as good as the channel behind it, and
 * the matcher above is one of four things the handler does: it also validates
 * the argument, refuses an email the signed-in accounts do not own, and turns a
 * directory failure into a result rather than an unhandled rejection.
 */
describe('team:find-pending-invite-for-email handler', () => {
  const invite = (email: string) => ({
    orgId: 'org-invite',
    name: 'Acme Robotics',
    membershipType: 'pending_member',
    sourceEmail: email,
  });

  function respondWithTeams(teams: unknown[]) {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ teams }),
    });
  }

  async function invokeHandler(email: unknown) {
    const handler = handlers.get('team:find-pending-invite-for-email');
    if (!handler) throw new Error('team:find-pending-invite-for-email is not registered');
    return handler({}, email);
  }

  beforeEach(() => {
    handlers.clear();
    safeHandleMock.mockClear();
    fetchMock.mockReset();
    accountsMock.mockReturnValue([{
      personalOrgId: 'personal-1',
      email: 'member@example.com',
      sessionStatus: 'active',
    }]);
    invalidateListTeamsCache();
    registerTeamHandlers();
  });

  it('rejects an email that is not a usable string', async () => {
    respondWithTeams([invite('member@example.com')]);

    await expect(invokeHandler(undefined)).resolves.toMatchObject({ success: false });
    await expect(invokeHandler('   ')).resolves.toMatchObject({ success: false });
    await expect(invokeHandler(42)).resolves.toMatchObject({ success: false });
    // Nothing was looked up, so nothing could have leaked.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The email comes from the renderer. Answering for an address the signed-in
   * accounts do not own would report another person's pending invitation to
   * whoever typed their address.
   */
  it('reports no invitation for an email no signed-in account owns', async () => {
    respondWithTeams([invite('someone-else@example.com')]);

    await expect(invokeHandler('someone-else@example.com'))
      .resolves.toEqual({ success: true, invitation: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the pending invitation for an owned email', async () => {
    respondWithTeams([
      { orgId: 'org-joined', name: 'Already joined', membershipType: 'active_member', sourceEmail: 'member@example.com' },
      invite('MEMBER@example.com'),
    ]);

    const result = await invokeHandler('member@example.com');

    expect(result.success).toBe(true);
    expect(result.invitation).toMatchObject({ orgId: 'org-invite', name: 'Acme Robotics' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('reports no invitation when the owned email has none pending', async () => {
    respondWithTeams([
      { orgId: 'org-joined', name: 'Already joined', membershipType: 'active_member', sourceEmail: 'member@example.com' },
    ]);

    await expect(invokeHandler('member@example.com'))
      .resolves.toEqual({ success: true, invitation: null });
  });

  // Invitation discovery is optional to the wizard; a directory outage must not
  // reach the renderer as a rejected invoke.
  it('answers with no invitation when the directory lookup fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(invokeHandler('member@example.com'))
      .resolves.toEqual({ success: true, invitation: null });
  });
});
