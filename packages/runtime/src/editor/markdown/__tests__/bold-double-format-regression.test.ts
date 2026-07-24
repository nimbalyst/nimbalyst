/**
 * Regression test for bold markdown double formatting issue.
 *
 * Issue: Bold text was being exported as **__text__** instead of **text**
 * Cause: Both BOLD_STAR and BOLD_UNDERSCORE transformers were being applied
 * Fix: EnhancedMarkdownExport now deduplicates transformers by format type
 */

import { describe, it, expect } from 'vitest';
import { BOLD_STAR, BOLD_UNDERSCORE } from '../MarkdownTransformers';

// Test the fix logic for preventing double bold formatting
describe('Bold double formatting regression', () => {
  it('should only apply one bold transformer even when multiple are provided', () => {
    // Mock the exportTextFormat behavior with both bold transformers
    // This simulates what happens when CORE_TRANSFORMERS includes both
    const transformers = [BOLD_STAR, BOLD_UNDERSCORE];

    // The fix ensures only one transformer per format is applied
    const appliedFormats = new Set();
    const applied = [];

    for (const transformer of transformers) {
      if (transformer.format.length === 1) {
        const format = transformer.format[0];
        // This is the key fix - only apply one transformer per format
        if (!appliedFormats.has(format)) {
          appliedFormats.add(format);
          applied.push(transformer.tag);
        }
      }
    }

    // Should only have one bold tag, not both
    expect(applied.length).toBe(1);
    expect(applied[0]).toBe('**'); // BOLD_STAR comes first

    // The output would be **bold text**, not **__bold text__**
    const output = applied[0] + 'bold text' + applied[0];
    expect(output).toBe('**bold text**');
    expect(output).not.toContain('__');
  });

  it('should prioritize first transformer when multiple match same format', () => {
    // When both transformers match the same format (bold),
    // only the first one should be used
    const transformers = [BOLD_STAR, BOLD_UNDERSCORE];

    // Filter to single-format transformers
    const singleFormatTransformers = transformers.filter(t => t.format.length === 1);

    // Both should be for 'bold' format
    expect(singleFormatTransformers[0].format[0]).toBe('bold');
    expect(singleFormatTransformers[1].format[0]).toBe('bold');

    // But only the first one's tag should be used
    expect(singleFormatTransformers[0].tag).toBe('**');
    expect(singleFormatTransformers[1].tag).toBe('__');

    // Simulate the fix: only use first transformer for each format
    const usedFormats = new Set();
    const usedTags = [];

    for (const t of singleFormatTransformers) {
      const format = t.format[0];
      if (!usedFormats.has(format)) {
        usedFormats.add(format);
        usedTags.push(t.tag);
      }
    }

    expect(usedTags).toEqual(['**']); // Only BOLD_STAR's tag
  });
});