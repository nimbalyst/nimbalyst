// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getHostEnvironment,
  setHostEnvironment,
  nodeHostEnvironment,
  type HostEnvironment,
} from '../hostEnvironment';

// Deliberately no vi.resetModules() here. The host is a module singleton, so
// resetting the registry between tests would hand the dynamically-imported
// consumer below a *second* copy of it -- one this file's static import never
// wrote to -- and the injected host would silently not apply.
afterEach(() => {
  setHostEnvironment(null);
});

describe('HostEnvironment', () => {
  it('defaults to a never-packaged Node host so a host-less process still resolves paths', () => {
    expect(getHostEnvironment()).toBe(nodeHostEnvironment);
    expect(getHostEnvironment().isPackaged()).toBe(false);
    expect(getHostEnvironment().getAppPath()).toBe(process.cwd());
  });

  it('reads the injected host on every call rather than capturing it', () => {
    let packaged = false;
    const host: HostEnvironment = {
      isPackaged: () => packaged,
      getAppPath: () => '/Applications/Nimbalyst.app/Contents/Resources/app.asar',
    };
    setHostEnvironment(host);

    expect(getHostEnvironment().isPackaged()).toBe(false);
    packaged = true;
    expect(getHostEnvironment().isPackaged()).toBe(true);
  });

  it('restores the Node default when cleared', () => {
    setHostEnvironment({ isPackaged: () => true, getAppPath: () => '/somewhere' });
    setHostEnvironment(null);
    expect(getHostEnvironment()).toBe(nodeHostEnvironment);
  });

  // An Electron main process on the Node default would report "not packaged"
  // and take the dev branch of every path lookup, surfacing much later as a
  // misleading SDK error. Refusing to guess is the whole point of tracking
  // "unregistered" separately from "registered the Node host".
  it('throws rather than guessing when an Electron main process never registered', () => {
    const host = process as NodeJS.Process & { type?: string };
    const originalType = host.type;
    const originalElectron = process.versions.electron;
    Object.defineProperty(process.versions, 'electron', { value: '43.0.0', configurable: true });
    host.type = 'browser';

    try {
      expect(() => getHostEnvironment()).toThrow(/never registered/);
    } finally {
      host.type = originalType;
      Object.defineProperty(process.versions, 'electron', {
        value: originalElectron,
        configurable: true,
      });
    }
  });

  it('still defaults for the renderer and for ELECTRON_RUN_AS_NODE, which never register', () => {
    const host = process as NodeJS.Process & { type?: string };
    const originalType = host.type;
    const originalElectron = process.versions.electron;
    Object.defineProperty(process.versions, 'electron', { value: '43.0.0', configurable: true });

    try {
      host.type = 'renderer';
      expect(getHostEnvironment()).toBe(nodeHostEnvironment);
      host.type = undefined; // ELECTRON_RUN_AS_NODE
      expect(getHostEnvironment()).toBe(nodeHostEnvironment);
    } finally {
      host.type = originalType;
      Object.defineProperty(process.versions, 'electron', {
        value: originalElectron,
        configurable: true,
      });
    }
  });
});

describe('claudeCodeEnvironment against an injected host', () => {
  it('takes the packaged branch and derives the unpacked sibling from the injected app path', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'nimbalyst-host-environment-'));
    try {
      setHostEnvironment({
        isPackaged: () => true,
        getAppPath: () => path.join(fixture, 'app.asar'),
      });
      const binaryPath = path.join(
        fixture, 'app.asar.unpacked', 'node_modules',
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'claude.exe' : 'claude',
      );
      mkdirSync(path.dirname(binaryPath), { recursive: true });
      writeFileSync(binaryPath, 'test binary');

      const { resolveNativeBinaryPath } = await import('../../electron/claudeCodeEnvironment');
      expect(resolveNativeBinaryPath()).toBe(binaryPath);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('reports no orphaned self-update files when the host is not packaged', async () => {
    const { findOrphanedClaudeUpdateFiles } = await import('../../electron/claudeCodeEnvironment');
    expect(findOrphanedClaudeUpdateFiles()).toEqual([]);
  });
});
