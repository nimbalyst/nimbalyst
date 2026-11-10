// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { COMMENT_BOUNDS } from '../commentValidation';
import {
  findQuoteMatches,
  findThreadQuoteOffset,
  joinCommentTextBlocks,
} from '../quoteMatch';

describe('joinCommentTextBlocks', () => {
  it('normalizes each block and joins with one newline, no trailing separator', () => {
    expect(joinCommentTextBlocks(['First line', 'Two\r\nparts', ''])).toBe(
      'First line\nTwo\nparts\n',
    );
    expect(joinCommentTextBlocks(['only'])).toBe('only');
    expect(joinCommentTextBlocks([])).toBe('');
  });
});

describe('findQuoteMatches', () => {
  const text = joinCommentTextBlocks(['Alpha beta gamma.', 'Delta beta epsilon.']);

  it('uses prefix and suffix to single out one of several occurrences', () => {
    expect(findQuoteMatches(text, { exact: 'beta' })).toEqual([6, 24]);
    expect(findQuoteMatches(text, { exact: 'beta', prefix: 'Delta ' })).toEqual([24]);
    expect(findQuoteMatches(text, { exact: 'beta', suffix: ' gamma' })).toEqual([6]);
    expect(findQuoteMatches(text, { exact: 'beta', prefix: 'Omega ' })).toEqual([]);
    // Context is normalized like the text: a no-break space matches a space.
    expect(findQuoteMatches(text, { exact: 'beta', prefix: 'Delta ' })).toEqual([24]);
  });

  it('counts non-overlapping occurrences only', () => {
    expect(findQuoteMatches('aaaa', { exact: 'aa' })).toEqual([0, 2]);
    expect(findQuoteMatches('aaa', { exact: 'aa' })).toEqual([0]);
  });

  it('matches nothing for an invalid selector instead of throwing', () => {
    expect(findQuoteMatches(text, { exact: '' })).toEqual([]);
    expect(
      findQuoteMatches(text, { exact: 'x'.repeat(COMMENT_BOUNDS.maxAnchorExactBytes + 1) }),
    ).toEqual([]);
    expect(
      findQuoteMatches(text, {
        exact: 'beta',
        prefix: 'p'.repeat(COMMENT_BOUNDS.maxAnchorContextBytes + 1),
      }),
    ).toEqual([]);
  });
});

describe('findThreadQuoteOffset', () => {
  it('prefers the context, falls back to a unique bare quote, never to a repeated one', () => {
    const text = joinCommentTextBlocks(['Alpha beta gamma.', 'Delta beta epsilon.']);
    expect(findThreadQuoteOffset(text, { exact: 'beta', prefix: 'Delta ' })).toBe(24);
    // Context gone, quote unique: found by the quote alone.
    expect(findThreadQuoteOffset(text, { exact: 'gamma', prefix: 'Edited ' })).toBe(11);
    // Context gone, quote repeated: no guess.
    expect(findThreadQuoteOffset(text, { exact: 'beta', prefix: 'Edited ' })).toBeNull();
    // Context itself ambiguous: no fallback either.
    expect(findThreadQuoteOffset('x beta y x beta y', { exact: 'beta', prefix: 'x ' })).toBeNull();
    expect(findThreadQuoteOffset(text, { exact: 'omega' })).toBeNull();
  });
});
