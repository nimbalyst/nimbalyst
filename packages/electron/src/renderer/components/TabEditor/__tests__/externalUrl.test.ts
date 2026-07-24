import { describe, expect, it } from 'vitest';
import { normalizeExternalHttpsUrl } from '../externalUrl';

describe('normalizeExternalHttpsUrl', () => {
  it('normalizes an HTTPS URL for the external-browser boundary', () => {
    expect(normalizeExternalHttpsUrl(' https://www.lcsc.com/search?q=C123 '))
      .toBe('https://www.lcsc.com/search?q=C123');
  });

  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'file:///tmp/secret',
    'https://user:secret@example.com/path',
    'not a url',
    '',
  ])('rejects unsafe external URL %s', (candidate) => {
    expect(() => normalizeExternalHttpsUrl(candidate)).toThrow();
  });
});
