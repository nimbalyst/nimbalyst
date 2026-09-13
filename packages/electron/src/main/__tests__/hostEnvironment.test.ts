import { describe, it, expect, vi, afterEach } from 'vitest';

const appMock = vi.hoisted(() => ({
  isPackaged: true,
  getAppPath: vi.fn(() => '/Applications/Nimbalyst.app/Contents/Resources/app.asar'),
}));

vi.mock('electron', () => ({ app: appMock }));

import { setHostEnvironment, getHostEnvironment } from '@nimbalyst/runtime/host/hostEnvironment';
import { electronHostEnvironment, registerElectronHostEnvironment } from '../hostEnvironment';

// Captured at module-load time, before any test clears the slot. Importing the
// Electron host module must register it as a side effect -- bootstrap cannot do
// this from its own body, because ESM evaluates `import './index.js'` first.
// Asserting on a value sampled here is what makes deleting that registration a
// failing test rather than a green one.
const hostAtImportTime = getHostEnvironment();

afterEach(() => {
  setHostEnvironment(null);
  appMock.isPackaged = true;
});

describe('electron host environment', () => {
  it('registers itself when the module is imported, not when a caller asks', () => {
    expect(hostAtImportTime).toBe(electronHostEnvironment);
  });

  it('answers both questions from Electron rather than the Node defaults', () => {
    expect(electronHostEnvironment.isPackaged()).toBe(true);
    expect(electronHostEnvironment.getAppPath()).toBe(
      '/Applications/Nimbalyst.app/Contents/Resources/app.asar',
    );
    expect(electronHostEnvironment.getAppPath()).not.toBe(process.cwd());
  });

  it('reads app lazily, so registering before app.whenReady() is safe', () => {
    appMock.isPackaged = false;
    expect(electronHostEnvironment.isPackaged()).toBe(false);
    appMock.isPackaged = true;
    expect(electronHostEnvironment.isPackaged()).toBe(true);
  });

  it('is idempotent, so an explicit call after the import changes nothing', () => {
    registerElectronHostEnvironment();
    expect(getHostEnvironment()).toBe(electronHostEnvironment);
  });
});
