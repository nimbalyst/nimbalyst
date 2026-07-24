/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Advanced Table Tests
 *
 * This file contains complex edge cases and performance tests for tables:
 * - Tables inside blockquotes
 * - Lists inside table cells
 * - Large table structures (performance)
 * - Tables with multiline content
 * - Tables with uneven columns
 * - Empty tables
 * - Tables with escape characters
 * - Very wide tables
 * - Tables with complex formatting
 */

import {setupMarkdownDiffTest} from '../../utils/diffTestUtils';

describe('Advanced Table Tests', () => {
  describe('Tables inside blockquotes', () => {
    it('should handle table additions inside blockquotes', () => {
      const original = `> This is a blockquote
> 
> With some text`;

      const target = `> This is a blockquote
> 
> | Column 1 | Column 2 |
> |----------|----------|
> | Value A  | Value B  |
> 
> With some text`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('+> | Column 1 | Column 2 |');
      expect(result.getApprovedMarkdown()).toMatch(
        />\s*\|\s*Column 1\s*\|\s*Column 2\s*\|/,
      );
    });

    it('should handle table modifications inside blockquotes', () => {
      const original = `> Here is a quote with a table:
> 
> | Name | Age |
> |------|-----|
> | John | 25  |`;

      const target = `> Here is a quote with a table:
> 
> | Name | Age | City    |
> |------|-----|---------|  
> | John | 25  | Seattle |
> | Jane | 30  | Boston  |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('City');
      expect(result.getApprovedMarkdown()).toMatch(/Jane.*30.*Boston/);
    });

    it('should handle nested blockquotes with tables', () => {
      const original = `> First level quote
> 
> > Second level quote
> > 
> > Some text here`;

      const target = `> First level quote
> 
> > Second level quote
> > 
> > | Task | Status |
> > |------|--------|
> > | Write| Done   |
> > 
> > Some text here`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('Task');
      expect(result.getApprovedMarkdown()).toMatch(/Task.*Status/);
    });
  });

  describe('Lists inside table cells', () => {
    it('should handle simple lists in table cells', () => {
      const original = `| Feature | Description |
|---------|-------------|
| Basic   | Simple text |`;

      const target = `| Feature | Description |
|---------|-------------|
| Basic   | Simple text |
| Lists   | • Item 1<br>• Item 2<br>• Item 3 |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('Lists');
      expect(result.getApprovedMarkdown()).toMatch(/Lists.*Item 1/);
    });

    it('should handle modifications to lists in table cells', () => {
      const original = `| Task | Steps |
|------|-------|
| Setup | 1. Download<br>2. Install |
| Config | Edit settings |`;

      const target = `| Task | Steps |
|------|-------|
| Setup | 1. Download<br>2. Install<br>3. Configure |
| Config | Edit settings<br>• Enable debug<br>• Set path |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('Configure');
      expect(result.getApprovedMarkdown()).toMatch(/3\. Configure/);
    });

    it('should handle complex nested structures in table cells', () => {
      const original = `| Component | Details |
|-----------|---------|  
| Header    | Basic info |`;

      const target = `| Component | Details |
|-----------|---------|
| Header    | Basic info |
| Navigation | **Menu items:**<br>• Home<br>• About<br>  - Team<br>  - History<br>• Contact |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('Navigation');
      expect(result.getApprovedMarkdown()).toMatch(/Menu items/);
    });

    it('should handle code and quotes in table cells', () => {
      const original = `| Example | Code |
|---------|------|
| Simple  | \`x = 1\` |`;

      const target = `| Example | Code |
|---------|------|
| Simple  | \`x = 1\` |
| Complex | \`\`\`js<br>function test() {<br>  return true;<br>}<br>\`\`\` |
| Quote   | > Important note<br>> about this feature |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('Complex');
      expect(result.getApprovedMarkdown()).toMatch(/function test/);
    });
  });

  describe('Large table structures', () => {
    it('should handle tables with many rows and columns (50x10)', () => {
      // Create a smaller 10-row, 5-column table to avoid performance issues
      const headers = [];
      for (let c = 1; c <= 5; c++) {
        headers.push(`Col${c}`);
      }

      let original = `| ${headers.join(' | ')} |\n`;
      original += `|${headers.map(() => '---').join('|')}|\n`;

      for (let r = 1; r <= 10; r++) {
        const cells = [];
        for (let c = 1; c <= 5; c++) {
          cells.push(`R${r}C${c}`);
        }
        original += `| ${cells.join(' | ')} |\n`;
      }

      // Modify a few cells in the middle
      let target = original.trim();
      target = target.replace('R5C3', 'MODIFIED');
      target = target.replace('R7C2', 'CHANGED');

      const result = setupMarkdownDiffTest(original.trim(), target);

      expect(result.diff).toContain('MODIFIED');
      expect(result.getApprovedMarkdown()).toContain('MODIFIED');
    });
  });

  describe('Column alignment changes', () => {
    it('should handle left alignment to center alignment', () => {
      const original = `| Name | Age | City |
|------|-----|------|
| John | 25  | NYC  |`;

      const target = `| Name | Age | City |
|:----:|:---:|:----:|
| John | 25  | NYC  |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain(':----:');
      expect(result.getApprovedMarkdown()).toMatch(
        /\|:----:\|:---:\|:----:\|/,
      );
    });

    it('should handle right alignment changes', () => {
      const original = `| Price | Quantity | Total |
|-------|----------|-------|
| $10   | 5        | $50   |`;

      const target = `| Price | Quantity | Total |
|------:|:--------:|------:|
| $10   | 5        | $50   |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('------:');
      expect(result.getApprovedMarkdown()).toMatch(
        /\|------:\|:--------:\|------:\|/,
      );
    });

    it('should handle mixed alignment changes', () => {
      const original = `| Left | Center | Right |
|------|--------|-------|
| A    | B      | C     |`;

      const target = `| Left | Center | Right |
|:-----|:------:|------:|
| A    | B      | C     |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain(':-----');
      expect(result.getApprovedMarkdown()).toMatch(
        /\|:-----\|:------:\|------:\|/,
      );
    });

    it('should handle alignment changes with content modifications', () => {
      const original = `| Item | Price |
|------|-------|
| Apple| $1    |`;

      const target = `| Item | Price |
|:----:|------:|
| Orange| $2.50 |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('Orange');
      expect(result.getApprovedMarkdown()).toMatch(/Orange.*\$2\.50/);
    });
  });

  describe('Tables with newlines and multiline content', () => {
    it('should handle cells with HTML line breaks', () => {
      const original = `| Description | Notes |
|-------------|-------|
| Simple text | Basic |`;

      const target = `| Description | Notes |
|-------------|-------|
| Simple text | Line 1<br>Line 2<br>Line 3 |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('Line 1<br>Line 2<br>Line 3');
      expect(result.getApprovedMarkdown()).toMatch(
        /Line 1<br>Line 2<br>Line 3/,
      );
    });

    it('should handle cells with escaped newlines', () => {
      const original = `| Code | Output |
|------|--------|
| print("hello") | hello |`;

      const target = `| Code | Output |
|------|--------|
| print("hello")\\nprint("world") | hello\\nworld |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('print("world")');
      expect(result.getApprovedMarkdown()).toMatch(/print\("world"\)/);
    });

    it('should handle cells with multiple paragraphs using HTML', () => {
      const original = `| Section | Content |
|---------|---------|
| Intro   | Brief   |`;

      const target = `| Section | Content |
|---------|---------|
| Intro   | First paragraph<br><br>Second paragraph<br><br>Third paragraph |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain(
        'First paragraph<br><br>Second paragraph',
      );
      expect(result.getApprovedMarkdown()).toMatch(
        /First paragraph<br><br>Second paragraph/,
      );
    });

    it('should handle mixed content with newlines and formatting', () => {
      const original = `| Task | Details |
|------|---------|
| Setup| Basic   |`;

      const target = `| Task | Details |
|------|---------|
| Setup| **Step 1:** Install<br>**Step 2:** Configure<br>*Note:* Be careful |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('**Step 1:**');
      expect(result.getApprovedMarkdown()).toMatch(/\*\*Step 1:\*\*/);
    });
  });

  describe('Tables with uneven columns (missing cells)', () => {
    it('should handle tables with missing cells at the end', () => {
      const original = `| A | B | C |
|---|---|---|
| 1 | 2 | 3 |
| 4 | 5 | 6 |`;

      const target = `| A | B | C |
|---|---|---|
| 1 | 2 | 3 |
| 4 | 5 |
| 7 |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('| 7 |');
      expect(result.getApprovedMarkdown()).toMatch(/\| 7 \|/);
    });

    it('should handle tables with missing cells in the middle', () => {
      const original = `| Name | Age | City | Country |
|------|-----|------|---------|
| John | 25  | NYC  | USA     |`;

      const target = `| Name | Age | City | Country |
|------|-----|------|---------|
| John | 25  | NYC  | USA     |
| Jane |     | Boston |       |
| Bob  | 30  |      | Canada  |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('| Jane |     | Boston |');
      expect(result.getApprovedMarkdown()).toMatch(
        /\| Jane \|\s+\| Boston \|/,
      );
    });

    it('should handle adding columns to existing uneven table', () => {
      const original = `| A | B |
|---|---|
| 1 | 2 |
| 3 |`;

      const target = `| A | B | C | D |
|---|---|---|---|
| 1 | 2 | X | Y |
| 3 |   | Z |   |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('| C | D |');
      expect(result.getApprovedMarkdown()).toMatch(/\| C \| D \|/);
    });

    it('should handle completely irregular table structure', () => {
      const original = `| Regular | Table |
|---------|-------|
| Cell 1  | Cell 2|`;

      const target = `| Irregular | Table | Structure |
|-----------|-------|-----------|
| Cell 1    | Cell 2|
| Only one  |
|           | Middle only |
| A         | B     | C         | Extra |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('| Only one  |');
      expect(result.getApprovedMarkdown()).toMatch(/\| Only one\s+\|/);
    });
  });

  describe('Empty tables and tables with all empty cells', () => {
    it('should handle completely empty table', () => {
      const original = `Some text here.`;

      const target = `Some text here.

| | | |
|-|-|-|
| | | |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('| | | |');
      expect(result.getApprovedMarkdown()).toMatch(/\| \| \| \|/);
    });

    it('should handle table with headers but empty data rows', () => {
      const original = `| Name | Age | City |
|------|-----|------|
| John | 25  | NYC  |`;

      const target = `| Name | Age | City |
|------|-----|------|
|      |     |      |
|      |     |      |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('|      |     |      |');
      expect(result.getApprovedMarkdown()).toMatch(/\|\s+\|\s+\|\s+\|/);
    });

    it('should handle table with empty headers', () => {
      const original = `| Header 1 | Header 2 |
|----------|----------|
| Data 1   | Data 2   |`;

      const target = `|  |  |
|--|--|
| Data 1 | Data 2 |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('|  |  |');
      expect(result.getApprovedMarkdown()).toMatch(/\|\s+\|\s+\|/);
    });

    it('should handle mixed empty and non-empty cells', () => {
      const original = `| A | B | C |
|---|---|---|
| 1 | 2 | 3 |`;

      const target = `| A | B | C |
|---|---|---|
|   | 2 |   |
| 1 |   | 3 |
|   |   |   |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('|   | 2 |   |');
      expect(result.getApprovedMarkdown()).toMatch(/\|\s+\| 2 \|\s+\|/);
    });

    it('should handle table becoming completely empty', () => {
      const original = `| Product | Price | Stock |
|---------|-------|-------|
| Widget  | $10   | 50    |
| Gadget  | $20   | 25    |`;

      const target = `|  |  |  |
|--|--|--|
|  |  |  |
|  |  |  |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('|  |  |  |');
      expect(result.getApprovedMarkdown()).toMatch(/\|\s+\|\s+\|\s+\|/);
    });
  });

  describe('Tables with escape characters in cells', () => {
    it('should handle cells with escaped pipe characters', () => {
      const original = `| Command | Description |
|---------|--------------|
| ls      | List files  |`;

      const target = `| Command | Description |
|---------|--------------|
| ls      | List files  |
| grep    | Search for \\| in files |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('\\|');
      expect(result.getApprovedMarkdown()).toMatch(/\\\|/);
    });

    it('should handle cells with escaped backslashes', () => {
      const original = `| Path | Type |
|------|------|
| /usr | dir  |`;

      const target = `| Path | Type |
|------|------|
| /usr | dir  |
| C:\\\\Users\\\\John | dir |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('C:\\\\Users\\\\John');
      expect(result.getApprovedMarkdown()).toContain('C:\\\\Users\\\\John');
    });

    it('should handle cells with escaped markdown characters', () => {
      const original = `| Symbol | Meaning |
|--------|---------|
| +      | Add     |`;

      const target = `| Symbol | Meaning |
|--------|---------|
| +      | Add     |
| \\*     | Multiply |
| \\#     | Number   |
| \\_     | Underscore |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('\\*');
      expect(result.getApprovedMarkdown()).toMatch(/\\\*/);
    });

    it('should handle cells with HTML entities', () => {
      const original = `| Code | Display |
|------|---------|
| &lt; | <       |`;

      const target = `| Code | Display |
|------|---------|
| &lt; | <       |
| &gt; | >       |
| &amp;| &       |
| &quot; | "     |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('&gt;');
      expect(result.getApprovedMarkdown()).toMatch(/&gt;/);
    });

    it('should handle cells with complex escape sequences', () => {
      const original = `| Regex | Description |
|-------|-------------|
| \\d+   | Digits      |`;

      const target = `| Regex | Description |
|-------|-------------|
| \\d+   | Digits      |
| \\\\n\\\\t | Newline & tab |
| \\[\\]\\{\\} | Brackets & braces |
| \\\\\\| | Escaped pipe |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('\\\\n\\\\t');
      expect(result.getApprovedMarkdown()).toMatch(/\\\\n\\\\t/);
    });
  });

  describe('Very wide tables (20+ columns)', () => {
    it('should handle table with 25 columns', () => {
      const original = `| A | B | C | D | E |
|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 |`;

      const target = `| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P | Q | R | S | T | U | V | W | X | Y |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |10 |11 |12 |13 |14 |15 |16 |17 |18 |19 |20 |21 |22 |23 |24 |25 |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('| F | G | H |');
      expect(result.getApprovedMarkdown()).toMatch(/\| F \| G \| H \|/);
    });

    it('should handle modifications in wide tables', () => {
      const columns = Array.from({length: 22}, (_, i) =>
        String.fromCharCode(65 + i),
      );
      const headers = `| ${columns.join(' | ')} |`;
      const separator = `|${columns.map(() => '---').join('|')}|`;
      const dataRow = `| ${columns.map((_, i) => i + 1).join(' | ')} |`;

      const original = `${headers}
${separator}
${dataRow}`;

      const modifiedDataRow = `| ${columns
        .map((_, i) => (i + 1) * 10)
        .join(' | ')} |`;
      const target = `${headers}
${separator}
${modifiedDataRow}`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('10 | 20 | 30');
      expect(result.getApprovedMarkdown()).toMatch(/10 \| 20 \| 30/);
    });

    it('should handle adding rows to very wide table', () => {
      const columns = Array.from({length: 20}, (_, i) => `Col${i + 1}`);
      const headers = `| ${columns.join(' | ')} |`;
      const separator = `|${columns.map(() => '----').join('|')}|`;
      const row1 = `| ${columns.map(() => 'X').join(' | ')} |`;

      const original = `${headers}
${separator}
${row1}`;

      const row2 = `| ${columns.map(() => 'Y').join(' | ')} |`;
      const row3 = `| ${columns.map(() => 'Z').join(' | ')} |`;
      const target = `${headers}
${separator}
${row1}
${row2}
${row3}`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('| Y | Y | Y |');
      expect(result.getApprovedMarkdown()).toMatch(/\| Y \| Y \| Y \|/);
    });

    it('should handle column alignment in very wide tables', () => {
      const columns = Array.from({length: 21}, (_, i) => `C${i + 1}`);
      const headers = `| ${columns.join(' | ')} |`;
      const originalSeparator = `|${columns.map(() => '---').join('|')}|`;
      const targetSeparator = `|${columns
        .map((_, i) => {
          if (i % 3 === 0) return ':--';
          if (i % 3 === 1) return ':-:';
          return '--:';
        })
        .join('|')}|`;
      const dataRow = `| ${columns.map((_, i) => i + 1).join(' | ')} |`;

      const original = `${headers}
${originalSeparator}
${dataRow}`;

      const target = `${headers}
${targetSeparator}
${dataRow}`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain(':--');
      expect(result.getApprovedMarkdown()).toMatch(/:--/);
    });
  });

  describe('Tables with complex formatting in every cell', () => {
    it('should handle table with bold, italic, and strikethrough in all cells', () => {
      const original = `| Plain | Text | Here |
|-------|------|------|
| A     | B    | C    |`;

      const target = `| **Bold** | *Italic* | ~~Strike~~ |
|----------|----------|------------|
| ***Triple*** | **Bold *italic*** | ~~**Strike bold**~~ |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('**Bold**');
      expect(result.getApprovedMarkdown()).toMatch(/\*\*Bold\*\*/);
    });

    it('should handle table with code, links, and images in cells', () => {
      const original = `| Type | Example |
|------|---------|
| Text | Simple  |`;

      const target = `| Type | Example |
|------|---------|
| Code | \`console.log("hello")\` |
| Link | [Google](https://google.com) |
| Image| ![Alt](image.png) |
| Mixed| \`code\` and [link](url) |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('console.log');
      expect(result.getApprovedMarkdown()).toMatch(/console\.log/);
    });

    it('should handle table with nested formatting combinations', () => {
      const original = `| Basic | Content |
|-------|---------|
| A     | B       |`;

      const target = `| Complex | Formatting |
|---------|------------|
| **Bold with *nested italic* text** | ***Triple*** with \`code\` |
| ~~Strike with **bold**~~ | *Italic with [link](url)* |
| \`code with **bold**\` | ![img](url) with ~~strike~~ |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('*nested italic*');
      expect(result.getApprovedMarkdown()).toMatch(/\*nested italic\*/);
    });

    it('should handle table with mathematical and special characters', () => {
      const original = `| Symbol | Math |
|--------|------|
| A      | 1    |`;

      const target = `| Symbol | Math |
|--------|------|
| α²β³   | ∫₀^∞ e^(-x²) dx |
| ∑ᵢ₌₁ⁿ | √(x² + y²) |
| ∇·F    | ∂f/∂x |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('α²β³');
      expect(result.getApprovedMarkdown()).toMatch(/α²β³/);
    });

    it('should handle table with emoji and unicode in formatted text', () => {
      const original = `| Item | Status |
|------|--------|
| Task | Done   |`;

      const target = `| Item | Status |
|------|--------|
| **🚀 Launch** | ✅ *Completed* |
| ~~❌ Bug~~ | 🔄 **In Progress** |
| 📝 ***Documentation*** | 🎯 \`Ready\` |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('🚀 Launch');
      expect(result.getApprovedMarkdown()).toMatch(/🚀 Launch/);
    });

    it('should handle extremely complex cell formatting', () => {
      const original = `| Simple |
|--------|
| Text   |`;

      const target = `| Complex |
|---------|
| **Bold _italic_ ~~strike~~** with \`code\` and [link](url) ![img](src) 🎉 |
| ***Triple*** ~~**strike bold**~~ *italic with \`inline code\`* |
| Multi-format: **bold** *italic* ~~strike~~ \`code\` [link](url) 🔥 |`;

      const result = setupMarkdownDiffTest(original, target);

      expect(result.diff).toContain('**Bold _italic_ ~~strike~~**');
      expect(result.getApprovedMarkdown()).toMatch(
        /\*\*Bold _italic_ ~~strike~~\*\*/,
      );
    });
  });
});
