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

const { fetchMock, safeHandleMock, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
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

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: safeHandleMock }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../../utils/gitUtils', () => ({ getNormalizedGitRemote: vi.fn() }));

vi.mock('../teamProjectResolver', () => ({ resolveTeamForRemoteHash: vi.fn() }));

vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));

vi.mock('../jwtOrg', () => ({
  assertJwtMatchesOrg: vi.fn(),
  getJwtExp: vi.fn(() => Math.floor(Date.now() / 1000) + 300),
  AuthContextMismatchError: class AuthContextMismatchError extends Error {},
}));

vi.mock('../StytchAuthService', () => ({
  getAccounts: vi.fn(() => [{ personalOrgId: 'personal-1', email: 'user@test.com' }]),
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
  getStytchUserId: vi.fn(() => 'user-1'),
  getUserEmail: vi.fn(() => 'user@test.com'),
  getPersonalOrgId: vi.fn(() => 'personal-1'),
  getPersonalUserId: vi.fn(() => 'user-1'),
}));

vi.mock('@nimbalyst/runtime', () => ({
  asPersonalJwt: (jwt: string) => jwt,
  asTeamJwt: (jwt: string) => jwt,
}));

vi.mock('../../database/initialize', () => ({}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
// createTeamAuthBootstrap is invoked at TeamService module scope (assigned to
// runAuthenticatedTeamBootstrap), so the mock must return a callable factory.
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import { registerTeamHandlers } from '../TeamService';
import { registerTeamCustodyHandlers } from '../TeamCustodyService';

const EXPECTED_TEAM_CHANNELS = [
  'team:accept-invite',
  'team:add-project',
  'team:clear-project-identity',
  'team:create',
  'team:delete',
  'team:find-for-workspace',
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
  'team:set-project-identity',
  'team:update-role',
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

    const unregistered = [...invoked].filter((channel) => !handlers.has(channel)).sort();
    expect(unregistered).toEqual([]);
  });
});
