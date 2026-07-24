import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, fsFiles, generateDocumentKeyMock, writeCounts } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  generateDocumentKeyMock: vi.fn(),
  // In-memory backing store for OrgKeyService's encrypted-file persistence so
  // tests can seed a locally cached org key (legacy-e2e evidence) without disk.
  fsFiles: new Map<string, string>(),
  writeCounts: new Map<string, number>(),
}));

vi.mock('fs', () => ({
  existsSync: (p: string) => fsFiles.has(p),
  readFileSync: (p: string) => {
    const v = fsFiles.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return Buffer.from(v, 'utf8');
  },
  writeFileSync: (p: string, data: string | Buffer) => {
    writeCounts.set(p, (writeCounts.get(p) ?? 0) + 1);
    fsFiles.set(p, typeof data === 'string' ? data : data.toString('utf8'));
  },
}));

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  app: { getPath: vi.fn(() => '/mock/user-data') },
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
}));

vi.mock('../../utils/collabSyncUrl', () => ({
  getCollabSyncHttpUrl: () => 'https://sync.test',
}));

vi.mock('../StytchAuthService', () => ({
  getSessionJwt: vi.fn(() => 'session-jwt'),
  isAuthenticated: vi.fn(() => true),
}));

vi.mock('../TeamService', () => ({
  getOrgScopedJwt: vi.fn(async () => 'org-jwt'),
}));

vi.mock('@nimbalyst/runtime/sync', () => ({
  ECDHKeyManager: class {
    static generateDocumentKey = generateDocumentKeyMock;
    deserializeKeyPair = vi.fn();
    serializeKeyPair = vi.fn();
    generateKeyPair = vi.fn();
  },
}));

// Seed a locally cached org key for `org-legacy-e2e` (legacy-e2e evidence).
// OrgKeyService loads this once, lazily, on first `hasOrgKey`; seed it before
// any test runs so the load sees it. Value is the legacy plain-base64 form.
fsFiles.set(
  '/mock/user-data/org-encryption-keys.enc',
  JSON.stringify([['org-legacy-e2e', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=']])
);

import { clearLastKnownTeamKeyStatus, fetchTeamKeyStatus, generateAndStoreOrgKey, getLastKnownTeamKeyStatus, hasOrgKey, invalidateTeamKeyStatusCache, setTeamKeyCustodyMode } from '../OrgKeyService';

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function keyStatusCallCount(): number {
  return fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/key-status')).length;
}

describe('OrgKeyService org-key persistence', () => {
  it('does not rewrite safe storage when the org key bytes are unchanged', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    generateDocumentKeyMock.mockResolvedValue(key);
    hasOrgKey('org-legacy-e2e');
    writeCounts.clear();

    await generateAndStoreOrgKey('org-idempotent-write');
    await generateAndStoreOrgKey('org-idempotent-write');

    expect(writeCounts.get('/mock/user-data/org-encryption-keys.enc')).toBe(1);
  });
});

describe('OrgKeyService key-status cache (RC2)', () => {
  beforeEach(() => {
    invalidateTeamKeyStatusCache();
    clearLastKnownTeamKeyStatus();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/key-status')) {
        return jsonResponse({ mode: 'legacy-e2e', dekEpoch: null, dekFingerprint: null });
      }
      if (url.includes('/set-key-custody-mode')) {
        return jsonResponse({ success: true });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    invalidateTeamKeyStatusCache();
  });

  it('collapses N concurrent fetchTeamKeyStatus calls for the same org into one GET', async () => {
    const results = await Promise.all([
      fetchTeamKeyStatus('org-1', 'jwt'),
      fetchTeamKeyStatus('org-1', 'jwt'),
      fetchTeamKeyStatus('org-1', 'jwt'),
      fetchTeamKeyStatus('org-1', 'jwt'),
      fetchTeamKeyStatus('org-1', 'jwt'),
    ]);

    expect(keyStatusCallCount()).toBe(1);
    for (const result of results) {
      expect(result).toEqual({ mode: 'legacy-e2e', dekEpoch: null, dekFingerprint: null });
    }
  });

  it('reuses the cached status for a second call to the same org shortly after', async () => {
    await fetchTeamKeyStatus('org-1', 'jwt');
    await fetchTeamKeyStatus('org-1', 'jwt');

    expect(keyStatusCallCount()).toBe(1);
  });

  it('fetches independently per org', async () => {
    await fetchTeamKeyStatus('org-1', 'jwt');
    await fetchTeamKeyStatus('org-2', 'jwt');

    expect(keyStatusCallCount()).toBe(2);
  });

  it('setTeamKeyCustodyMode invalidates the cache for that org so the next call refetches', async () => {
    await fetchTeamKeyStatus('org-1', 'jwt');
    expect(keyStatusCallCount()).toBe(1);

    await setTeamKeyCustodyMode('org-1', 'server-managed', 'jwt');

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/key-status')) {
        return jsonResponse({ mode: 'server-managed', dekEpoch: 1, dekFingerprint: 'fp' });
      }
      return jsonResponse({});
    });

    const status = await fetchTeamKeyStatus('org-1', 'jwt');
    expect(keyStatusCallCount()).toBe(2);
    expect(status.mode).toBe('server-managed');
  });
});

