/**
 * Tests for direction detection and inline run detection.
 *
 * Note: Persian/Arabic/Hebrew sample strings below are intentional — they are
 * real RTL text used to verify the algorithm detects the correct direction.
 */

import { describe, expect, it } from 'vitest';
import {
  detectDirection,
  detectMessageDirection,
  detectBlocks,
  detectInlineRuns,
} from '../detection';

describe('detectDirection', () => {
  it('detects RTL scripts', () => {
    expect(detectDirection('سلام دنیا، این یک متن فارسی است')).toBe('rtl'); // Persian
    expect(detectDirection('مرحبا بالعالم هذا نص عربي')).toBe('rtl'); // Arabic
    expect(detectDirection('שלום עולם זה טקסט בעברית')).toBe('rtl'); // Hebrew
  });

  it('detects LTR text', () => {
    expect(detectDirection('Hello world, this is English text')).toBe('ltr');
  });

  it('resolves mixed text by majority', () => {
    expect(detectDirection('سلام این متن فارسی است با کمی English')).toBe('rtl');
    expect(detectDirection('This is mostly English with one word: سلام')).toBe('ltr');
  });

  it('handles edge cases as LTR', () => {
    expect(detectDirection('')).toBe('ltr');
    expect(detectDirection('   ')).toBe('ltr');
    expect(detectDirection('12345 67890')).toBe('ltr');
    expect(detectDirection('😀🎉🚀')).toBe('ltr');
  });

  it('treats Persian digits as RTL context', () => {
    expect(detectDirection('در سال ۱۴۰۳ این اتفاق افتاد')).toBe('rtl');
  });
});

describe('detectBlocks', () => {
  it('detects per-paragraph direction', () => {
    const blocks = detectBlocks('سلام دنیا\n\nHello world\n\nاین هم فارسی است');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].direction).toBe('rtl');
    expect(blocks[1].direction).toBe('ltr');
    expect(blocks[2].direction).toBe('rtl');
  });
});

describe('detectMessageDirection', () => {
  it('resolves message direction by block majority', () => {
    expect(detectMessageDirection('سلام دنیا\n\nHello\n\nاین هم فارسی است\n\nباز هم فارسی')).toBe('rtl');
    expect(detectMessageDirection('Hello world\n\nسلام\n\nMore English\n\nEven more')).toBe('ltr');
  });
});

describe('detectInlineRuns', () => {
  it('returns a single run for pure-direction text', () => {
    const engRuns = detectInlineRuns('Hello world');
    expect(engRuns).toHaveLength(1);
    expect(engRuns[0].direction).toBe('ltr');

    const perRuns = detectInlineRuns('سلام دنیا');
    expect(perRuns).toHaveLength(1);
    expect(perRuns[0].direction).toBe('rtl');
  });

  it('splits mixed text into runs', () => {
    const mixedRuns = detectInlineRuns('Hello سلام world');
    expect(mixedRuns.length).toBeGreaterThanOrEqual(2);
    expect(mixedRuns.some((r) => r.direction === 'rtl' && r.text.includes('سلام'))).toBe(true);
    expect(mixedRuns.some((r) => r.direction === 'ltr' && r.text.includes('Hello'))).toBe(true);
  });

  it('handles empty and whitespace input', () => {
    expect(detectInlineRuns('')).toHaveLength(0);
    expect(detectInlineRuns('   ')).toHaveLength(1);
  });

  it('isolates an RTL word in the middle of LTR text', () => {
    const midRuns = detectInlineRuns('The word سلام is Persian');
    expect(midRuns.length).toBeGreaterThanOrEqual(3);
    const rtlMidRun = midRuns.find((r) => r.direction === 'rtl');
    expect(rtlMidRun).toBeDefined();
    expect(rtlMidRun!.text).toContain('سلام');
  });

  it('merges neutral characters into the adjacent run', () => {
    const spaceRuns = detectInlineRuns('hello سلام');
    expect(spaceRuns).toHaveLength(2);
    expect(spaceRuns[0].direction).toBe('ltr');
    expect(spaceRuns[0].text).toBe('hello ');
    expect(spaceRuns[1].direction).toBe('rtl');
    expect(spaceRuns[1].text).toBe('سلام');
  });
});
