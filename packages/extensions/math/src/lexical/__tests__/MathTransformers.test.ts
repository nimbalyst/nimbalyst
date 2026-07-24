import { describe, expect, it } from 'vitest';

import { INLINE_MATH_TRANSFORMER } from '../MathTransformers';

const importRe = INLINE_MATH_TRANSFORMER.importRegExp as RegExp;
const shortcutRe = INLINE_MATH_TRANSFORMER.regExp;

describe('INLINE_MATH_TRANSFORMER import regex', () => {
  it('matches a simple inline math expression', () => {
    const text = 'see $x = 1$ here';
    const match = text.match(importRe);
    expect(match?.[1]).toBe('x = 1');
  });

  it('does not match currency amounts separated by other text', () => {
    const text =
      'solution that generated $7M in SaaS ARR within 24 months, and supported more than $40M in ARR';
    expect(text.match(importRe)).toBeNull();
  });

  it('does not match when opening $ is followed by whitespace', () => {
    const text = 'cost is $ 7 and total is $10';
    expect(text.match(importRe)).toBeNull();
  });

  it('does not match when closing $ is preceded by whitespace', () => {
    const text = 'paid $7 dollars $ here';
    expect(text.match(importRe)).toBeNull();
  });

  it('does not match $5 ... $10 currency pattern', () => {
    const text = 'from $5 to $10 per item';
    expect(text.match(importRe)).toBeNull();
  });

  it('still matches real math containing punctuation', () => {
    const text = 'use $a + b = c$ in the formula';
    const match = text.match(importRe);
    expect(match?.[1]).toBe('a + b = c');
  });
});

describe('INLINE_MATH_TRANSFORMER typing shortcut', () => {
  // The typing shortcut is intentionally disabled in favor of slash-menu
  // insertion. The regex must never match user-typed text.
  it.each([
    'see $x = 1$',
    'we made $7M last year and $40M',
    'just typed $$',
    '$',
    '',
  ])('does not match %j', (text) => {
    expect(text.match(shortcutRe)).toBeNull();
  });
});
