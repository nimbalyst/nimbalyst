// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import {
  isEmbeddableUrl,
  setEmbeddableExtensions,
} from '../embeddableExtensions';

afterEach(() => {
  setEmbeddableExtensions([]);
});

describe('isEmbeddableUrl', () => {
  it('accepts a collaborative document reference only with a registered embedType hint', () => {
    setEmbeddableExtensions(['.mockup.html', '.calc.md']);

    expect(
      isEmbeddableUrl(
        'nimbalyst://doc/mockup-1?orgId=team-1',
        '.mockup.html',
      ),
    ).toBe(true);
    expect(
      isEmbeddableUrl('nimbalyst://doc/mockup-1?orgId=team-1'),
    ).toBe(false);
    expect(
      isEmbeddableUrl(
        'nimbalyst://doc/mockup-1?orgId=team-1',
        '.md',
      ),
    ).toBe(false);
    expect(
      isEmbeddableUrl('https://example.com/file.mockup.html', '.mockup.html'),
    ).toBe(false);
  });

  it('embeds a Personal page link like a shared one: only with a registered embedType hint', () => {
    setEmbeddableExtensions(['.excalidraw']);
    const personal = 'https://console.nimbalyst.com/app/page/drawing-1';
    expect(isEmbeddableUrl(personal, '.excalidraw')).toBe(true);
    expect(isEmbeddableUrl(personal)).toBe(false);
    expect(isEmbeddableUrl(personal, '.md')).toBe(false);
    expect(isEmbeddableUrl('https://console.nimbalyst.com/app/item/NIM-1', '.excalidraw')).toBe(false);
  });

  it('accepts a placed view with no registered types, and nothing else under view/', () => {
    expect(isEmbeddableUrl('nimbalyst://view/type/competitor')).toBe(true);
    expect(isEmbeddableUrl('nimbalyst://view/marks?kind=decided')).toBe(true);
    expect(isEmbeddableUrl('nimbalyst://view/abc')).toBe(false);
    expect(isEmbeddableUrl('nimbalyst://NIM-12')).toBe(false);
    // Console view links embed; every other https link stays a link.
    expect(isEmbeddableUrl('https://console.nimbalyst.com/org/o/project/p/view/type/competitor')).toBe(true);
    expect(isEmbeddableUrl('https://console.nimbalyst.com/app/view/marks')).toBe(true);
    expect(isEmbeddableUrl('https://console.nimbalyst.com/org/o/project/p/document/doc-1')).toBe(false);
    expect(isEmbeddableUrl('https://example.com/view/type/competitor')).toBe(false);
  });
});
