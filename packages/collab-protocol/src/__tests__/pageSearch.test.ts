// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  pageSearchIndexKeys,
  pageSearchMatches,
  pageSearchQueryKeys,
  pageSearchQueryTerms,
  pageSearchSnippet,
  pageSearchTextFromMarkdown,
} from '../pageSearch';

describe('page search text and matching', () => {
  it('reads markdown as plain text, matches whole words and the typed prefix, and ignores case and accents', () => {
    const markdown = [
      '---', 'title: Hidden', '---',
      '# Sync **design**',
      '',
      '[We [decided](https://example.com/x "rel=built-on") to use Yjs for the Café sync.]{decided by=Greg}',
      '',
      '| a | b |', '|---|---|', '| pglite | sqlite |',
      '```ts', 'const x = 1;', '```',
    ].join('\n');
    const text = pageSearchTextFromMarkdown(markdown);
    expect(text).toBe('Sync design\nWe decided to use Yjs for the Café sync.\na b\npglite sqlite\nconst x = 1;');

    expect(pageSearchMatches(text, pageSearchQueryTerms('cafe YJS'))).toBe(true);
    // The last term matches a prefix while typing; a finished word must match whole.
    expect(pageSearchMatches(text, pageSearchQueryTerms('yjs deci'))).toBe(true);
    expect(pageSearchMatches(text, pageSearchQueryTerms('yjs deci '))).toBe(false);
    // Every term is required, and a term matches the start of a word only.
    expect(pageSearchMatches(text, pageSearchQueryTerms('yjs postgres'))).toBe(false);
    expect(pageSearchMatches(text, pageSearchQueryTerms('ync'))).toBe(false);
    expect(pageSearchMatches(text, pageSearchQueryTerms('title hidden'))).toBe(false);

    // The keys a body is stored under cover what a query asks for.
    const keys = pageSearchIndexKeys(text);
    for (const query of ['cafe yjs', 'yjs deci', 'pgli']) {
      expect(pageSearchQueryKeys(pageSearchQueryTerms(query)).every((anyOf) => anyOf.some((key) => keys.has(key)))).toBe(true);
    }
    expect(keys.get('t:sync')).toBe(2);
    expect(keys.has('t:hidden')).toBe(false);
  });

  it('cuts a snippet around the terms and points its highlights at them', () => {
    const text = `${'Filler words here. '.repeat(20)}The team chose Yjs over Automerge for page sync.${' More filler.'.repeat(20)}`;
    const parsed = pageSearchQueryTerms('automerge yjs');
    const { snippet, highlights } = pageSearchSnippet(text, parsed);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(highlights.map((h) => snippet.slice(h.start, h.end))).toEqual(['Yjs', 'Automerge']);
  });
});
