import { describe, it, expect } from 'vitest';
import * as chardet from 'chardet';
import { decodeTextFileBuffer } from '../textEncoding';

describe('decodeTextFileBuffer', () => {
  // Regression for GitHub #794 / NIM-1575: UTF-8 markdown with smart punctuation
  // was decoded as latin1 because chardet guessed windows-1252, producing `â`
  // mojibake and a reload loop. These strings must round-trip unchanged.
  const smartPunctuation = [
    'Hello world — this is a note.',
    'It’s a test — really.',
    '“hello” said the world', // chardet.detect() returns windows-1252 for this
    'café résumé naïve',
    'It’s here—really, it’s café',
    'ellipsis… and more “quotes”',
  ];

  it('proves the misdetection this fix guards against still exists in chardet', () => {
    // If chardet ever stops misclassifying this, the fix is still correct but the
    // most important regression case is gone -- flag it so we notice.
    const buf = Buffer.from('“hello” said the world', 'utf-8');
    expect(chardet.detect(buf)).toMatch(/1252|8859/i);
  });

  for (const text of smartPunctuation) {
    it(`round-trips UTF-8 smart punctuation: ${JSON.stringify(text)}`, () => {
      const buf = Buffer.from(text, 'utf-8');
      const { content, encoding } = decodeTextFileBuffer(buf);
      expect(content).toBe(text);
      expect(content).not.toContain('â'); // no `â` mojibake
      expect(encoding).toBe('utf8');
    });
  }

  it('decodes plain ASCII as UTF-8', () => {
    const buf = Buffer.from('just plain ascii text here\n', 'utf-8');
    expect(decodeTextFileBuffer(buf)).toEqual({
      content: 'just plain ascii text here\n',
      encoding: 'utf8',
    });
  });

  it('strips a UTF-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi — there', 'utf-8')]);
    const { content, encoding } = decodeTextFileBuffer(buf);
    expect(content).toBe('hi — there');
    expect(encoding).toBe('utf8');
  });

  it('decodes a UTF-16 LE BOM file', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]);
    const { content, encoding } = decodeTextFileBuffer(buf);
    expect(content).toBe('hello');
    expect(encoding).toBe('utf16le');
  });

  it('decodes a UTF-16 BE BOM file', () => {
    const le = Buffer.from('hello', 'utf16le');
    const be = Buffer.from(le);
    be.swap16();
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    const { content, encoding } = decodeTextFileBuffer(buf);
    expect(content).toBe('hello');
    expect(encoding).toBe('utf16le');
  });

  it('falls back to latin1 for genuinely non-UTF-8 bytes', () => {
    // Real latin1 text: bytes like 0xE9 (é) are invalid UTF-8, so UTF-8 is
    // rejected and chardet detects ISO-8859-1. Needs enough content for chardet
    // to make a confident non-UTF-8 guess.
    const original = 'This is a café résumé with señor naïve words. '.repeat(4);
    const buf = Buffer.from(original, 'latin1');
    expect(isUtf8Safe(buf)).toBe(false);
    const { content } = decodeTextFileBuffer(buf);
    expect(content).toBe(original);
    expect(content).not.toContain('�'); // no replacement char
  });

  it('handles an empty buffer', () => {
    expect(decodeTextFileBuffer(Buffer.alloc(0))).toEqual({ content: '', encoding: 'utf8' });
  });
});

function isUtf8Safe(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}
