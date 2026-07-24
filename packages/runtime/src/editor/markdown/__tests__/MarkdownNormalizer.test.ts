/**
 * Tests for MarkdownNormalizer
 */

import { describe, it, expect } from 'vitest';
import {
  detectMarkdownIndentSize,
  normalizeMarkdownLists,
  normalizeMarkdown,
} from '../MarkdownNormalizer';

describe('MarkdownNormalizer', () => {
  describe('detectMarkdownIndentSize', () => {
    it('should detect 2-space indents', () => {
      const markdown = `- Item 1
  - Item 2
    - Item 3`;
      expect(detectMarkdownIndentSize(markdown)).toBe(2);
    });

    it('should detect 4-space indents', () => {
      const markdown = `- Item 1
    - Item 2
        - Item 3`;
      expect(detectMarkdownIndentSize(markdown)).toBe(4);
    });

    it('should detect 3-space indents', () => {
      const markdown = `- Item 1
   - Item 2
      - Item 3`;
      expect(detectMarkdownIndentSize(markdown)).toBe(3);
    });

    it('should handle mixed indents by choosing most common', () => {
      const markdown = `- Item 1
  - Item 2 (2 spaces)
  - Item 3 (2 spaces)
    - Item 4 (4 spaces from start, but 2 from parent)
  - Item 5 (2 spaces)`;
      expect(detectMarkdownIndentSize(markdown)).toBe(2);
    });

    it('should ignore code blocks', () => {
      const markdown = `- Item 1
  - Item 2

\`\`\`
    - This is code, not a list
\`\`\`

  - Item 3`;
      expect(detectMarkdownIndentSize(markdown)).toBe(2);
    });

    it('should handle tabs', () => {
      const markdown = `- Item 1
\t- Item 2
\t\t- Item 3`;
      // Tabs are converted to 4 spaces
      expect(detectMarkdownIndentSize(markdown)).toBe(4);
    });

    it('should return null for no lists', () => {
      const markdown = `# Heading

Just some text.`;
      expect(detectMarkdownIndentSize(markdown)).toBe(null);
    });
  });

  describe('normalizeMarkdownLists', () => {
    it('should normalize 4-space indents to 2-space', () => {
      const markdown = `- Item 1
    - Item 2
        - Item 3
    - Item 4`;

      const expected = `- Item 1
  - Item 2
    - Item 3
  - Item 4`;

      const result = normalizeMarkdownLists(markdown, { targetIndentSize: 2 });
      expect(result).toBe(expected);
    });

    it('should normalize 2-space indents to 4-space', () => {
      const markdown = `- Item 1
  - Item 2
    - Item 3`;

      const expected = `- Item 1
    - Item 2
        - Item 3`;

      const result = normalizeMarkdownLists(markdown, { targetIndentSize: 4 });
      expect(result).toBe(expected);
    });

    it('should handle mixed indent sizes', () => {
      const markdown = `- Item 1
  - Item 2 (2 spaces)
    - Item 3 (4 spaces - should be level 2)
      - Item 4 (6 spaces - should be level 3)`;

      const expected = `- Item 1
  - Item 2 (2 spaces)
    - Item 3 (4 spaces - should be level 2)
      - Item 4 (6 spaces - should be level 3)`;

      const result = normalizeMarkdownLists(markdown, { targetIndentSize: 2 });
      expect(result).toBe(expected);
    });

    it('should preserve code blocks', () => {
      const markdown = `- List item

\`\`\`javascript
    - This should not be normalized
        - Neither should this
\`\`\`

  - Another list item`;

      const expected = `- List item

\`\`\`javascript
    - This should not be normalized
        - Neither should this
\`\`\`

  - Another list item`;

      const result = normalizeMarkdownLists(markdown);
      expect(result).toBe(expected);
    });

    it('should handle ordered lists', () => {
      const markdown = `1. First
    2. Second
        3. Third`;

      const expected = `1. First
  2. Second
    3. Third`;

      const result = normalizeMarkdownLists(markdown, { targetIndentSize: 2 });
      expect(result).toBe(expected);
    });

    it('should handle check lists', () => {
      const markdown = `- [ ] Unchecked
    - [x] Checked
        - [ ] Nested`;

      const expected = `- [ ] Unchecked
  - [x] Checked
    - [ ] Nested`;

      const result = normalizeMarkdownLists(markdown, { targetIndentSize: 2 });
      expect(result).toBe(expected);
    });

    it('should handle your specific example', () => {
      // This is the case that was causing problems
      const markdown = `- List A
  - List B
  - List C
    - List D
  - List Ed
- List F`;

      // With 2-space indents detected and normalized to 2-space (no change)
      const result = normalizeMarkdownLists(markdown, { targetIndentSize: 2 });
      expect(result).toBe(markdown);
    });

    it('should fix inconsistent indents', () => {
      // Mixed 2 and 4 space indents
      const markdown = `- List A
  - List B (2 spaces)
    - List C (4 spaces - level 2)
      - List D (6 spaces - level 3)
  - List E (2 spaces - back to level 1)`;

      const expected = `- List A
  - List B (2 spaces)
    - List C (4 spaces - level 2)
      - List D (6 spaces - level 3)
  - List E (2 spaces - back to level 1)`;

      const result = normalizeMarkdownLists(markdown);
      expect(result).toBe(expected);
    });
  });

  describe('normalizeMarkdown', () => {
    it('should apply all normalizations', () => {
      const markdown = `# Heading

1. First item
    2. Second item (4 spaces)
        3. Third item (8 spaces)`;

      const expected = `# Heading

1. First item
  2. Second item (4 spaces)
    3. Third item (8 spaces)`;

      const result = normalizeMarkdown(markdown, { targetIndentSize: 2 });
      expect(result).toBe(expected);
    });

    it('should skip normalization if disabled', () => {
      const markdown = `- Item
    - Nested with 4 spaces`;

      const result = normalizeMarkdown(markdown, { normalizeListIndents: false });
      expect(result).toBe(markdown);
    });
  });
});