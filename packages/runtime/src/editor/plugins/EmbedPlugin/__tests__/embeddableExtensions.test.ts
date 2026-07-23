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
});
