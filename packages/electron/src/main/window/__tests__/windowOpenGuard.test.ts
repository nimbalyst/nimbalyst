import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import { decideWindowOpen } from '../windowOpenGuard';

const DEV_OPENER = 'http://localhost:5273/index.html';
const PROD_OPENER = 'file:///Applications/Nimbalyst.app/out/renderer/index.html';

describe('decideWindowOpen', () => {
  it('denies a relative file link leaked against the dev-server origin', () => {
    // `window.open('./samples/motor-cradle.replicad.ts')` resolves to the
    // renderer origin — the NIM-1487 white-window repro.
    expect(
      decideWindowOpen('http://localhost:5273/samples/motor-cradle.replicad.ts', DEV_OPENER),
    ).toBe('deny');
  });

  it('denies file: URLs (leaked relative links in packaged builds)', () => {
    expect(
      decideWindowOpen('file:///Applications/Nimbalyst.app/out/renderer/samples/a.ts', PROD_OPENER),
    ).toBe('deny');
  });

  it('opens genuinely external http(s) links in the system browser', () => {
    expect(decideWindowOpen('https://example.com/docs', DEV_OPENER)).toBe('open-external');
    expect(decideWindowOpen('https://example.com/docs', PROD_OPENER)).toBe('open-external');
  });

  it('opens mailto links externally', () => {
    expect(decideWindowOpen('mailto:someone@example.com', DEV_OPENER)).toBe('open-external');
  });

  it('allows collab-asset downloads to keep their existing flow', () => {
    expect(decideWindowOpen('collab-asset://org/doc/asset-id', DEV_OPENER)).toBe('allow');
  });

  it('denies unknown schemes and unparseable URLs', () => {
    expect(decideWindowOpen('chrome://settings', DEV_OPENER)).toBe('deny');
    expect(decideWindowOpen('not a url', DEV_OPENER)).toBe('deny');
  });
});
