/**
 * Tests for markdown detection utilities
 */

import { describe, it, expect } from 'vitest';
import { isLikelyMarkdown, detectMarkdown } from '../markdownDetection';

describe('markdownDetection', () => {
  describe('isLikelyMarkdown', () => {
    it('should detect headings', () => {
      const markdown = '# Heading 1\n\nThis is some text.';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect multiple heading levels', () => {
      const markdown = '# Title\n\n## Subtitle\n\nSome content here.';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect unordered lists', () => {
      const markdown = '- Item 1\n- Item 2\n- Item 3';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect ordered lists', () => {
      const markdown = '1. First item\n2. Second item\n3. Third item';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect code blocks', () => {
      const markdown = '```javascript\nconst x = 1;\n```';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect blockquotes', () => {
      const markdown = '> This is a quote\n> from someone';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect bold text', () => {
      const markdown = 'This is **bold** text.';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should NOT detect single italic text (too weak signal)', () => {
      // Single inline formatting is too ambiguous - could be accidental
      const markdown = 'This is *italic* text.';
      expect(isLikelyMarkdown(markdown)).toBe(false);
    });

    it('should NOT detect single inline code (too weak signal)', () => {
      // Single backtick could be accidental or plain text
      const markdown = 'Use the `console.log()` function to debug.';
      expect(isLikelyMarkdown(markdown)).toBe(false);
    });

    it('should NOT detect single link (too weak signal)', () => {
      // Single link is too weak - could be from any source
      const markdown = 'Check out [this link](https://example.com).';
      expect(isLikelyMarkdown(markdown)).toBe(false);
    });

    it('should detect task lists', () => {
      const markdown = '- [ ] Task 1\n- [x] Task 2\n- [ ] Task 3';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect tables', () => {
      const markdown = '| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect frontmatter', () => {
      const markdown = '---\ntitle: Test\nauthor: Me\n---\n\n# Content';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should detect horizontal rules', () => {
      const markdown = 'Section 1\n\n---\n\nSection 2';
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should NOT detect plain text', () => {
      const plainText = 'This is just plain text without any markdown formatting.';
      expect(isLikelyMarkdown(plainText)).toBe(false);
    });

    it('should NOT detect code snippets without markdown', () => {
      const code = 'function hello() {\n  console.log("hello");\n}';
      expect(isLikelyMarkdown(code)).toBe(false);
    });

    it('should NOT detect text with occasional asterisks', () => {
      const text = 'Price: $100* (*terms apply)';
      expect(isLikelyMarkdown(text)).toBe(false);
    });

    it('should NOT detect very short text', () => {
      const text = '# Hi';
      expect(isLikelyMarkdown(text)).toBe(false);
    });

    it('should detect complex markdown document', () => {
      const markdown = `# Project Title

## Introduction

This is a **bold** statement and this is *italic*.

### Features

- Feature 1
- Feature 2
- Feature 3

### Code Example

\`\`\`javascript
const greeting = "Hello World";
console.log(greeting);
\`\`\`

For more info, visit [our website](https://example.com).

> Remember: Always test your code!
`;
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should handle mixed content appropriately', () => {
      const markdown = `Some text with a # heading

And a **bold** word.`;
      expect(isLikelyMarkdown(markdown)).toBe(true);
    });

    it('should respect custom confidence threshold', () => {
      // Weak markdown signal
      const weakMarkdown = 'Just one **bold** word.';

      // Should pass with low threshold
      expect(isLikelyMarkdown(weakMarkdown, { minConfidenceScore: 5 })).toBe(true);

      // Should fail with high threshold
      expect(isLikelyMarkdown(weakMarkdown, { minConfidenceScore: 80 })).toBe(false);
    });

    it('should respect minimum content length', () => {
      const shortMarkdown = '# Hi';

      // Should fail with default minimum length
      expect(isLikelyMarkdown(shortMarkdown)).toBe(false);

      // Should pass with very low minimum length
      expect(isLikelyMarkdown(shortMarkdown, { minContentLength: 3 })).toBe(true);
    });
  });

  describe('detectMarkdown', () => {
    it('should return detection result with score', () => {
      const markdown = '# Heading\n\nSome **bold** text.';
      const result = detectMarkdown(markdown);

      expect(result.isMarkdown).toBe(true);
      expect(result.score).toBeGreaterThan(0);
    });

    it('should return score of 0 for very short text', () => {
      const text = 'Hi';
      const result = detectMarkdown(text);

      expect(result.isMarkdown).toBe(false);
      expect(result.score).toBe(0);
    });

    it('should return higher score for richer markdown', () => {
      const simpleMarkdown = '# Heading';
      const richMarkdown = `# Heading

## Subheading

- List item 1
- List item 2

**Bold** and *italic* text.

\`\`\`js
code()
\`\`\`
`;

      const simpleResult = detectMarkdown(simpleMarkdown, { minContentLength: 5 });
      const richResult = detectMarkdown(richMarkdown);

      expect(richResult.score).toBeGreaterThan(simpleResult.score);
    });
  });

  describe('real-world examples', () => {
    it('should detect GitHub README content', () => {
      const readme = `# My Project

A useful tool for developers.

## Installation

\`\`\`bash
npm install my-project
\`\`\`

## Usage

\`\`\`javascript
import { myFunction } from 'my-project';
myFunction();
\`\`\`

## License

MIT
`;
      expect(isLikelyMarkdown(readme)).toBe(true);
    });

    it('should detect documentation with inline code and links', () => {
      const docs = `The \`process.env\` object contains environment variables.

For more information, see the [Node.js documentation](https://nodejs.org/api/process.html).

Example:

\`\`\`javascript
console.log(process.env.NODE_ENV);
\`\`\`
`;
      expect(isLikelyMarkdown(docs)).toBe(true);
    });

    it('should NOT detect plain prose', () => {
      const prose = `This is a simple paragraph of text that happens to have no markdown formatting at all. It's just regular prose that someone might write in a plain text editor or copy from a document.`;
      expect(isLikelyMarkdown(prose)).toBe(false);
    });

    it('should NOT detect JavaScript code', () => {
      const code = `function calculate(x, y) {
  const result = x * y;
  return result;
}

const value = calculate(5, 10);
console.log(value);
`;
      expect(isLikelyMarkdown(code)).toBe(false);
    });

    it('should NOT detect JSON data', () => {
      const json = `{
  "name": "test",
  "version": "1.0.0",
  "description": "A test package"
}`;
      expect(isLikelyMarkdown(json)).toBe(false);
    });
  });
});
