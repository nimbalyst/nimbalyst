import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionSyncConfig: vi.fn(),
  getCollabSyncHttpUrl: vi.fn(() => 'https://sync.nimbalyst.com'),
  getCollabSyncWsUrl: vi.fn(() => 'wss://sync.nimbalyst.com'),
  getPersonalSessionJwt: vi.fn(),
  refreshPersonalSessionDetailed: vi.fn(),
}));

vi.mock('../../utils/store', () => ({
  getSessionSyncConfig: mocks.getSessionSyncConfig,
}));

vi.mock('../../utils/collabSyncUrl', () => ({
  getCollabSyncHttpUrl: mocks.getCollabSyncHttpUrl,
  getCollabSyncWsUrl: mocks.getCollabSyncWsUrl,
}));

vi.mock('../StytchAuthService', () => ({
  getPersonalSessionJwt: mocks.getPersonalSessionJwt,
  refreshPersonalSessionDetailed: mocks.refreshPersonalSessionDetailed,
}));

import { listPersonalSyncDevices } from '../PersonalSyncDevicesService';

describe('listPersonalSyncDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCollabSyncHttpUrl.mockReturnValue('https://sync.nimbalyst.com');
    mocks.getCollabSyncWsUrl.mockReturnValue('wss://sync.nimbalyst.com');
    mocks.refreshPersonalSessionDetailed.mockResolvedValue({ ok: true });
    mocks.getPersonalSessionJwt.mockReturnValue('personal-jwt');
    vi.stubGlobal('fetch', vi.fn());
  });

  it('lists devices with the derived sync URL and personal JWT when the stored config omits serverUrl', async () => {
    mocks.getSessionSyncConfig.mockReturnValue({ enabled: true, enabledProjects: ['/project'] });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ devices: [{ deviceId: 'phone-1', name: 'Phone' }], session_count: 2, project_count: 1 }),
    } as Response);

    await expect(listPersonalSyncDevices()).resolves.toEqual({
      success: true,
      devices: [{ deviceId: 'phone-1', name: 'Phone' }],
      sessionCount: 2,
      projectCount: 1,
    });
    expect(mocks.refreshPersonalSessionDetailed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('https://sync.nimbalyst.com/api/sessions', expect.objectContaining({
      headers: { Authorization: 'Bearer personal-jwt' },
    }));
  });

  it('refreshes the personal JWT and retries once after an unauthorized response', async () => {
    mocks.getSessionSyncConfig.mockReturnValue({ enabled: true });
    mocks.getPersonalSessionJwt
      .mockReturnValueOnce('expired-personal-jwt')
      .mockReturnValue('fresh-personal-jwt');
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ devices: [] }),
      } as Response);

    await expect(listPersonalSyncDevices()).resolves.toMatchObject({ success: true, devices: [] });
    expect(mocks.refreshPersonalSessionDetailed).toHaveBeenCalledWith('wss://sync.nimbalyst.com');
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://sync.nimbalyst.com/api/sessions', expect.objectContaining({
      headers: { Authorization: 'Bearer fresh-personal-jwt' },
    }));
  });

  /**
   * A transport failure must not be reported to the user as an auth problem.
   * "Not authenticated" told the user to sign in again when the truth was that
   * the sync server could not be reached and their session was fine.
   */
  it('reports an unreachable sync server as unreachable, not as "Not authenticated"', async () => {
    mocks.getSessionSyncConfig.mockReturnValue({ enabled: true });
    mocks.getPersonalSessionJwt.mockReturnValue(null);
    mocks.refreshPersonalSessionDetailed.mockResolvedValue({
      ok: false,
      reason: 'network',
      detail: 'ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:8790)',
    });

    const result = await listPersonalSyncDevices();
    expect(result).toMatchObject({ success: false, devices: [] });
    expect((result as { error: string }).error).toContain('unreachable');
    expect((result as { error: string }).error).toContain('ECONNREFUSED');
    expect((result as { error: string }).error).not.toContain('Not authenticated');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still reports a server-confirmed rejection as not authenticated', async () => {
    mocks.getSessionSyncConfig.mockReturnValue({ enabled: true });
    mocks.getPersonalSessionJwt.mockReturnValue(null);
    mocks.refreshPersonalSessionDetailed.mockResolvedValue({ ok: false, reason: 'auth' });

    await expect(listPersonalSyncDevices()).resolves.toEqual({
      success: false,
      devices: [],
      error: 'Not authenticated',
    });
  });

  it('does not contact the sync server when personal sync is disabled', async () => {
    mocks.getSessionSyncConfig.mockReturnValue({ enabled: false });

    await expect(listPersonalSyncDevices()).resolves.toEqual({ success: false, devices: [], error: 'Sync not configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
