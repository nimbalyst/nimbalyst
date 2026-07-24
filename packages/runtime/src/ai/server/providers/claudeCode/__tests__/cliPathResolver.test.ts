import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolvePathMock, describeMissingMock } = vi.hoisted(() => ({
  resolvePathMock: vi.fn<() => string | undefined>(),
  describeMissingMock: vi.fn<() => string>(),
}));

vi.mock('../../../../../electron/claudeCodeEnvironment', () => ({
  resolveClaudeCodeExecutablePath: resolvePathMock,
  describeMissingClaudeRuntime: describeMissingMock,
}));

import { resolveClaudeAgentCliPath } from '../cliPathResolver';

describe('resolveClaudeAgentCliPath (NIM-1573)', () => {
  beforeEach(() => {
    resolvePathMock.mockReset();
    describeMissingMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the bundled binary path when present', async () => {
    resolvePathMock.mockReturnValue('/unpacked/claude');
    await expect(resolveClaudeAgentCliPath()).resolves.toBe('/unpacked/claude');
  });

  it('throws the honest "repair Nimbalyst" message, not the misleading SDK/libc error, when no binary exists', async () => {
    resolvePathMock.mockReturnValue(undefined);
    describeMissingMock.mockReturnValue(
      "Nimbalyst's bundled Claude runtime is missing -- reinstall or repair Nimbalyst."
    );

    await expect(resolveClaudeAgentCliPath()).rejects.toThrow(/repair Nimbalyst/i);
    // Must not surface the old generic wording that led users nowhere.
    await expect(resolveClaudeAgentCliPath()).rejects.not.toThrow(/packaged-safe/i);
  });
});
