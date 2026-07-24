import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warn, getFilesBySession } = vi.hoisted(() => ({
  warn: vi.fn(),
  getFilesBySession: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@nimbalyst/runtime', () => ({
  SessionFilesRepository: {
    getFilesBySession,
  },
}));

import { sessionEditQuota, MAX_EDITED_FILES_PER_SESSION } from '../SessionEditQuota';

describe('SessionEditQuota', () => {
  beforeEach(() => {
    sessionEditQuota.resetForTesting();
    warn.mockReset();
    getFilesBySession.mockReset();
    getFilesBySession.mockResolvedValue([]);
  });

  it('allows distinct files up to the cap, blocks new files past it, but always allows already-counted files and logs once', async () => {
    const sessionId = 'session-1';

    // First MAX files all reserve successfully.
    for (let i = 0; i < MAX_EDITED_FILES_PER_SESSION; i++) {
      const ok = await sessionEditQuota.tryReserve(sessionId, `/ws/file-${i}.ts`);
      expect(ok).toBe(true);
    }

    // 501st distinct file is rejected.
    const overflow1 = await sessionEditQuota.tryReserve(sessionId, '/ws/overflow-1.ts');
    expect(overflow1).toBe(false);

    // Re-touching a file already counted in the cap is always allowed.
    const repeat = await sessionEditQuota.tryReserve(sessionId, '/ws/file-0.ts');
    expect(repeat).toBe(true);

    // Subsequent overflow attempts also rejected.
    const overflow2 = await sessionEditQuota.tryReserve(sessionId, '/ws/overflow-2.ts');
    expect(overflow2).toBe(false);

    // Cap-reached warning fires once per session per app run.
    const warnCalls = warn.mock.calls.filter((call) =>
      String(call[0]).includes('Edit cap reached'),
    );
    expect(warnCalls).toHaveLength(1);
  });

  it('hydrates from SessionFilesRepository so the cap survives restart', async () => {
    const seeded = Array.from({ length: MAX_EDITED_FILES_PER_SESSION }, (_, i) => ({
      filePath: `/ws/seeded-${i}.ts`,
    }));
    getFilesBySession.mockResolvedValueOnce(seeded);

    const ok = await sessionEditQuota.tryReserve('session-restart', '/ws/new-after-restart.ts');
    expect(ok).toBe(false);
    expect(getFilesBySession).toHaveBeenCalledWith('session-restart', 'edited');
  });
});
