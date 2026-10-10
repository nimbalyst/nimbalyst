// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  describePageMark,
  findInlinePageMark,
  findPageMarks,
  formatPageMarkAttrs,
  formatPageMarkMarkdown,
  parsePageMarkAttrs,
  serializePageMarkAttrs,
} from '../pageMarkSyntax';

describe('pageMarkSyntax', () => {
  it('finds a mark whose sentence nests a link, emphasis, a citation and brackets in code', () => {
    const line = 'Before [Storage in [Flagship](nimbalyst://NIM-9) is **ours** `a]b`.[GH](nimbalyst://cite/s1/answer/k1 "quote=\'x%5Dy\'")]{decided by="Greg" on=2026-09-30 over="our \\"own\\" engine"} after';
    const match = findInlinePageMark(line)!;
    expect(line.slice(match.start, match.end)).toBe(line.slice(7, -6));
    expect(line.slice(match.innerStart, match.innerEnd)).toBe(
      'Storage in [Flagship](nimbalyst://NIM-9) is **ours** `a]b`.[GH](nimbalyst://cite/s1/answer/k1 "quote=\'x%5Dy\'")',
    );
    expect(match.attrs).toEqual({ kind: 'decided', by: 'Greg', on: '2026-09-30', over: 'our "own" engine' });
  });

  it('is not fooled by plain links, images, escapes or unknown brace blocks', () => {
    expect(findInlinePageMark('[a](b){decided}')).toBeNull();
    expect(findInlinePageMark('![a]{decided}')).toBeNull();
    expect(findInlinePageMark('\\[a]{decided}')).toBeNull();
    expect(findInlinePageMark('[a]{decidedly}')).toBeNull();
    expect(findInlinePageMark('[a]{decided by="unterminated}')).toBeNull();
    const later = findInlinePageMark('see [x](y) and [b]{open}')!;
    expect(later.attrs).toEqual({ kind: 'open' });
  });

  it('keeps an agent-written attribute block byte for byte and canonicalizes after a change', () => {
    const raw = '{decided on=2026-09-30 email=greg@example.com by=Greg extra=1}';
    const parsed = parsePageMarkAttrs(raw)!;
    expect(parsed.attrs).toEqual({ kind: 'decided', on: '2026-09-30', by: 'Greg', email: 'greg@example.com' });
    expect(serializePageMarkAttrs(parsed.attrs, raw)).toBe(raw);
    expect(serializePageMarkAttrs({ ...parsed.attrs, by: 'Ana', email: 'ana@example.com' }, raw))
      .toBe('{decided by="Ana" email=ana@example.com on=2026-09-30}');
    // Newlines in a value would split the paragraph on the next import.
    expect(formatPageMarkAttrs({ kind: 'open', by: 'a\nb', over: '' })).toBe('{open by="a b"}');
    expect(formatPageMarkMarkdown('x', { kind: 'open' })).toBe('[x]{open}');
  });

  it('ignores marks inside fenced code, inline code and frontmatter', () => {
    const markdown = [
      '---',
      'note: "[x]{decided}"',
      '---',
      '- [Ship it.]{decided by="Greg" on=2026-09-30}',
      '```md',
      '[Not a mark]{decided}',
      '```',
      'Inline `[nope]{open}` and [Is it fast?]{open by="Spike 6"}',
      '~~~',
      '[fenced]{open}',
      '~~~',
    ].join('\n');
    const marks = findPageMarks(markdown);
    expect(marks.map((m) => [m.kind, m.plainText, m.line])).toEqual([
      ['decided', 'Ship it.', 4],
      ['open', 'Is it fast?', 8],
    ]);
    expect(markdown.slice(marks[1].start, marks[1].end)).toBe('[Is it fast?]{open by="Spike 6"}');
  });

  it('reduces the sentence to plain text and describes who, when and what was not chosen', () => {
    const [mark] = findPageMarks('[Use [Flagship](nimbalyst://NIM-1) for **all** flags.[GH](nimbalyst://cite/s/prompt/p)]{decided by="Greg" on=2026-09-30 over="our own engine"}');
    expect(mark.plainText).toBe('Use Flagship for all flags.');
    expect(describePageMark(mark, 2026)).toBe('Greg, Sep 30, over our own engine');
    expect(describePageMark({ kind: 'open', by: 'Spike 6', over: 'ignored' })).toBe('Spike 6');
  });
});
