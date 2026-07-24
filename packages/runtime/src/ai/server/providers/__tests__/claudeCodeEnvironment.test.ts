import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApp = {
  isPackaged: false,
  getAppPath: vi.fn(() => '/repo/packages/electron'),
};

vi.mock('electron', () => ({
  app: mockApp,
}));

describe('claudeCodeEnvironment', () => {
  const originalNodePath = process.env.NODE_PATH;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockApp.isPackaged = false;
    mockApp.getAppPath.mockReturnValue('/repo/packages/electron');
    process.env.NODE_PATH = '/custom/modules';
  });

  afterEach(() => {
    if (originalNodePath === undefined) {
      delete process.env.NODE_PATH;
    } else {
      process.env.NODE_PATH = originalNodePath;
    }
  });

  it('adds hoisted workspace node_modules paths in development mode', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return [
        '/custom/modules',
        '/repo/node_modules',
        '/repo/packages/runtime/node_modules',
      ].includes(String(candidate));
    });

    const { setupClaudeCodeEnvironment } = await import('../../../../electron/claudeCodeEnvironment');
    const env = setupClaudeCodeEnvironment();
    const nodePaths = env.NODE_PATH?.split(path.delimiter) ?? [];

    expect(nodePaths).toEqual([
      '/custom/modules',
      '/repo/node_modules',
      '/repo/packages/runtime/node_modules',
    ]);
  });

  it('uses unpacked node_modules in packaged mode', async () => {
    mockApp.isPackaged = true;
    mockApp.getAppPath.mockReturnValue('/Applications/Nimbalyst.app/Contents/Resources/app.asar');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => (
      String(candidate) === '/Applications/Nimbalyst.app/Contents/Resources/app.asar.unpacked/node_modules'
    ));

    const { setupClaudeCodeEnvironment } = await import('../../../../electron/claudeCodeEnvironment');
    const env = setupClaudeCodeEnvironment();

    expect(env.NODE_PATH).toBe('/Applications/Nimbalyst.app/Contents/Resources/app.asar.unpacked/node_modules');
  });
});