describe('OrgKeyService key-status offline fallback (NIM-1778)', () => {
  beforeEach(() => {
    invalidateTeamKeyStatusCache();
    clearLastKnownTeamKeyStatus();
    fetchMock.mockReset();
  });

  afterEach(() => {
    invalidateTeamKeyStatusCache();
    clearLastKnownTeamKeyStatus();
  });

  function mockKeyStatusResponse(body: unknown) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/key-status')) return jsonResponse(body);
      return jsonResponse({});
    });
  }

  function mockNetworkDown() {
    fetchMock.mockImplementation(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
  }

  it('falls back to the last-known mode when the fetch fails, not legacy-e2e', async () => {
    mockKeyStatusResponse({ mode: 'server-managed', dekEpoch: 2, dekFingerprint: 'fp2' });
    await fetchTeamKeyStatus('org-sm', 'jwt');

    invalidateTeamKeyStatusCache('org-sm');
    mockNetworkDown();

    const status = await fetchTeamKeyStatus('org-sm', 'jwt');
    expect(status).toEqual({ mode: 'server-managed', dekEpoch: 2, dekFingerprint: 'fp2' });
  });

  // NIM-1779/C1: with no last-known status AND no local legacy evidence, an
  // unresolved status must NOT drop a server-managed team into the legacy
  // AES-decrypt lane (which renders docs locked + throws in the outbox drain).
  // The safe default is server-managed; SilentTeamEncryptionMigration converges
  // any surviving legacy team anyway.
  it('defaults to server-managed (not legacy-e2e) on fetch failure with no last-known status and no local org key', async () => {
    mockNetworkDown();

    const status = await fetchTeamKeyStatus('org-unknown', 'jwt');
    expect(status.mode).not.toBe('legacy-e2e');
    expect(status).toEqual({ mode: 'server-managed', dekEpoch: null, dekFingerprint: null });
  });

  // A locally cached org key is evidence this org was joined as legacy-e2e
  // (server-managed teams never store an org key locally). Honor that signal so
  // a legacy team on a fresh offline launch is not misrouted the other way.
  it('defaults to legacy-e2e on fetch failure when a local org key exists (legacy evidence)', async () => {
    mockNetworkDown();

    const status = await fetchTeamKeyStatus('org-legacy-e2e', 'jwt');
    expect(status).toEqual({ mode: 'legacy-e2e', dekEpoch: null, dekFingerprint: null });
  });

  // The lane both callsites (DocumentSyncHandlers doc-decrypt / CollabOutbox-
  // DrainerService) branch on is exactly `(await fetchTeamKeyStatus()).mode ===
  // 'server-managed'`. Prove the unresolved-status default flips that branch to
  // the server lane.
  it('routes an unresolved server-managed team onto the server lane', async () => {
    mockNetworkDown();

    const serverManaged = (await fetchTeamKeyStatus('org-unknown', 'jwt')).mode === 'server-managed';
    expect(serverManaged).toBe(true);
  });

  it('does not pin the fallback: the next call refetches once the network returns', async () => {
    mockKeyStatusResponse({ mode: 'server-managed', dekEpoch: 1, dekFingerprint: 'fp1' });
    await fetchTeamKeyStatus('org-recover', 'jwt');

    invalidateTeamKeyStatusCache('org-recover');
    mockNetworkDown();
    await fetchTeamKeyStatus('org-recover', 'jwt');

    mockKeyStatusResponse({ mode: 'server-managed', dekEpoch: 3, dekFingerprint: 'fp3' });
    const status = await fetchTeamKeyStatus('org-recover', 'jwt');
    expect(status).toEqual({ mode: 'server-managed', dekEpoch: 3, dekFingerprint: 'fp3' });
  });

  it('exposes the last-known status to callsites whose JWT mint fails before the fetch', async () => {
    expect(getLastKnownTeamKeyStatus('org-jwtless')).toBeNull();

    mockKeyStatusResponse({ mode: 'server-managed', dekEpoch: 5, dekFingerprint: 'fp5' });
    await fetchTeamKeyStatus('org-jwtless', 'jwt');

    expect(getLastKnownTeamKeyStatus('org-jwtless')).toEqual({ mode: 'server-managed', dekEpoch: 5, dekFingerprint: 'fp5' });

    clearLastKnownTeamKeyStatus('org-jwtless');
    expect(getLastKnownTeamKeyStatus('org-jwtless')).toBeNull();
  });
});
