// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseOpenFileDeepLink } from '../openFileLinks';

describe('open-file deep links', () => {
  it('parses the host form with an absolute path', () => {
    expect(
      parseOpenFileDeepLink('nimbalyst://open?path=%2FUsers%2Fme%2Fnotes%2Fplan.md'),
    ).toEqual({ path: '/Users/me/notes/plan.md' });
  });

  it('parses the empty-host form and preserves spaces and unicode', () => {
    expect(
      parseOpenFileDeepLink(
        'nimbalyst:///open?path=' +
          encodeURIComponent('/Users/me/Мои заметки/план недели.md'),
      ),
    ).toEqual({ path: '/Users/me/Мои заметки/план недели.md' });
  });

  it('accepts a positive integer line and an absolute workspace hint', () => {
    expect(
      parseOpenFileDeepLink(
        'nimbalyst://open?path=%2Fws%2Fsrc%2Fmain.ts&line=42&workspace=%2Fws',
      ),
    ).toEqual({ path: '/ws/src/main.ts', line: 42, workspacePath: '/ws' });
  });

  it('rejects invalid line values outright instead of degrading', () => {
    for (const line of ['0', '-1', 'abc', '1.5', '']) {
      expect(
        parseOpenFileDeepLink(`nimbalyst://open?path=%2Fws%2Fa.md&line=${line}`),
      ).toBeNull();
    }
  });

  it('requires an absolute, NUL-free path', () => {
    expect(parseOpenFileDeepLink('nimbalyst://open')).toBeNull();
    expect(parseOpenFileDeepLink('nimbalyst://open?path=relative%2Fa.md')).toBeNull();
    expect(parseOpenFileDeepLink('nimbalyst://open?path=%2Fws%2Fa%00.md')).toBeNull();
  });

  it('rejects a relative workspace hint', () => {
    expect(
      parseOpenFileDeepLink('nimbalyst://open?path=%2Fws%2Fa.md&workspace=ws'),
    ).toBeNull();
  });

  it('rejects foreign protocols, other hosts, extra segments, and fragments', () => {
    expect(parseOpenFileDeepLink('https://open?path=%2Fws%2Fa.md')).toBeNull();
    expect(parseOpenFileDeepLink('nimbalyst://opened?path=%2Fws%2Fa.md')).toBeNull();
    expect(parseOpenFileDeepLink('nimbalyst://open/extra?path=%2Fws%2Fa.md')).toBeNull();
    expect(parseOpenFileDeepLink('nimbalyst://open?path=%2Fws%2Fa.md#frag')).toBeNull();
    expect(parseOpenFileDeepLink('not a url')).toBeNull();
  });
});
