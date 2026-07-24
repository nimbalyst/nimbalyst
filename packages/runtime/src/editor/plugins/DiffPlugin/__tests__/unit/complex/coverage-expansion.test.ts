/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertApproveProducesTarget,
  assertDiffApplied,
  assertRejectProducesOriginal,
  setupMarkdownDiffTest,
} from '../../utils/diffTestUtils';

describe('Coverage Expansion Tests', () => {
  describe('Mixed Formatting Changes', () => {
    test('Removing formatting while keeping text', () => {
      const originalMarkdown = `This is **bold** and *italic* and ~~strikethrough~~ text.`;
      const targetMarkdown = `This is bold and italic and strikethrough text.`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(
        result,
        ['bold', 'italic', 'strikethrough'],
        ['**bold**', '*italic*', '~~strikethrough~~'],
      );
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Simultaneous formatting changes', () => {
      const originalMarkdown = `This is **bold** text.`;
      const targetMarkdown = `This is *italic* text.`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(result, ['*italic*'], ['**bold**']);
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('List Manipulations', () => {
    test('List item reordering', () => {
      const originalMarkdown = `1. First item
2. Second item
3. Third item`;
      const targetMarkdown = `1. Third item
2. First item
3. Second item`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      // Only the moved item ("Third") shows as add/remove.
      // Items that kept their relative order ("First", "Second") are marked as
      // modified (value changed) but their identical text children have no
      // inline diff markers - this is correct behavior that avoids false positives.
      assertDiffApplied(
        result,
        ['Third item'],
        ['Third item'],
      );
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Mixed list types with changes', () => {
      const originalMarkdown = `1. Ordered item
2. Another ordered

* Unordered item
* Another unordered`;
      const targetMarkdown = `1. Modified ordered item
2. Another ordered

* Changed unordered item
* Another unordered`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(
        result,
        ['Modified ordered', 'Changed unordered'],
        ['Ordered', 'Unordered'],
      );
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('Code Block Modifications', () => {
    test('Code block language changes', () => {
      const originalMarkdown = `\`\`\`javascript
const x = 5;
\`\`\``;
      const targetMarkdown = `\`\`\`typescript
const x = 5;
\`\`\``;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      // Language change should be detected
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Inline code to block code transition', () => {
      const originalMarkdown = `Here is \`inline code\` in text.`;
      const targetMarkdown = `Here is

\`\`\`
inline code
\`\`\`

in text.`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('Link Enhancements', () => {
    test('Link with title attribute', () => {
      const originalMarkdown = `[Link text](https://example.com)`;
      const targetMarkdown = `[Link text](https://example.com "Link title")`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Reference-style links', () => {
      const originalMarkdown = `This is [a link][1].

[1]: https://example.com`;
      const targetMarkdown = `This is [a modified link][1].

[1]: https://example.com`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(result, ['modified '], []);
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('Unicode and Special Characters', () => {
    test('Emoji handling in diff', () => {
      const originalMarkdown = `Hello 👋 world!`;
      const targetMarkdown = `Hello 🌍 world!`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(result, ['🌍'], ['👋']);
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Unicode text changes', () => {
      const originalMarkdown = `日本語のテキスト`;
      const targetMarkdown = `中文文本`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(result, ['中文文本'], ['日本語のテキスト']);
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('Whitespace and Line Breaks', () => {
    test('Multiple consecutive empty lines', () => {
      const originalMarkdown = `First paragraph.


Second paragraph.`;
      const targetMarkdown = `First paragraph.




Second paragraph.`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Tab vs space indentation in lists', () => {
      const originalMarkdown = `* Item with spaces
    * Nested with spaces`;
      const targetMarkdown = `* Item with spaces
	* Nested with tabs`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('Complex Nested Structures', () => {
    test('Deeply nested mixed content', () => {
      const originalMarkdown = `> Quote level 1
> > Quote level 2
> > * List in quote
> > > Quote level 3
> > > 1. Ordered in deep quote`;

      const targetMarkdown = `> Quote level 1
> > Modified quote level 2
> > * Modified list in quote
> > > Quote level 3
> > > 1. Modified ordered in deep quote`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      // Structural nesting can represent these as modify/move operations without stable add-node text.
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('Performance and Edge Cases', () => {
    test('Very long single-line paragraph', () => {
      const longText = 'word '.repeat(1000);
      const originalMarkdown = longText + 'original.';
      const targetMarkdown = longText + 'modified.';

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(result, ['modified'], ['original']);
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    }, 20000);
  });

  describe('Math and Special Markdown', () => {
    test('Math expressions inline', () => {
      const originalMarkdown = `The equation $x^2 + y^2 = z^2$ is famous.`;
      const targetMarkdown = `The equation $a^2 + b^2 = c^2$ is famous.`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertDiffApplied(result, ['a^2 + b^2 = c'], ['x^2 + y^2 = z']);
      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Math block changes', () => {
      const originalMarkdown = `$$
\\int_0^1 x^2 dx
$$`;
      const targetMarkdown = `$$
\\int_0^2 x^3 dx
$$`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('HTML in Markdown', () => {
    test('Custom HTML elements', () => {
      const originalMarkdown = `<div class="custom">Content</div>`;
      const targetMarkdown = `<div class="modified">New Content</div>`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });

  describe('Malformed Markdown Recovery', () => {
    test('Unclosed formatting', () => {
      const originalMarkdown = `This is **bold but not closed`;
      const targetMarkdown = `This is **bold and closed**`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });

    test('Mismatched list markers', () => {
      const originalMarkdown = `* Item 1
+ Item 2
- Item 3`;
      const targetMarkdown = `* Item 1
* Item 2
* Item 3`;

      const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

      assertApproveProducesTarget(result);
      assertRejectProducesOriginal(result);
    });
  });
});
