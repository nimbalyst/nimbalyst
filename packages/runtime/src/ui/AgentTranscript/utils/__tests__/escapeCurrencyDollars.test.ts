// @vitest-environment node
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

  // #1385: remark-math pairs two `$` anywhere in the same paragraph, so a soft
  // line break between two amounts is still one math span to the renderer.
  describe('soft line breaks (#1385)', () => {
    it('escapes a pair split across a soft line break', () => {
      const input = 'the plan is $990/mo.\nand comes with a $1,500 freebie';
      expect(escapeCurrencyDollars(input)).toBe(
        'the plan is \\$990/mo.\nand comes with a \\$1,500 freebie',
      );
    });

    it('leaves a pair separated by a blank line alone', () => {
      const input = 'the plan is $990/mo.\n\nand comes with a $1,500 freebie';
      expect(escapeCurrencyDollars(input)).toBe(input);
    });

    it('leaves a pair separated by a whitespace-only line alone', () => {
      const input = 'the plan is $990/mo.\n  \nand comes with a $1,500 freebie';
      expect(escapeCurrencyDollars(input)).toBe(input);
    });

    it('does not span two line breaks', () => {
      const input = 'costs $5\nper seat\nplus $10 setup';
      expect(escapeCurrencyDollars(input)).toBe(input);
    });

    it('leaves inline math unchanged', () => {
      expect(escapeCurrencyDollars('we have $x = 5$ as a fact')).toBe('we have $x = 5$ as a fact');
    });

    it('leaves a soft-line-break pair inside a fenced code block alone', () => {
      const input = "```sh\necho $1\necho $2\n```";
      expect(escapeCurrencyDollars(input)).toBe(input);
    });
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

  // #1373: a backslash is literal inside code, so escaping there is visible on
  // screen and travels with any copy, breaking the copied command.
  describe('code is exempt (#1373)', () => {
    const identity = (label: string, input: string) => {
      it(label, () => {
        expect(escapeCurrencyDollars(input)).toBe(input);
      });
    };

    identity('fenced code', "```sh\nawk '{print $1, $2}'\n```");
    identity('inline code span', "run `awk '{print $1, $2}'` now");
    identity('fence inside a blockquote', "> ```sh\n> jq '.a[$1] + $2'\n> ```");
    identity('nested fence', "````md\n```sh\nawk '{print $1, $2}'\n```\n````");
    identity('indented code', "    awk '{print $1, $2}'");

    it('escapes prose but not the fence between it', () => {
      const input = 'prose $7 to $40 then\n```sh\necho $1 $2\n```\nand $3 to $50';
      expect(escapeCurrencyDollars(input)).toBe(
        'prose \\$7 to \\$40 then\n```sh\necho $1 $2\n```\nand \\$3 to \\$50',
      );
    });

    it('escapes around an inline span on the same line', () => {
      expect(escapeCurrencyDollars('paid $5 to $10 running `echo $1 $2` daily')).toBe(
        'paid \\$5 to \\$10 running `echo $1 $2` daily',
      );
    });
  });

  // The escape runs on the source, before the document is parsed, so inline
  // markup spanning a currency pair still renders. Reverting `inlineMath`
  // nodes after the fact would flatten this to literal asterisks.
  it('preserves markdown that crosses the currency span', () => {
    expect(escapeCurrencyDollars('grew from $7M to **$40M** total')).toBe(
      'grew from \\$7M to **\\$40M** total',
    );
  });
});
