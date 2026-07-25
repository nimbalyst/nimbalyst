import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionSyncConfig: vi.fn(),
  getCollabSyncHttpUrl: vi.fn(() => 'https://sync.nimbalyst.com'),
  getCollabSyncWsUrl: vi.fn(() => 'wss://sync.nimbalyst.com'),
  getPersonalSessionJwt: vi.fn(),
  refreshPersonalSession: vi.fn(),
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
  refreshPersonalSession: mocks.refreshPersonalSession,
}));

import { listPersonalSyncDevices } from '../PersonalSyncDevicesService';

describe('listPersonalSyncDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCollabSyncHttpUrl.mockReturnValue('https://sync.nimbalyst.com');
    mocks.getCollabSyncWsUrl.mockReturnValue('wss://sync.nimbalyst.com');
    mocks.refreshPersonalSession.mockResolvedValue(true);
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
    expect(mocks.refreshPersonalSession).not.toHaveBeenCalled();
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
    expect(mocks.refreshPersonalSession).toHaveBeenCalledWith('wss://sync.nimbalyst.com');
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://sync.nimbalyst.com/api/sessions', expect.objectContaining({
      headers: { Authorization: 'Bearer fresh-personal-jwt' },
    }));
  });

  it('does not contact the sync server when personal sync is disabled', async () => {
    mocks.getSessionSyncConfig.mockReturnValue({ enabled: false });

    await expect(listPersonalSyncDevices()).resolves.toEqual({ success: false, devices: [], error: 'Sync not configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
