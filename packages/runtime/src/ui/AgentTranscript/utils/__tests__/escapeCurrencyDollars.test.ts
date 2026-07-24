import { describe, it, expect } from 'vitest';
import { escapeCurrencyDollars } from '../escapeCurrencyDollars';

describe('escapeCurrencyDollars', () => {
  it('escapes the canonical currency-spans-text case from #462', () => {
    const input =
      'solution that generated $7M in SaaS ARR within 24 months, and supported more than $40M in ARR';
    const out = escapeCurrencyDollars(input);
    expect(out).toBe(
      'solution that generated \\$7M in SaaS ARR within 24 months, and supported more than \\$40M in ARR',
    );
  });

  it('escapes $5 to $10 style pair', () => {
    expect(escapeCurrencyDollars('cost is $5 to $10 per unit')).toBe(
      'cost is \\$5 to \\$10 per unit',
    );
  });

  it('escapes the typing-shortcut case from Greg s tests', () => {
    expect(escapeCurrencyDollars('we made $7M last year and $40M this year')).toBe(
      'we made \\$7M last year and \\$40M this year',
    );
  });

  it('preserves legitimate inline math $x = 5$', () => {
    expect(escapeCurrencyDollars('we have $x = 5$ as a fact')).toBe(
      'we have $x = 5$ as a fact',
    );
  });

  it('preserves display math $$...$$', () => {
    expect(escapeCurrencyDollars('inline $$x^2 + y^2 = z^2$$ display')).toBe(
      'inline $$x^2 + y^2 = z^2$$ display',
    );
  });

  it('preserves already-escaped currency \\$5 \\$10', () => {
    expect(escapeCurrencyDollars('cost is \\$5 to \\$10 per unit')).toBe(
      'cost is \\$5 to \\$10 per unit',
    );
  });

  it('handles mixed math and currency in the same line', () => {
    const out = escapeCurrencyDollars('the cost was $5 to $10 and $x = 5$ is true');
    expect(out).toBe('the cost was \\$5 to \\$10 and $x = 5$ is true');
  });

  it('does not collapse currency across lines', () => {
    const input = 'line one ends with $5\nline two starts with $10';
    expect(escapeCurrencyDollars(input)).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(escapeCurrencyDollars('')).toBe('');
  });

  it('returns plain text without dollar signs unchanged', () => {
    expect(escapeCurrencyDollars('no money here')).toBe('no money here');
  });

  it('preserves a lone unpaired $ (no closing pair on the line)', () => {
    expect(escapeCurrencyDollars('the price is $5')).toBe('the price is $5');
  });
});
