// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readCellLink, writeCellLink } from '../linkCell';

describe('Cmd+K link cells', () => {
  it('reads an existing HYPERLINK, quotes included, and writes it back unchanged', () => {
    const raw = '=HYPERLINK("https://x.test/?q=""a""","Say ""hi""")';
    const link = readCellLink(raw, 'ignored', false);
    expect(link).toEqual({ text: 'Say "hi"', url: 'https://x.test/?q="a"', editable: true });
    expect(writeCellLink(link, false)).toBe(raw);
  });

  it('turns plain text into a link labelled with that text', () => {
    const link = readCellLink('Docs', 'Docs', false);
    expect(link).toEqual({ text: 'Docs', url: '', editable: true });
    expect(writeCellLink({ ...link, url: 'https://docs.test' }, false)).toBe('=HYPERLINK("https://docs.test","Docs")');
  });

  it('writes a bare HYPERLINK when the label is empty or the URL itself, and plain text when the URL is removed', () => {
    expect(writeCellLink({ text: '', url: 'https://a.test' }, false)).toBe('=HYPERLINK("https://a.test")');
    expect(writeCellLink({ text: 'https://a.test', url: 'https://a.test' }, false)).toBe('=HYPERLINK("https://a.test")');
    expect(writeCellLink({ text: 'Label', url: '  ' }, false)).toBe('Label');
  });

  it('edits the URL itself in a url column', () => {
    expect(readCellLink('https://old.test', 'https://old.test', true)).toEqual({ text: '', url: 'https://old.test', editable: true });
    expect(writeCellLink({ text: 'ignored', url: 'https://new.test' }, true)).toBe('https://new.test');
  });

  it('starts from the shown value of a HYPERLINK built from references, which a save replaces', () => {
    expect(readCellLink('=HYPERLINK(A1,B1)', 'Label', false)).toEqual({ text: 'Label', url: '', editable: false });
  });
});
