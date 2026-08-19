// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockupHasScript, renderMockupHtml } from '../mockupDomUtils';

/**
 * The mockup `<base>` is the one piece of the render path that has to know which
 * host it is running in. It was hardcoded to `file://`, which is invisible on
 * desktop and silently breaks every relative URL inside a mockup on the web
 * console — the failure a reader cannot see, and the reason these two cases are
 * worth their cost.
 */
function renderInto(html: string): Document {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  renderMockupHtml(iframe, html);
  const doc = iframe.contentDocument;
  if (!doc) throw new Error('iframe has no contentDocument');
  return doc;
}

/**
 * A frame that parsed the document without running its scripts.
 *
 * jsdom executes `doc.write()`n scripts and enforces no CSP, so it models the
 * desktop host exactly and cannot produce the blocked case on its own. Swapping
 * the window the probe is read back from is the narrowest way to express "the
 * probe never set its flag" — and what is under test here is how the result is
 * *derived*, not whether Chromium honours a CSP, which was measured against the
 * deployed console rather than asserted in jsdom.
 */
function renderWithoutRunningScripts(html: string): boolean {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: {} });
  return renderMockupHtml(iframe, html).scriptsRan;
}

function stubLocation(location: { origin: string; pathname: string; protocol: string }): void {
  vi.stubGlobal('location', location);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('renderMockupHtml', () => {
  it('resolves relative URLs against the serving origin in a browser host', () => {
    stubLocation({
      origin: 'https://console.nimbalyst.com',
      pathname: '/documents/abc',
      protocol: 'https:',
    });

    const base = renderInto('<img src="logo.png">').querySelector('base');

    expect(base?.getAttribute('href')).toBe('https://console.nimbalyst.com/documents/abc');
  });

  it('keeps the file:// base desktop already depends on', () => {
    stubLocation({ origin: 'null', pathname: '/Applications/Nimbalyst.app/index.html', protocol: 'file:' });

    const base = renderInto('<img src="logo.png">').querySelector('base');

    expect(base?.getAttribute('href')).toBe('file:///Applications/Nimbalyst.app/index.html');
  });

  /*
   * Whether a mockup's own scripts ran is measured, not asked of the host: the
   * answer comes from the CSP the page was served with, which the editor cannot
   * see. The editor pairs this with `mockupHasScript` so the notice appears only
   * for a mockup that actually loses something.
   */
  it('reports scripts as running in a host that executes them', () => {
    stubLocation({ origin: 'null', pathname: '/index.html', protocol: 'file:' });
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);

    expect(renderMockupHtml(iframe, '<h1>Mockup</h1>').scriptsRan).toBe(true);
  });

  it('reports scripts as blocked when the frame never runs the probe', () => {
    stubLocation({
      origin: 'https://console.nimbalyst.com',
      pathname: '/documents/abc',
      protocol: 'https:',
    });

    expect(renderWithoutRunningScripts('<script>window.go = 1;</script>')).toBe(false);
  });

  it.each([
    ['<script>go()</script>', true],
    ['<script src="app.js"></script>', true],
    ['<SCRIPT>go()</SCRIPT>', true],
    ['<h1>Just markup</h1>', false],
    ['<p>The word script is not a tag</p>', false],
    ['<script-like-element />', false],
  ])('detects whether %s carries a script', (html, expected) => {
    expect(mockupHasScript(html)).toBe(expected);
  });
});
