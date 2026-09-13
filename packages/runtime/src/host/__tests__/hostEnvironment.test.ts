// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
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
    setHostEnvironment({
      isPackaged: () => true,
      getAppPath: () => '/Applications/Nimbalyst.app/Contents/Resources/app.asar',
    });

    const { resolveNativeBinaryPath } = await import('../../electron/claudeCodeEnvironment');

    // The packaged branch constructs a path under app.asar.unpacked and checks
    // the filesystem. Nothing is there in a test, so the honest answer is
    // undefined -- the point is that it took the packaged branch at all, which
    // it can only do by reading the injected host.
    expect(resolveNativeBinaryPath()).toBeUndefined();
  });

  it('reports no orphaned self-update files when the host is not packaged', async () => {
    const { findOrphanedClaudeUpdateFiles } = await import('../../electron/claudeCodeEnvironment');
    expect(findOrphanedClaudeUpdateFiles()).toEqual([]);
  });
});
