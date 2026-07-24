/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {setupMarkdownDiffTest} from '../../utils/diffTestUtils';

describe('Comprehensive lexical-diff coverage tests', () => {
  // This file will be populated with tests by sub-agents
  // Each sub-agent will test a specific category of functionality

  describe('Complex Nested Structures', () => {
    // Tests for deeply nested content combinations

    // Table tests have been moved to advanced-tables.test.ts for better organization

    describe('Blockquotes inside lists', () => {
      it('should handle blockquotes added to list items', () => {
        const original = `1. First item
2. Second item
3. Third item`;

        const target = `1. First item
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

    describe('Blockquotes inside lists', () => {
      it('should handle blockquotes added to list items', () => {
        const original = `1. First item
2. Second item
3. Third item`;

        const target = `1. First item
2. Second item
   
   > This is a quote inside the second item
   > with multiple lines
   
3. Third item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('quote inside');
        expect(result.getApprovedMarkdown()).toMatch(/>\s*This is a quote/);
      });

      it('should handle nested list items with blockquotes', () => {
        const original = `- Main item
  - Sub item 1
  - Sub item 2`;

        const target = `- Main item
  - Sub item 1
    
    > Important note about sub item 1
    > This spans multiple lines
    
  - Sub item 2
    
    > Another note for sub item 2`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Important note');
        expect(result.getApprovedMarkdown()).toMatch(
          /Important note about sub item 1/,
        );
      });

      it('should handle complex ordered list with blockquotes', () => {
        const original = `1. Introduction
   - Background info
   - Context
2. Main content`;

        const target = `1. Introduction
   - Background info
     
     > Key insight: This changes everything
     > we know about the topic
     
   - Context
2. Main content
   
   > Summary of main points:
   > - Point A
   > - Point B`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Key insight');
        expect(result.getApprovedMarkdown()).toMatch(
          /Key insight.*changes everything/,
        );
      });
    });

    describe('Multiple levels of nested blockquotes', () => {
      it('should handle three levels of nested blockquotes', () => {
        const original = `> Level 1 quote
> 
> > Level 2 quote
> > Some content`;

        const target = `> Level 1 quote
> 
> > Level 2 quote
> > 
> > > Level 3 quote with new content
> > > This is deeply nested
> > 
> > Some content`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Level 3 quote');
        expect(result.getApprovedMarkdown()).toMatch(
          />\s*>\s*>\s*Level 3 quote/,
        );
      });

      it('should handle modifications in deeply nested blockquotes', () => {
        const original = `> Quote level 1
> 
> > Quote level 2
> > 
> > > Quote level 3
> > > Original text here
> > 
> > Back to level 2`;

        const target = `> Quote level 1
> 
> > Quote level 2
> > 
> > > Quote level 3
> > > Modified text with **bold** formatting
> > > And an additional line
> > 
> > Back to level 2`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Modified text');
        expect(result.getApprovedMarkdown()).toMatch(/Modified text.*bold/);
      });

      it('should handle mixed content in nested blockquotes', () => {
        const original = `> Main quote
> 
> Regular content
> 
> > Nested quote`;

        const target = `> Main quote
> 
> Regular content
> 
> > Nested quote
> > 
> > > Deep quote with:
> > > - List item 1
> > > - List item 2
> > >   - Sub item
> > > 
> > > And a paragraph`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Deep quote with');
        expect(result.getApprovedMarkdown()).toMatch(/Deep quote with:/);
      });
    });

    describe('Code blocks inside nested lists', () => {
      it('should handle code blocks in list items', () => {
        const original = `1. Setup instructions
2. Run the command
3. Verify results`;

        const target = `1. Setup instructions
2. Run the command
   
   \`\`\`bash
   npm install
   npm start
   \`\`\`
   
3. Verify results`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('npm install');
        expect(result.getApprovedMarkdown()).toMatch(/npm install/);
      });

      it('should handle code blocks in nested list items', () => {
        const original = `- Main task
  - Subtask A
  - Subtask B
    - Sub-subtask 1
    - Sub-subtask 2`;

        const target = `- Main task
  - Subtask A
    
    \`\`\`javascript
    const result = processData();
    console.log(result);
    \`\`\`
    
  - Subtask B
    - Sub-subtask 1
      
      \`\`\`python
      def helper_function():
          return "processed"
      \`\`\`
      
    - Sub-subtask 2`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('processData');
        expect(result.getApprovedMarkdown()).toMatch(
          /const result = processData/,
        );
      });

      it('should handle inline code and code blocks in complex lists', () => {
        const original = `1. Use the \`config\` option
   - Set \`debug: true\`
   - Set \`verbose: false\``;

        const target = `1. Use the \`config\` option
   - Set \`debug: true\`
   - Set \`verbose: false\`
   - Configure advanced options:
     
     \`\`\`json
     {
       "advanced": {
         "caching": true,
         "optimization": "aggressive"
       }
     }
     \`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Configure advanced');
        expect(result.getApprovedMarkdown()).toMatch(
          /Configure advanced options/,
        );
      });
    });

    // Lists inside table cells tests moved to advanced-tables.test.ts
  });

  describe('Unicode and Special Characters', () => {
    describe('RTL (Right-to-Left) text', () => {
      it('should handle Arabic text additions', () => {
        const original = `This is English text.`;

        const target = `This is English text.

هذا نص باللغة العربية وهو يُكتب من اليمين إلى اليسار.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('هذا نص باللغة العربية');
        expect(result.getApprovedMarkdown()).toMatch(/هذا نص باللغة العربية/);
      });

      it('should handle Hebrew text modifications', () => {
        const original = `English text
שלום עולם`;

        const target = `English text
שלום עולם חדש ומופלא`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('חדש ומופלא');
        expect(result.getApprovedMarkdown()).toMatch(/שלום עולם חדש ומופלא/);
      });

      it('should handle mixed LTR and RTL text', () => {
        const original = `Hello world`;

        const target = `Hello world and مرحبا بالعالم`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('مرحبا بالعالم');
        expect(result.getApprovedMarkdown()).toMatch(/مرحبا بالعالم/);
      });
    });

    describe('Emoji sequences and modifiers', () => {
      it('should handle basic emoji additions', () => {
        const original = `Hello world`;

        const target = `Hello world 👋🌍`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('👋🌍');
        expect(result.getApprovedMarkdown()).toMatch(/👋🌍/);
      });

      it('should handle emoji with skin tone modifiers', () => {
        const original = `Team members: 👋`;

        const target = `Team members: 👋🏽👋🏻👋🏿`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('👋🏽👋🏻👋🏿');
        expect(result.getApprovedMarkdown()).toMatch(/👋🏽👋🏻👋🏿/);
      });

      it('should handle ZWJ emoji sequences', () => {
        const original = `Family photo:`;

        const target = `Family photo: 👨‍👩‍👧‍👦 👨‍👨‍👧 👩‍👩‍👦‍👦`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('👨‍👩‍👧‍👦');
        expect(result.getApprovedMarkdown()).toMatch(/👨‍👩‍👧‍👦/);
      });

      it('should handle complex emoji sequences with flags', () => {
        const original = `Countries:`;

        const target = `Countries: 🇺🇸 🇬🇧 🇨🇦 🇯🇵 🇧🇷`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('🇺🇸');
        expect(result.getApprovedMarkdown()).toMatch(/🇺🇸.*🇬🇧/);
      });
    });

    describe('Mixed scripts in same paragraph', () => {
      it('should handle Latin + Chinese + Arabic mixture', () => {
        const original = `Simple text`;

        const target = `English 中文 العربية mixed together in one paragraph`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('中文');
        expect(result.getApprovedMarkdown()).toMatch(/English.*中文.*العربية/);
      });

      it('should handle Japanese Hiragana, Katakana, and Kanji', () => {
        const original = `Text content`;

        const target = `Text content ひらがな カタカナ 漢字 mixed script`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('ひらがな');
        expect(result.getApprovedMarkdown()).toMatch(
          /ひらがな.*カタカナ.*漢字/,
        );
      });

      it('should handle Cyrillic and Latin mix', () => {
        const original = `Original text`;

        const target = `Original text Русский English Español`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Русский');
        expect(result.getApprovedMarkdown()).toMatch(
          /Русский.*English.*Español/,
        );
      });
    });

    describe('Zero-width joiners and non-joiners', () => {
      it('should handle zero-width joiner (ZWJ) characters', () => {
        const original = `Text`;

        const target = `Text with‍invisible‍joiners`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('with‍invisible‍joiners');
        expect(result.getApprovedMarkdown()).toMatch(/with‍invisible‍joiners/);
      });

      it('should handle zero-width non-joiner (ZWNJ) characters', () => {
        const original = `Persian text`;

        const target = `Persian text می‌خوانم`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('می‌خوانم');
        expect(result.getApprovedMarkdown()).toMatch(/می‌خوانم/);
      });

      it('should handle word joiner characters', () => {
        const original = `Normal text`;

        const target = `Normal text with⁠word⁠joiners`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('with⁠word⁠joiners');
        expect(result.getApprovedMarkdown()).toMatch(/with⁠word⁠joiners/);
      });
    });

    describe('Surrogate pairs and combining characters', () => {
      it('should handle surrogate pairs correctly', () => {
        const original = `Basic text`;

        const target = `Basic text 𝕳𝖊𝖑𝖑𝖔 𝖂𝖔𝖗𝖑𝖉`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('𝕳𝖊𝖑𝖑𝖔');
        expect(result.getApprovedMarkdown()).toMatch(/𝕳𝖊𝖑𝖑𝖔/);
      });

      it('should handle combining diacritical marks', () => {
        const original = `Text`;

        const target = `Text with é̂ñ̃ǧ̌lı̂̂s̈̈h̆̊`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('é̂ñ̃ǧ̌lı̂̂s̈̈h̆̊');
        expect(result.getApprovedMarkdown()).toMatch(/é̂ñ̃ǧ̌lı̂̂s̈̈h̆̊/);
      });

      it('should handle combining characters with base letters', () => {
        const original = `Simple`;

        const target = `Simple a⃗ b⃗ c⃗ vectors`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('a⃗ b⃗ c⃗');
        expect(result.getApprovedMarkdown()).toMatch(/a⃗ b⃗ c⃗/);
      });
    });

    describe('Mathematical symbols and operators', () => {
      it('should handle mathematical operators', () => {
        const original = `Math equation:`;

        const target = `Math equation: ∫₀^∞ e^(-x²) dx = √π/2`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('∫₀^∞');
        expect(result.getApprovedMarkdown()).toMatch(/∫₀\^∞.*√π/);
      });

      it('should handle set theory symbols', () => {
        const original = `Set operations`;

        const target = `Set operations: A ∪ B ∩ C ⊆ D ∈ ℝ ∀x ∃y`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('∪ B ∩ C');
        expect(result.getApprovedMarkdown()).toMatch(/∪ B ∩ C ⊆ D/);
      });

      it('should handle Greek mathematical symbols', () => {
        const original = `Formula:`;

        const target = `Formula: Σᵢ₌₁ⁿ αᵢβᵢ = γδεζηθ`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Σᵢ₌₁ⁿ');
        expect(result.getApprovedMarkdown()).toMatch(/Σᵢ₌₁ⁿ.*αᵢβᵢ/);
      });

      it('should handle arrows and logical symbols', () => {
        const original = `Logic:`;

        const target = `Logic: A → B ↔ C ∧ D ∨ E ¬F ⊢ G`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('→ B ↔ C');
        expect(result.getApprovedMarkdown()).toMatch(/→ B ↔ C ∧ D/);
      });
    });

    describe('Invisible characters', () => {
      it('should handle zero-width space characters', () => {
        const original = `Normal text`;

        const target = `Normal​text​with​zero​width​spaces`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('text​with​zero');
        expect(result.getApprovedMarkdown()).toMatch(
          /text​with​zero​width​spaces/,
        );
      });

      it('should handle soft hyphen characters', () => {
        const original = `Long word`;

        const target = `Long word super­cali­fragi­listic­expi­ali­docious`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('super­cali­fragi');
        expect(result.getApprovedMarkdown()).toMatch(/super­cali­fragi­listic/);
      });

      it('should handle non-breaking space characters', () => {
        const original = `Text content`;

        const target = `Text content with non breaking spaces`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('non breaking');
        expect(result.getApprovedMarkdown()).toMatch(/non breaking spaces/);
      });

      it('should handle invisible separator characters', () => {
        const original = `Words`;

        const target = `Words with invisible separators`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('invisible separators');
        expect(result.getApprovedMarkdown()).toMatch(/invisible separators/);
      });

      it('should handle mixed invisible characters', () => {
        const original = `Clean text`;

        const target = `Clean​text with­mixed invisible chars`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('with­mixed');
        expect(result.getApprovedMarkdown()).toMatch(/with­mixed invisible/);
      });
    });

    describe('Extreme Unicode edge cases', () => {
      it('should handle normalization issues (NFC vs NFD)', () => {
        const original = `Text with café`; // NFC normalized (single character é)

        const target = `Text with cafe\u0301`; // NFD normalized (e + combining acute)

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/cafe/);
      });

      it('should handle Unicode private use areas', () => {
        const original = `Standard text`;

        const target = `Standard text with private use \uE000\uE001\uE002`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('private use');
        expect(result.getApprovedMarkdown()).toMatch(/private use/);
      });

      it('should handle maximum Unicode code points', () => {
        const original = `Text`;

        const target = `Text with max Unicode \u{10FFFF} \u{10FFFE}`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('max Unicode');
        expect(result.getApprovedMarkdown()).toMatch(/max Unicode/);
      });

      it('should handle bidirectional control characters', () => {
        const original = `Simple text`;

        const target = `Simple text with \u202D\u202Cbidi\u202C\u202E controls`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('bidi');
        expect(result.getApprovedMarkdown()).toMatch(/bidi.*controls/);
      });

      it('should handle variation selectors', () => {
        const original = `Text`;

        const target = `Text ︎\uFE0E\uFE0F variation selectors`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('variation');
        expect(result.getApprovedMarkdown()).toMatch(/variation selectors/);
      });

      it('should handle ideographic description characters', () => {
        const original = `Chinese`;

        const target = `Chinese ⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻ characters`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('⿰⿱⿲');
        expect(result.getApprovedMarkdown()).toMatch(/⿰⿱⿲.*characters/);
      });

      it('should handle extremely long combined character sequences', () => {
        const original = `Short`;

        const target = `Short a⃒⃓⃘⃙⃚⃐⃑⃔⃕⃖⃗⃛⃜⃝⃞⃟⃠⃡⃢⃣⃤⃥⃦⃪⃫⃨⃬⃭⃮⃯⃧⃩⃰ extreme combining`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('extreme');
        expect(result.getApprovedMarkdown()).toMatch(/extreme combining/);
      });

      it('should handle control characters in text', () => {
        const original = `Clean`;

        const target = `Clean\u0000\u0001\u0002\u0003\u0004\u0005 control chars`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('control chars');
        expect(result.getApprovedMarkdown()).toMatch(/control chars/);
      });

      it('should handle mixed script with complex boundaries', () => {
        const original = `Test`;

        const target = `Test नमस्ते🇮🇳中文🐉العربية👨‍👩‍👧‍👦Русский boundary mix`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('नमस्ते');
        expect(result.getApprovedMarkdown()).toMatch(
          /नमस्ते.*中文.*العربية.*Русский/,
        );
      });

      it('should handle zero-width characters between words', () => {
        const original = `Word boundary test`;

        const target = `Word​boundary‍test​with‌various​zero‍width‌chars`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('various');
        expect(result.getApprovedMarkdown()).toMatch(
          /various.*zero.*width.*chars/,
        );
      });
    });
  });

  describe('Performance Edge Cases', () => {
    // Tests for large documents and complex structures

    describe('Large documents', () => {
      it('should handle documents with 100+ paragraphs', () => {
        // Generate 150 paragraphs
        const paragraphs = [];
        for (let i = 1; i <= 150; i++) {
          paragraphs.push(
            `This is paragraph ${i} with some content that makes it substantial.`,
          );
        }
        const original = paragraphs.join('\n\n');

        // Change content in paragraphs 50, 75, and 100
        const targetParagraphs = [...paragraphs];
        targetParagraphs[49] =
          'This is paragraph 50 with MODIFIED content that makes it substantial.';
        targetParagraphs[74] =
          'This is paragraph 75 with UPDATED content that makes it substantial.';
        targetParagraphs[99] =
          'This is paragraph 100 with CHANGED content that makes it substantial.';
        const target = targetParagraphs.join('\n\n');

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('MODIFIED');
        expect(result.diff).toContain('UPDATED');
        expect(result.diff).toContain('CHANGED');
        expect(result.getApprovedMarkdown()).toContain('MODIFIED');
        expect(result.getApprovedMarkdown()).toContain('UPDATED');
        expect(result.getApprovedMarkdown()).toContain('CHANGED');
      }, 20000);
    });

    describe('Deeply nested structures', () => {
      it('should handle very deeply nested lists (20+ levels)', () => {
        // Create a 25-level deep nested list
        let original = '';
        let target = '';
        let indent = '';

        for (let i = 1; i <= 25; i++) {
          original += `${indent}- Level ${i} item\n`;
          target += `${indent}- Level ${i} ${
            i === 15 ? 'MODIFIED ' : ''
          }item\n`;
          indent += '  ';
        }

        const result = setupMarkdownDiffTest(original.trim(), target.trim());

        expect(result.diff).toContain('MODIFIED');
        expect(result.getApprovedMarkdown()).toContain(
          'Level 15 MODIFIED item',
        );
      });

      it('should handle deeply nested blockquotes', () => {
        // Create 20 levels of nested blockquotes
        let original = '';
        let target = '';
        let prefix = '';

        for (let i = 1; i <= 20; i++) {
          original += `${prefix}> Level ${i} quote\n`;
          target += `${prefix}> Level ${i} ${
            i === 10 ? 'UPDATED ' : ''
          }quote\n`;
          prefix += '> ';
        }

        const result = setupMarkdownDiffTest(original.trim(), target.trim());

        expect(result.diff).toContain('UPDATED');
        expect(result.getApprovedMarkdown()).toContain(
          'Level 10 UPDATED quote',
        );
      });
    });

    describe('Many inline formatting changes', () => {
      it('should handle 100+ bold/italic formatting changes', () => {
        const words = [];
        const targetWords = [];

        // Create 120 words, every 3rd word gets formatting
        for (let i = 1; i <= 120; i++) {
          const word = `word${i}`;
          words.push(word);

          if (i % 3 === 0) {
            // Add bold formatting to every 3rd word
            targetWords.push(`**${word}**`);
          } else if (i % 5 === 0) {
            // Add italic formatting to every 5th word (when not already bold)
            targetWords.push(`*${word}*`);
          } else {
            targetWords.push(word);
          }
        }

        const original = words.join(' ');
        const target = targetWords.join(' ');

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**word3**');
        expect(result.diff).toContain('*word5*');
        expect(result.getApprovedMarkdown()).toContain('**word6**');
        expect(result.getApprovedMarkdown()).toContain('*word10*');
      });

      it('should handle mixed formatting changes throughout document', () => {
        const segments = [];
        const targetSegments = [];

        // Create 50 segments with different formatting changes
        for (let i = 1; i <= 50; i++) {
          const text = `Segment ${i} contains important information`;
          segments.push(text);

          switch (i % 4) {
            case 0:
              targetSegments.push(`**${text}**`);
              break;
            case 1:
              targetSegments.push(`*${text}*`);
              break;
            case 2:
              targetSegments.push(`~~${text}~~`);
              break;
            default:
              targetSegments.push(text);
          }
        }

        const original = segments.join('\n\n');
        const target = targetSegments.join('\n\n');

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '**Segment 4 contains important information**',
        );
        expect(result.diff).toContain(
          '*Segment 5 contains important information*',
        );
        expect(result.getApprovedMarkdown()).toContain(
          '**Segment 8 contains important information**',
        );
      });
    });

    // Large table structures tests moved to advanced-tables.test.ts

    describe('Lists with many items', () => {
      it('should handle lists with hundreds of items', () => {
        const originalItems = [];
        const targetItems = [];

        // Create 200 list items
        for (let i = 1; i <= 200; i++) {
          const item = `- List item ${i} with descriptive content`;
          originalItems.push(item);

          // Modify items 50, 100, 150, and 200
          if ([50, 100, 150, 200].includes(i)) {
            targetItems.push(
              `- List item ${i} with ENHANCED descriptive content`,
            );
          } else {
            targetItems.push(item);
          }
        }

        const original = originalItems.join('\n');
        const target = targetItems.join('\n');

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('ENHANCED');
        expect(result.getApprovedMarkdown()).toContain(
          'List item 50 with ENHANCED',
        );
        expect(result.getApprovedMarkdown()).toContain(
          'List item 100 with ENHANCED',
        );
      }, 20000);

      it('should handle nested lists with many items', () => {
        let original = '';
        let target = '';

        // Create nested structure: 20 top-level items, each with 10 sub-items
        for (let i = 1; i <= 20; i++) {
          original += `- Top level item ${i}\n`;
          target += `- Top level item ${i}${i === 10 ? ' MODIFIED' : ''}\n`;

          for (let j = 1; j <= 10; j++) {
            original += `  - Sub item ${i}.${j}\n`;
            target += `  - Sub item ${i}.${j}${
              i === 15 && j === 5 ? ' UPDATED' : ''
            }\n`;
          }
        }

        const result = setupMarkdownDiffTest(original.trim(), target.trim());

        expect(result.diff).toContain('MODIFIED');
        expect(result.diff).toContain('UPDATED');
        expect(result.getApprovedMarkdown()).toContain(
          'Top level item 10 MODIFIED',
        );
        expect(result.getApprovedMarkdown()).toContain('Sub item 15.5 UPDATED');
      }, 20000);
    });

    describe('Documents with scattered changes', () => {
      it('should handle many small changes throughout large document', () => {
        // Create a large document with mixed content types
        const sections = [];
        const targetSections = [];

        for (let i = 1; i <= 30; i++) {
          let section = '';
          let targetSection = '';

          // Add a heading
          section += `# Section ${i}\n\n`;
          targetSection += `# Section ${i}${i % 5 === 0 ? ' UPDATED' : ''}\n\n`;

          // Add 3 paragraphs
          for (let p = 1; p <= 3; p++) {
            const para = `This is paragraph ${p} in section ${i}. It contains several sentences with meaningful content.`;
            section += `${para}\n\n`;
            targetSection += `${para}${
              i % 7 === 0 && p === 2 ? ' MODIFIED ENDING.' : ''
            }\n\n`;
          }

          // Add a list
          section += `- Item 1 for section ${i}\n- Item 2 for section ${i}\n- Item 3 for section ${i}\n\n`;
          targetSection += `- Item 1 for section ${i}${
            i % 8 === 0 ? ' ENHANCED' : ''
          }\n- Item 2 for section ${i}\n- Item 3 for section ${i}\n\n`;

          // Add a code block every 5th section
          if (i % 5 === 0) {
            section += `\`\`\`javascript\nfunction section${i}() {\n  return "original";\n}\n\`\`\`\n\n`;
            targetSection += `\`\`\`javascript\nfunction section${i}() {\n  return "modified";\n}\n\`\`\`\n\n`;
          }

          sections.push(section);
          targetSections.push(targetSection);
        }

        const original = sections.join('');
        const target = targetSections.join('');

        const result = setupMarkdownDiffTest(original.trim(), target.trim());

        expect(result.diff).toContain('UPDATED');
        expect(result.diff).toContain('MODIFIED ENDING');
        expect(result.diff).toContain('ENHANCED');
        expect(result.diff).toContain('modified');
        expect(result.getApprovedMarkdown()).toContain('Section 5 UPDATED');
        expect(result.getApprovedMarkdown()).toContain('MODIFIED ENDING');
      });

      it('should handle document with alternating content types and changes', () => {
        let original = '';
        let target = '';

        // Create 12 alternating sections of different types
        for (let i = 1; i <= 12; i++) {
          switch (i % 4) {
            case 1:
              // Paragraph
              original += `This is a paragraph number ${i} with standard content.\n\n`;
              target += `This is a paragraph number ${i} with ${
                i === 1 ? 'ENHANCED ' : ''
              }standard content.\n\n`;
              break;
            case 2:
              // List
              original += `- List item A for ${i}\n- List item B for ${i}\n\n`;
              target += `- List item A for ${i}${
                i === 2 ? ' MODIFIED' : ''
              }\n- List item B for ${i}\n\n`;
              break;
            case 3:
              // Quote
              original += `> This is a quote in section ${i}.\n\n`;
              target += `> This is a quote in section ${i}${
                i === 3 ? ' UPDATED' : ''
              }.\n\n`;
              break;
            case 0:
              // Code
              original += `\`\`\`\ncode example ${i}\noriginal line\n\`\`\`\n\n`;
              target += `\`\`\`\ncode example ${i}\n${
                i === 4 ? 'modified line' : 'original line'
              }\n\`\`\`\n\n`;
              break;
          }
        }

        const result = setupMarkdownDiffTest(original.trim(), target.trim());

        expect(result.diff).toContain('ENHANCED');
        expect(result.diff).toContain('MODIFIED');
        expect(result.diff).toContain('UPDATED');
        expect(result.diff).toContain('modified line');
        expect(result.getApprovedMarkdown()).toContain(
          'paragraph number 1 with ENHANCED',
        );
      });
    });
  });

  describe('Whitespace and Line Endings', () => {
    // Tests for whitespace handling

    describe('Mixed indentation (tabs vs spaces)', () => {
      it('should handle tabs vs spaces in same document', () => {
        const original = `List with spaces:
- Item 1 (spaces)
    - Sub item (4 spaces)
- Item 2 (spaces)`;

        const target = `List with mixed indentation:
- Item 1 (spaces)
\t- Sub item (tab)
- Item 2 (spaces)
\t\t- Deep item (2 tabs)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('mixed indentation');
        expect(result.getApprovedMarkdown()).toMatch(/mixed indentation/);
      });

      it('should handle converting spaces to tabs', () => {
        const original = `Code block with spaces:
\`\`\`python
def function():
    return "spaces"
\`\`\``;

        const target = `Code block with tabs:
\`\`\`python
def function():
\treturn "tabs"
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('tabs');
        expect(result.getApprovedMarkdown()).toMatch(/tabs/);
      });

      it('should handle mixed indentation in nested lists', () => {
        const original = `1. First level (spaces)
   - Second level (3 spaces)
     - Third level (5 spaces)`;

        const target = `1. First level (spaces)
\t- Second level (tab)
\t\t- Third level (2 tabs)
   - Mixed item (3 spaces)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Mixed item');
        expect(result.getApprovedMarkdown()).toMatch(/Mixed item/);
      });
    });

    describe('Inconsistent indentation levels', () => {
      it('should handle 3 spaces vs 4 spaces indentation', () => {
        const original = `List with 4-space indentation:
- Item 1
    - Sub item (4 spaces)
    - Another sub (4 spaces)`;

        const target = `List with mixed space indentation:
- Item 1
   - Sub item (3 spaces)
    - Another sub (4 spaces)
     - Deep item (5 spaces)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('mixed space');
        expect(result.getApprovedMarkdown()).toMatch(/mixed space/);
      });

      it('should handle inconsistent code block indentation', () => {
        const original = `1. Step one
    \`\`\`bash
    npm install
    \`\`\`
    
2. Step two`;

        const target = `1. Step one
   \`\`\`bash
   npm install
   npm start
   \`\`\`
    
2. Step two`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('npm start');
        expect(result.getApprovedMarkdown()).toMatch(/npm start/);
      });

      it('should handle blockquotes with inconsistent indentation', () => {
        const original = `> Quote level 1
>    Indented with 4 spaces
> 
> > Nested quote`;

        const target = `> Quote level 1
>   Indented with 2 spaces
>     Another line with 4 spaces
> 
> > Nested quote`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('2 spaces');
        expect(result.getApprovedMarkdown()).toMatch(/2 spaces/);
      });
    });

    describe('Windows (CRLF) vs Unix (LF) line endings', () => {
      it('should handle mixed CRLF and LF in same document', () => {
        const original = `First line (LF)\nSecond line (LF)\nThird line (LF)`;

        const target = `First line (LF)\nSecond line (CRLF)\r\nThird line (LF)\nFourth line (CRLF)\r\n`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Fourth line');
        expect(result.getApprovedMarkdown()).toMatch(/Fourth line/);
      });

      it('should handle CRLF in code blocks', () => {
        const original = `Code example:\n\`\`\`\nline1\nline2\n\`\`\``;

        const target = `Code example:\r\n\`\`\`\r\nline1\r\nline2\r\nline3\r\n\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('line3');
        expect(result.getApprovedMarkdown()).toMatch(/line3/);
      });

      it('should handle mixed line endings in list items', () => {
        const original = `- Item 1\n- Item 2\n- Item 3`;

        const target = `- Item 1\r\n- Item 2\n- Item 3\r\n- Item 4`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Item 4');
        expect(result.getApprovedMarkdown()).toMatch(/Item 4/);
      });

      it('should handle CRLF in table cells', () => {
        const original = `| Column 1 | Column 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |`;

        const target = `| Column 1 | Column 2 |\r\n|----------|----------|\r\n| Cell 1   | Cell 2   |\n| Cell 3   | Cell 4   |`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Cell 3');
        expect(result.getApprovedMarkdown()).toMatch(/Cell 3/);
      });
    });

    describe('Trailing whitespace variations', () => {
      it('should handle trailing spaces on some lines but not others', () => {
        const original = `Line 1 without trailing space
Line 2 without trailing space
Line 3 without trailing space`;

        const target = `Line 1 without trailing space
Line 2 with trailing space   
Line 3 without trailing space
Line 4 with trailing space     `;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('trailing space');
        expect(result.getApprovedMarkdown()).toMatch(/trailing space/);
      });

      it('should handle trailing tabs mixed with trailing spaces', () => {
        const original = `- List item 1
- List item 2
- List item 3`;

        const target = `- List item 1   
- List item 2\t\t
- List item 3
- List item 4\t   `;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('List item 4');
        expect(result.getApprovedMarkdown()).toMatch(/List item 4/);
      });

      it('should handle trailing whitespace in code blocks', () => {
        const original = `\`\`\`javascript
function test() {
  return true;
}
\`\`\``;

        const target = `\`\`\`javascript
function test() {   
  return true;\t
  console.log("debug");  
}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('console.log');
        expect(result.getApprovedMarkdown()).toMatch(/console\.log/);
      });

      it('should handle trailing whitespace in blockquotes', () => {
        const original = `> This is a quote
> without trailing space
> on any lines`;

        const target = `> This is a quote   
> with trailing space  
> on some lines
> but not others`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('but not others');
        expect(result.getApprovedMarkdown()).toMatch(/but not others/);
      });
    });

    describe('Multiple consecutive blank lines', () => {
      it('should handle 5+ consecutive blank lines', () => {
        const original = `First paragraph.

Second paragraph.`;

        const target = `First paragraph.




Third paragraph after 5 blank lines.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Third paragraph');
        expect(result.getApprovedMarkdown()).toMatch(/Third paragraph/);
      });

      it('should handle very long sequences of blank lines (10+)', () => {
        const original = `Start text.

End text.`;

        const target = `Start text.









Middle text after 10 blank lines.

End text.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Middle text');
        expect(result.getApprovedMarkdown()).toMatch(/Middle text/);
      });

      it('should handle blank lines with varying whitespace', () => {
        const original = `Paragraph 1.

Paragraph 2.`;

        const target = `Paragraph 1.
   
\t
  \t  
     

Paragraph 2 with blank lines containing whitespace above.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('containing whitespace');
        expect(result.getApprovedMarkdown()).toMatch(/containing whitespace/);
      });

      it('should handle multiple blank line sections', () => {
        const original = `Section 1.

Section 2.

Section 3.`;

        const target = `Section 1.



Section 2 after 3 blanks.




Section 3 after 4 blanks.

Section 4.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Section 4');
        expect(result.getApprovedMarkdown()).toMatch(/Section 4/);
      });
    });

    describe('Leading whitespace before list markers', () => {
      it('should handle spaces before unordered list markers', () => {
        const original = `Normal list:
- Item 1
- Item 2`;

        const target = `List with leading spaces:
 - Item 1 (1 space before)
  - Item 2 (2 spaces before)
   - Item 3 (3 spaces before)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('leading spaces');
        expect(result.getApprovedMarkdown()).toMatch(/leading spaces/);
      });

      it('should handle tabs before list markers', () => {
        const original = `1. First item
2. Second item`;

        const target = `\t1. First item (tab before)
\t\t2. Second item (2 tabs before)
3. Third item (no leading space)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Third item');
        expect(result.getApprovedMarkdown()).toMatch(/Third item/);
      });

      it('should handle mixed leading whitespace in nested lists', () => {
        const original = `- Main item
  - Sub item`;

        const target = ` - Main item (1 space)
\t  - Sub item (tab + 2 spaces)
   - Another main (3 spaces)
\t- Tab main item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Another main');
        expect(result.getApprovedMarkdown()).toMatch(/Another main/);
      });

      it('should handle leading whitespace in task lists', () => {
        const original = `- [ ] Task 1
- [x] Task 2`;

        const target = ` - [ ] Task 1 (1 space)
  - [x] Task 2 (2 spaces)
\t- [ ] Task 3 (tab)
   - [x] Task 4 (3 spaces)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Task 3');
        expect(result.getApprovedMarkdown()).toMatch(/Task 3/);
      });
    });

    describe('Whitespace-only lines between content', () => {
      it('should handle lines with only spaces between paragraphs', () => {
        const original = `First paragraph.

Second paragraph.`;

        const target = `First paragraph.
    
Second paragraph with spaces-only line above.

Third paragraph.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('spaces-only line');
        expect(result.getApprovedMarkdown()).toMatch(/spaces-only line/);
      });

      it('should handle lines with only tabs between content', () => {
        const original = `# Header 1

## Header 2`;

        const target = `# Header 1
\t\t
## Header 2 with tab-only line above

### Header 3`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('tab-only line');
        expect(result.getApprovedMarkdown()).toMatch(/tab-only line/);
      });

      it('should handle mixed whitespace-only lines', () => {
        const original = `> Quote block 1

> Quote block 2`;

        const target = `> Quote block 1
  \t  
> Quote block 2 with mixed whitespace above
   
> Quote block 3
\t \t \t
> Quote block 4`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Quote block 3');
        expect(result.getApprovedMarkdown()).toMatch(/Quote block 3/);
      });

      it('should handle whitespace-only lines in list structures', () => {
        const original = `1. First item

2. Second item`;

        const target = `1. First item
   
   Additional content for first item
     
2. Second item with whitespace above
\t  
3. Third item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Additional content');
        expect(result.getApprovedMarkdown()).toMatch(/Additional content/);
      });

      it('should handle whitespace-only lines in code blocks', () => {
        const original = `\`\`\`python
def function1():
    pass

def function2():
    pass
\`\`\``;

        const target = `\`\`\`python
def function1():
    pass
   
def function2():
    pass
\t  
def function3():
    pass
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('function3');
        expect(result.getApprovedMarkdown()).toMatch(/function3/);
      });

      it('should handle complex whitespace patterns between table rows', () => {
        const original = `| Col1 | Col2 |
|------|------|
| A    | B    |

| C    | D    |`;

        const target = `| Col1 | Col2 |
|------|------|
| A    | B    |
   
| C    | D    |
\t  
| E    | F    |`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('| E    | F    |');
        expect(result.getApprovedMarkdown()).toMatch(/\| E\s+\| F\s+\|/);
      });
    });
  });

  describe('Conflicting Format Changes', () => {
    // Tests for overlapping formatting

    describe('Overlapping bold and italic boundaries', () => {
      it('should handle bold starting in middle of italic', () => {
        const original = 'This text is *partially italic* here.';
        const target =
          'This text is *partially **bold and italic* only bold** here.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**bold and italic* only bold**');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*partially \*\*bold and italic\* only bold\*\*/,
        );
      });

      it('should handle italic starting in middle of bold', () => {
        const original = 'Some **bold text** exists.';
        const target = 'Some **bold *italic and bold** only italic* exists.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('*italic and bold** only italic*');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*bold \*italic and bold\*\* only italic\*/,
        );
      });

      it('should handle overlapping boundaries with different start/end points', () => {
        const original =
          'Text with *some italic* and **some bold** formatting.';
        const target =
          'Text with *some italic **and overlapping** bold* formatting.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**and overlapping**');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*some italic \*\*and overlapping\*\* bold\*/,
        );
      });

      it('should handle completely overlapping formatting regions', () => {
        const original = 'Some *italic text* here.';
        const target = 'Some ***completely overlapped*** here.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***completely overlapped***');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*completely overlapped\*\*\*/,
        );
      });
    });

    describe('Triple nested formatting', () => {
      it('should handle bold inside italic inside strikethrough', () => {
        const original = 'Normal text here.';
        const target =
          'Normal ~~*strikethrough and **bold and italic** only italic* only strikethrough~~ here.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '~~*strikethrough and **bold and italic** only italic* only strikethrough~~',
        );
        expect(result.getApprovedMarkdown()).toMatch(
          /~~\*strikethrough and \*\*bold and italic\*\* only italic\* only strikethrough~~/,
        );
      });

      it('should handle strikethrough inside bold inside italic', () => {
        const original = 'Text content.';
        const target =
          'Text *italic **bold ~~and strikethrough~~ only bold** only italic* content.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '*italic **bold ~~and strikethrough~~ only bold** only italic*',
        );
        expect(result.getApprovedMarkdown()).toMatch(
          /\*italic \*\*bold ~~and strikethrough~~ only bold\*\* only italic\*/,
        );
      });

      it('should handle complex nested overlapping boundaries', () => {
        const original = 'Original text.';
        const target =
          'Original *start **overlap ~~all three~~ just bold** just italic* text.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '*start **overlap ~~all three~~ just bold** just italic*',
        );
        expect(result.getApprovedMarkdown()).toMatch(
          /\*start \*\*overlap ~~all three~~ just bold\*\* just italic\*/,
        );
      });

      it('should handle misaligned triple formatting boundaries', () => {
        const original = 'Base content.';
        const target =
          'Base ~~strike *italic **bold middle** italic continues~~ strike ends* content.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '~~strike *italic **bold middle** italic continues~~ strike ends*',
        );
        expect(result.getApprovedMarkdown()).toMatch(
          /~~strike \*italic \*\*bold middle\*\* italic continues~~ strike ends\*/,
        );
      });
    });

    describe('Format changes across paragraph boundaries', () => {
      it('should handle bold spanning multiple paragraphs', () => {
        const original = `First paragraph.

Second paragraph.`;

        const target = `First **bold paragraph.

Still bold** paragraph.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**bold paragraph.');
        expect(result.getApprovedMarkdown()).toMatch(/\*\*bold paragraph\./);
      });

      it('should handle italic across paragraph boundaries with lists', () => {
        const original = `Paragraph text.

- List item 1
- List item 2`;

        const target = `Paragraph *italic text.

- Still italic list item 1*
- List item 2`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('*italic text.');
        expect(result.getApprovedMarkdown()).toMatch(/\*italic text\./);
      });

      it('should handle formatting across blockquote boundaries', () => {
        const original = `Normal text.

> Quote content.`;

        const target = `Normal **bold text.

> Still bold quote** content.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**bold text.');
        expect(result.getApprovedMarkdown()).toMatch(/\*\*bold text\./);
      });

      it('should handle strikethrough across headers and text', () => {
        const original = `# Header Text

Paragraph content.`;

        const target = `# ~~Struck Header~~ Text

~~Still struck~~ content.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('~~Struck Header~~');
        expect(result.getApprovedMarkdown()).toMatch(/~~Struck Header~~/);
      });
    });

    describe('Removing formatting from middle of formatted text', () => {
      it('should handle removing bold from middle of bold text', () => {
        const original = 'Text with **completely bold text** here.';
        const target =
          'Text with **partially bold** normal **bold again** here.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('partially bold** normal **bold again');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*partially bold\*\* normal \*\*bold again\*\*/,
        );
      });

      it('should handle removing italic from middle of italic text', () => {
        const original = 'Some *entirely italic content* exists.';
        const target = 'Some *partial italic* normal *italic again* exists.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('partial italic* normal *italic again');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*partial italic\* normal \*italic again\*/,
        );
      });

      it('should handle removing strikethrough from middle', () => {
        const original = 'Text ~~all struck through~~ content.';
        const target =
          'Text ~~partially struck~~ normal ~~struck again~~ content.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          'partially struck~~ normal ~~struck again',
        );
        expect(result.getApprovedMarkdown()).toMatch(
          /~~partially struck~~ normal ~~struck again~~/,
        );
      });

      it('should handle removing formatting from nested structures', () => {
        const original = 'Text ***all three formats*** applied.';
        const target = 'Text ***partial*** normal ***restored*** applied.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***partial*** normal ***restored***');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*partial\*\*\* normal \*\*\*restored\*\*\*/,
        );
      });
    });

    describe('Adding formatting to already partially formatted text', () => {
      it('should handle adding bold to text with existing italic', () => {
        const original = 'Text with *some italic* content.';
        const target = 'Text with ***bold and italic*** content.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***bold and italic***');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*bold and italic\*\*\*/,
        );
      });

      it('should handle adding italic to text with existing bold', () => {
        const original = 'Content **bold text** here.';
        const target = 'Content ***bold and italic*** here.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***bold and italic***');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*bold and italic\*\*\*/,
        );
      });

      it('should handle adding strikethrough to bold and italic', () => {
        const original = 'Text ***bold and italic*** content.';
        const target = 'Text ~~***all three formats***~~ content.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('~~***all three formats***~~');
        expect(result.getApprovedMarkdown()).toMatch(
          /~~\*\*\*all three formats\*\*\*~~/,
        );
      });

      it('should handle partial overlapping additions', () => {
        const original = 'Start *italic text* and **bold text** end.';
        const target = 'Start ***overlapping italic and bold*** text** end.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***overlapping italic and bold***');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*overlapping italic and bold\*\*\*/,
        );
      });
    });

    describe('Conflicting format changes', () => {
      it('should handle one adds bold, other adds italic to same text', () => {
        const original = 'Simple text content.';
        const target = 'Simple ***bold and italic*** content.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***bold and italic***');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*bold and italic\*\*\*/,
        );
      });

      it('should handle conflicting additions at word boundaries', () => {
        const original = 'Word one two three.';
        const target = 'Word **one *two* three**.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**one *two* three**');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*one \*two\* three\*\*/,
        );
      });

      it('should handle strikethrough vs bold on same text', () => {
        const original = 'Normal text here.';
        const target = 'Normal ~~**struck and bold**~~ here.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('~~**struck and bold**~~');
        expect(result.getApprovedMarkdown()).toMatch(
          /~~\*\*struck and bold\*\*~~/,
        );
      });

      it('should handle complex conflicting nested changes', () => {
        const original = 'Text with *existing italic* content.';
        const target = 'Text with ~~*struck italic* and **bold**~~ content.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('~~*struck italic* and **bold**~~');
        expect(result.getApprovedMarkdown()).toMatch(
          /~~\*struck italic\* and \*\*bold\*\*~~/,
        );
      });
    });

    describe('Format boundary changes', () => {
      it('should handle extending bold region', () => {
        const original = 'Text **bold** more text.';
        const target = 'Text **bold extended** text.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**bold extended**');
        expect(result.getApprovedMarkdown()).toMatch(/\*\*bold extended\*\*/);
      });

      it('should handle shrinking italic region', () => {
        const original = 'Content *entire italic section* done.';
        const target = 'Content *partial* section done.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('*partial*');
        expect(result.getApprovedMarkdown()).toMatch(/\*partial\*/);
      });

      it('should handle shifting format boundaries', () => {
        const original = 'Text **bold start** normal **bold end** text.';
        const target = 'Text normal **shifted bold section** text.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**shifted bold section**');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*shifted bold section\*\*/,
        );
      });

      it('should handle merging separate formatted regions', () => {
        const original = 'Text *italic one* space *italic two* end.';
        const target = 'Text *italic merged section* end.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('*italic merged section*');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*italic merged section\*/,
        );
      });

      it('should handle splitting formatted regions', () => {
        const original = 'Text **long bold section** end.';
        const target = 'Text **first bold** normal **second bold** end.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**first bold** normal **second bold**');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*first bold\*\* normal \*\*second bold\*\*/,
        );
      });

      it('should handle complex boundary shifts with multiple formats', () => {
        const original = 'Start **bold *italic* bold** ~~strike~~ end.';
        const target = 'Start *italic **bold*** ~~extended strike~~ end.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('*italic **bold***');
        expect(result.getApprovedMarkdown()).toMatch(/\*italic \*\*bold\*\*\*/);
      });
    });

    describe('Complex edge cases with unaligned boundaries', () => {
      it('should handle asymmetric overlapping format changes', () => {
        const original = 'Text *italic start middle* end.';
        const target = 'Text *italic **bold middle end** italic* continues.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('*italic **bold middle end** italic*');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*italic \*\*bold middle end\*\* italic\*/,
        );
      });

      it('should handle cascading format boundary changes', () => {
        const original = 'Base **bold** *italic* ~~strike~~ text.';
        const target =
          'Base ***triple** still italic* ~~**bold strike**~~ text.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***triple** still italic*');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*triple\*\* still italic\*/,
        );
      });

      it('should handle interleaved format additions and removals', () => {
        const original = 'Text **bold** normal *italic* normal ~~strike~~ end.';
        const target =
          'Text normal **shifted bold** ~~*italic strike*~~ normal end.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('**shifted bold**');
        expect(result.getApprovedMarkdown()).toMatch(/\*\*shifted bold\*\*/);
      });

      it('should handle format changes that create ambiguous boundaries', () => {
        const original = 'Start *italic* **bold** text.';
        const target = 'Start ***combined italic bold*** text.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('***combined italic bold***');
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*\*combined italic bold\*\*\*/,
        );
      });

      it('should handle format preservation during content changes', () => {
        const original = 'Text **original bold content** here.';
        const target = 'Text **modified bold content with additions** here.';

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '**modified bold content with additions**',
        );
        expect(result.getApprovedMarkdown()).toMatch(
          /\*\*modified bold content with additions\*\*/,
        );
      });
    });
  });

  describe('List Edge Cases', () => {
    // Tests for complex list scenarios

    describe('Changing list start numbers', () => {
      it('should handle ordered lists starting at different numbers', () => {
        const original = `1. First item
2. Second item
3. Third item`;

        const target = `5. First item
6. Second item
7. Third item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('5. First item');
        expect(result.getApprovedMarkdown()).toMatch(/5\. First item/);
      });

      it('should handle changing start number from 1 to arbitrary number', () => {
        const original = `1. Introduction
2. Main content
3. Conclusion`;

        const target = `42. Introduction
43. Main content
44. Conclusion`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('42. Introduction');
        expect(result.getApprovedMarkdown()).toMatch(/42\. Introduction/);
      });

      it('should handle start number changes in nested lists', () => {
        const original = `1. Outer item
    1. Inner item A
    2. Inner item B
2. Another outer item`;

        const target = `1. Outer item
    10. Inner item A
    11. Inner item B
2. Another outer item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('10. Inner item A');
        expect(result.getApprovedMarkdown()).toMatch(/10\. Inner item A/);
      });

      it('should handle mixed start numbers across different list levels', () => {
        const original = `1. Level 1 start
   1. Level 2 start
      1. Level 3 start
   2. Level 2 continue
2. Level 1 continue`;

        const target = `3. Level 1 start
   7. Level 2 start
      15. Level 3 start
   8. Level 2 continue
4. Level 1 continue`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('3. Level 1 start');
        expect(result.getApprovedMarkdown()).toMatch(/3\. Level 1 start/);
      });
    });

    describe('Mixed task lists with regular lists', () => {
      it('should handle task list items mixed with regular unordered items', () => {
        const original = `- Regular item 1
- Regular item 2
- Regular item 3`;

        const target = `- [x] Completed task
- Regular item 2
- [ ] Incomplete task`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('- [x] Completed task');
        expect(result.getApprovedMarkdown()).toMatch(/- \[x\] Completed task/);
      });

      it('should handle task list conversion from regular lists', () => {
        const original = `1. First item
2. Second item
3. Third item`;

        const target = `- [x] First item
- [ ] Second item
- [x] Third item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('- [x] First item');
        expect(result.getApprovedMarkdown()).toMatch(/- \[x\] First item/);
      });

      it('should handle nested task lists with regular lists', () => {
        const original = `- Main item
  - Sub item 1
  - Sub item 2
    - Deep item`;

        const target = `- [x] Main item
  - [ ] Sub item 1
  - [x] Sub item 2
    - [ ] Deep item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('- [x] Main item');
        expect(result.getApprovedMarkdown()).toMatch(/- \[x\] Main item/);
      });

      it('should handle partial task list conversion in mixed structure', () => {
        const original = `- Regular unordered
1. Regular ordered
- Another unordered`;

        const target = `- [x] Task from unordered
1. Regular ordered
- [ ] Task from another unordered`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('- [x] Task from unordered');
        expect(result.getApprovedMarkdown()).toMatch(
          /- \[x\] Task from unordered/,
        );
      });
    });

    describe('List items with multiple paragraphs and block elements', () => {
      it('should handle list items with multiple paragraphs', () => {
        const original = `1. First item
2. Second item`;

        const target = `1. First item with content
   
   This is a second paragraph within the first item.
   
   And a third paragraph too.

2. Second item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('This is a second paragraph');
        expect(result.getApprovedMarkdown()).toMatch(
          /This is a second paragraph/,
        );
      });

      it('should handle list items with blockquotes', () => {
        const original = `- Item one
- Item two`;

        const target = `- Item one
  
  > This is a quote within the list item
  > spanning multiple lines
  
- Item two`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('> This is a quote');
        expect(result.getApprovedMarkdown()).toMatch(/> This is a quote/);
      });

      it('should handle list items with code blocks', () => {
        const original = `1. Setup
2. Configuration`;

        const target = `1. Setup
   
   \`\`\`bash
   npm install
   npm start
   \`\`\`
   
2. Configuration`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('npm install');
        expect(result.getApprovedMarkdown()).toMatch(/npm install/);
      });

      it('should handle list items with nested lists and paragraphs', () => {
        const original = `1. Main task
   - Sub task
2. Another main task`;

        const target = `1. Main task
   
   Some explanation paragraph.
   
   - Sub task with details
     
     Additional paragraph for sub task.
     
   - Another sub task
   
   Conclusion paragraph.

2. Another main task`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Some explanation paragraph');
        expect(result.getApprovedMarkdown()).toMatch(
          /Some explanation paragraph/,
        );
      });

      it('should handle list items with tables', () => {
        const original = `- First item
- Second item`;

        const target = `- First item
  
  | Column A | Column B |
  |----------|----------|
  | Value 1  | Value 2  |
  
- Second item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('| Column A | Column B |');
        expect(result.getApprovedMarkdown()).toMatch(
          /\| Column A \| Column B \|/,
        );
      });
    });

    describe('Deeply nested lists', () => {
      it('should handle 10+ levels of nested lists', () => {
        const original = `- Level 1
  - Level 2
    - Level 3
      - Level 4
        - Level 5`;

        const target = `- Level 1
  - Level 2
    - Level 3
      - Level 4
        - Level 5
          - Level 6
            - Level 7
              - Level 8
                - Level 9
                  - Level 10
                    - Level 11
                      - Level 12`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Level 12');
        expect(result.getApprovedMarkdown()).toMatch(/Level 12/);
      });

      it('should handle mixed ordered and unordered in deep nesting', () => {
        const original = `1. First
   - Sub first
     1. Sub ordered
       - Deep unordered`;

        const target = `1. First
   - Sub first
     1. Sub ordered
       - Deep unordered
         1. Even deeper ordered
           - And deeper unordered
             1. Deepest ordered
               - Deepest unordered
                 1. Super deep
                   - Ultra deep
                     1. Maximum depth`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Maximum depth');
        expect(result.getApprovedMarkdown()).toMatch(/Maximum depth/);
      });

      it('should handle modifications at different nesting levels', () => {
        const original = `1. Level 1
   - Level 2
     1. Level 3
       - Level 4
         1. Level 5`;

        const target = `1. Modified Level 1
   - Level 2
     1. Modified Level 3
       - Level 4
         1. Modified Level 5
           - Added Level 6
             1. Added Level 7`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Modified Level 1');
        expect(result.getApprovedMarkdown()).toMatch(/Modified Level 1/);
      });

      it('should handle collapsing deeply nested structures', () => {
        const original = `- Level 1
  - Level 2
    - Level 3
      - Level 4
        - Level 5
          - Level 6
            - Level 7
              - Deep content`;

        const target = `- Level 1
  - Level 2
    - Flattened content`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Flattened content');
        expect(result.getApprovedMarkdown()).toMatch(/Flattened content/);
      });
    });

    describe('Empty list items', () => {
      it('should handle empty list items at the beginning', () => {
        const original = `1. First item
2. Second item`;

        const target = `1. 
2. First item
3. Second item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/1\.\s*\n/);
      });

      it('should handle empty list items in the middle', () => {
        const original = `- Item one
- Item three`;

        const target = `- Item one
- 
- Item three`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/-\s*\n/);
      });

      it('should handle empty list items at the end', () => {
        const original = `1. First
2. Second`;

        const target = `1. First
2. Second
3. `;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('3. ');
        expect(result.getApprovedMarkdown()).toMatch(/3\.\s*$/);
      });

      it('should handle nested empty list items', () => {
        const original = `- Main item
  - Sub item`;

        const target = `- Main item
  - 
  - Sub item
  - `;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/-\s*\n/);
      });

      it('should handle conversion from content to empty', () => {
        const original = `1. Item with content
2. Another item with content`;

        const target = `1. 
2. `;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('1. ');
        expect(result.getApprovedMarkdown()).toMatch(/1\.\s*\n/);
      });
    });

    describe('Lists with only whitespace items', () => {
      it('should handle list items with only spaces', () => {
        const original = `- Item one
- Item two`;

        const target = `- Item one
-     
- Item two`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/-\s+\n/);
      });

      it('should handle list items with only tabs', () => {
        const original = `1. First
2. Second`;

        const target = `1. First
2. \t\t
3. Second`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/2\.\s+\n/);
      });

      it('should handle mixed whitespace in list items', () => {
        const original = `- Normal item`;

        const target = `- Normal item
-   \t  \t  
- \t\t\t
-      `;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/-\s+\n/);
      });

      it('should handle nested lists with whitespace-only items', () => {
        const original = `1. Main
   - Sub item`;

        const target = `1. Main
   -    
   - Sub item
   -  \t  `;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toMatch(/-\s+\n/);
      });

      it('should handle converting from whitespace to content', () => {
        const original = `- Item one
-    
- Item three`;

        const target = `- Item one
- Now has content
- Item three`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Now has content');
        expect(result.getApprovedMarkdown()).toMatch(/Now has content/);
      });
    });

    describe('List type changes at different nesting levels', () => {
      it('should handle ordered to unordered at root level', () => {
        const original = `1. First ordered
2. Second ordered
   1. Nested ordered
   2. Another nested`;

        const target = `- First unordered
- Second unordered
   1. Nested ordered
   2. Another nested`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('- First unordered');
        expect(result.getApprovedMarkdown()).toMatch(/- First unordered/);
      });

      it('should handle unordered to ordered at nested level', () => {
        const original = `- Main item
  - Nested unordered 1
  - Nested unordered 2
    - Deep unordered`;

        const target = `- Main item
  1. Nested ordered 1
  2. Nested ordered 2
    - Deep unordered`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('1. Nested ordered 1');
        expect(result.getApprovedMarkdown()).toMatch(/1\. Nested ordered 1/);
      });

      it('should handle task list to regular list conversion', () => {
        const original = `- [ ] Incomplete task
- [x] Complete task
  - [ ] Nested task`;

        const target = `1. Regular item 1
2. Regular item 2
  - Regular nested`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('1. Regular item 1');
        expect(result.getApprovedMarkdown()).toMatch(/1\. Regular item 1/);
      });

      it('should handle mixed type changes across multiple levels', () => {
        const original = `1. Ordered root
   - Unordered nested
     1. Deep ordered
       - Deeper unordered`;

        const target = `- Unordered root
   1. Ordered nested
     - Deep unordered
       1. Deeper ordered`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('- Unordered root');
        expect(result.getApprovedMarkdown()).toMatch(/- Unordered root/);
      });

      it('should handle type changes with content modifications', () => {
        const original = `1. Original ordered item
   - Original nested item`;

        const target = `- Modified unordered item
   1. Modified nested ordered item`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Modified unordered item');
        expect(result.getApprovedMarkdown()).toMatch(/Modified unordered item/);
      });

      it('should handle complex type changes with additions and deletions', () => {
        const original = `1. Keep this ordered
2. Change this to unordered
   - Keep this nested unordered
   - Delete this nested`;

        const target = `1. Keep this ordered
- Change this to unordered
   - Keep this nested unordered
   1. Add this nested ordered
- Add new root unordered`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('- Change this to unordered');
        expect(result.getApprovedMarkdown()).toMatch(
          /- Change this to unordered/,
        );
      });
    });
  });

  // Table Complex Scenarios tests moved to advanced-tables.test.ts

  describe('Link and Reference Edge Cases', () => {
    // Tests for link handling

    describe('Reference-style links with identical text but different URLs', () => {
      it('should handle reference links with same text different URLs', () => {
        const original = `Check out [Google][1] for search.

[1]: https://google.com`;

        const target = `Check out [Google][1] for search.

[1]: https://bing.com`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('-[1]: https://google.com');
        expect(result.diff).toContain('+[1]: https://bing.com');
        expect(result.getApprovedMarkdown()).toContain('[1]: https://bing.com');
      });

      it('should handle multiple reference links with mixed changes', () => {
        const original = `Visit [Site A][a] and [Site B][b].

[a]: https://sitea.com
[b]: https://siteb.com`;

        const target = `Visit [Site A][a] and [Site B][b] and [Site C][c].

[a]: https://newsitea.com
[b]: https://siteb.com
[c]: https://sitec.com`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '+Visit [Site A][a] and [Site B][b] and [Site C][c].',
        );
        expect(result.diff).toContain('-[a]: https://sitea.com');
        expect(result.diff).toContain('+[a]: https://newsitea.com');
        expect(result.diff).toContain('+[c]: https://sitec.com');
      });
    });

    describe('Links with special characters in URLs', () => {
      it('should handle links with parentheses in URLs', () => {
        const original = `See [Wikipedia](https://en.wikipedia.org/wiki/URL)`;

        const target = `See [Wikipedia](https://en.wikipedia.org/wiki/URL_(disambiguation))`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '-See [Wikipedia](https://en.wikipedia.org/wiki/URL)',
        );
        expect(result.diff).toContain(
          '+See [Wikipedia](https://en.wikipedia.org/wiki/URL_(disambiguation))',
        );
        expect(result.getApprovedMarkdown()).toContain(
          'https://en.wikipedia.org/wiki/URL_(disambiguation)',
        );
      });

      it('should handle links with brackets in URLs', () => {
        const original = `Check [example](https://example.com/path)`;

        const target = `Check [example](https://example.com/path[encoded])`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '-Check [example](https://example.com/path)',
        );
        expect(result.diff).toContain(
          '+Check [example](https://example.com/path[encoded])',
        );
      });

      it('should handle links with mixed special characters', () => {
        const original = `Link to [resource](https://api.example.com/v1/data)`;

        const target = `Link to [resource](https://api.example.com/v1/data?filter[type]=user&sort[name]=asc)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain(
          'filter[type]=user&sort[name]=asc',
        );
      });
    });

    describe('Links with formatting inside link text', () => {
      it('should handle bold text inside links', () => {
        const original = `Visit [my website](https://example.com)`;

        const target = `Visit [**my website**](https://example.com)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain(
          '-Visit [my website](https://example.com)',
        );
        expect(result.diff).toContain(
          '+Visit [**my website**](https://example.com)',
        );
        expect(result.getApprovedMarkdown()).toContain('[**my website**]');
      });

      it('should handle italic text inside links', () => {
        const original = `See [documentation](https://docs.example.com)`;

        const target = `See [_documentation_](https://docs.example.com)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain('[*documentation*]');
      });

      it('should handle complex formatting inside links', () => {
        const original = `Check [API reference](https://api.example.com)`;

        const target = `Check [**API** _reference_ \`v2\`](https://api.example.com)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain(
          '**API** _reference_ `v2`',
        );
      });
    });

    describe('Nested links (invalid markdown)', () => {
      it('should handle links inside link text gracefully', () => {
        const original = `Visit [my site](https://example.com)`;

        const target = `Visit [my [nested](https://nested.com) site](https://example.com)`;

        const result = setupMarkdownDiffTest(original, target);

        // Should handle the invalid markdown somehow
        expect(result.diff).toContain('nested');
        expect(result.getApprovedMarkdown()).toContain('nested');
      });

      it('should handle reference links inside other links', () => {
        const original = `See [documentation](https://docs.example.com)`;

        const target = `See [documentation [here][ref]](https://docs.example.com)

[ref]: https://reference.com`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain('here');
      });
    });

    describe('Links with very long URLs', () => {
      it('should handle links with 500+ character URLs', () => {
        const shortUrl = 'https://example.com';
        const longUrl =
          'https://api.verylongdomainname.com/v3/endpoints/with/very/long/paths/that/contain/multiple/segments/and/query/parameters?param1=verylongvalue1&param2=verylongvalue2&param3=verylongvalue3&param4=verylongvalue4&param5=verylongvalue5&param6=verylongvalue6&param7=verylongvalue7&param8=verylongvalue8&param9=verylongvalue9&param10=verylongvalue10&param11=verylongvalue11&param12=verylongvalue12&param13=verylongvalue13&param14=verylongvalue14&param15=verylongvalue15#verylongfragmentidentifier';

        const original = `Visit [short link](${shortUrl})`;

        const target = `Visit [long link](${longUrl})`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('short link');
        expect(result.diff).toContain('long link');
        expect(result.getApprovedMarkdown()).toContain(
          'verylongdomainname.com',
        );
      });
    });

    describe('Links with query parameters and fragments', () => {
      it('should handle links with query parameters', () => {
        const original = `Search [results](https://example.com/search)`;

        const target = `Search [results](https://example.com/search?q=lexical&type=editor&sort=date)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain(
          'q=lexical&type=editor&sort=date',
        );
      });

      it('should handle links with fragments', () => {
        const original = `Read [documentation](https://docs.example.com)`;

        const target = `Read [documentation](https://docs.example.com#getting-started)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain('#getting-started');
      });

      it('should handle links with both query params and fragments', () => {
        const original = `View [page](https://example.com/page)`;

        const target = `View [page](https://example.com/page?version=2&lang=en#section-3)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain(
          'version=2&lang=en#section-3',
        );
      });
    });

    describe('Links that span multiple lines', () => {
      it('should handle multiline link text', () => {
        const original = `Visit [my website](https://example.com)`;

        const target = `Visit [my
website](https://example.com)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain('my\nwebsite');
      });

      it('should handle multiline URLs', () => {
        const original = `See [docs](https://docs.example.com)`;

        const target = `See [docs](https://docs.example.com/very/long/path/that/continues/on/next/line)`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain('very/long/path');
      });

      it('should handle reference links with multiline definitions', () => {
        const original = `Check [link][ref]

[ref]: https://short.com`;

        const target = `Check [link][ref]

[ref]: https://verylongdomain.com/with/very/long/path/that/might/wrap`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.getApprovedMarkdown()).toContain('verylongdomain.com');
      });
    });
  });

  describe('Code Block Variations', () => {
    describe('Code blocks with language hints', () => {
      it('should handle python code blocks', () => {
        const original = `\`\`\`
def hello():
    print("Hello")
\`\`\``;

        const target = `\`\`\`python
def hello():
    print("Hello, World!")
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('python');
        expect(result.getApprovedMarkdown()).toContain('Hello, World!');
      });

      it('should handle javascript code blocks', () => {
        const original = `\`\`\`
function test() {
  return true;
}
\`\`\``;

        const target = `\`\`\`javascript
function test() {
  return false;
}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('javascript');
        expect(result.getApprovedMarkdown()).toContain('return false');
      });

      it('should handle typescript code blocks', () => {
        const original = `\`\`\`
interface User {
  name: string;
}
\`\`\``;

        const target = `\`\`\`typescript
interface User {
  name: string;
  age: number;
}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('typescript');
        expect(result.getApprovedMarkdown()).toContain('age: number');
      });

      it('should handle changing language hints', () => {
        const original = `\`\`\`javascript
console.log("Hello");
\`\`\``;

        const target = `\`\`\`typescript
console.log("Hello");
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('typescript');
        expect(result.getApprovedMarkdown()).toContain('typescript');
      });
    });

    describe('Code blocks containing triple backticks', () => {
      it('should handle escaped triple backticks in code', () => {
        const original = `\`\`\`
const example = "simple code";
\`\`\``;

        const target = `\`\`\`
const example = "Use \\\\\\\`\\\\\\\`\\\\\\\` for code blocks";
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('code blocks');
        expect(result.getApprovedMarkdown()).toContain('code blocks');
      });

      it('should handle nested code block examples', () => {
        const original = `\`\`\`markdown
# Example
\`\`\``;

        const target = `\`\`\`markdown
# Example
To create code blocks, use:
\\\\\\\`\\\\\\\`\\\\\\\`javascript
console.log("Hello");
\\\\\\\`\\\\\\\`\\\\\\\`
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('To create code blocks');
        expect(result.getApprovedMarkdown()).toContain('console.log');
      });

      it('should handle code blocks within strings', () => {
        const original = `\`\`\`python
def create_markdown():
    return "# Title"
\`\`\``;

        const target = `\`\`\`python
def create_markdown():
    return """
# Title
\\\\\\\`\\\\\\\`\\\\\\\`python
print("Hello")
\\\\\\\`\\\\\\\`\\\\\\\`
"""
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('print("Hello")');
        expect(result.getApprovedMarkdown()).toContain('print("Hello")');
      });
    });

    describe('Inline code containing backticks', () => {
      it('should handle inline code with single backticks', () => {
        const original = `Use \`console.log\` for debugging.`;

        const target = `Use \`console.log("value")\` for debugging.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('("value")');
        expect(result.getApprovedMarkdown()).toContain('console.log("value")');
      });

      it('should handle inline code with backticks inside', () => {
        const original = `The command is \`echo hello\`.`;

        const target = `The command is \`\`echo \\\`hello\\\`\`\`.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('echo');
        expect(result.getApprovedMarkdown()).toContain('echo');
      });

      it('should handle multiple inline codes with backticks', () => {
        const original = `Use \`func1\` and \`func2\`.`;

        const target = `Use \`\`func1(\\\`param\\\`)\`\` and \`\`func2(\\\`param\\\`)\`\`.`;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('func1');
        expect(result.getApprovedMarkdown()).toContain('func1');
      });
    });

    describe('Code blocks with HTML/XML content', () => {
      it('should handle HTML code blocks', () => {
        const original = `\`\`\`html
<div>Hello</div>
\`\`\``;

        const target = `\`\`\`html
<div class="greeting">
  <p>Hello, World!</p>
</div>
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('<p>Hello, World!</p>');
        expect(result.getApprovedMarkdown()).toContain('class="greeting"');
      });

      it('should handle XML with namespaces', () => {
        const original = `\`\`\`xml
<root></root>
\`\`\``;

        const target = `\`\`\`xml
<root xmlns:ns="http://example.com">
  <ns:element>Content</ns:element>
</root>
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('xmlns:ns');
        expect(result.getApprovedMarkdown()).toContain('ns:element');
      });

      it('should handle HTML with complex attributes', () => {
        const original = `\`\`\`html
<input type="text">
\`\`\``;

        const target = `\`\`\`html
<input 
  type="text" 
  data-testid="user-input"
  class="form-control"
  placeholder="Enter your name">
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('data-testid');
        expect(result.getApprovedMarkdown()).toContain('placeholder=');
      });

      it('should handle CDATA sections', () => {
        const original = `\`\`\`xml
<script></script>
\`\`\``;

        const target = `\`\`\`xml
<script>
  <![CDATA[
    if (x < y && y > z) {
      console.log("Complex logic");
    }
  ]]>
</script>
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('CDATA');
        expect(result.getApprovedMarkdown()).toContain('Complex logic');
      });
    });

    describe('Code blocks with diff markers', () => {
      it('should handle code with + and - markers', () => {
        const original = `\`\`\`
function test() {
  return true;
}
\`\`\``;

        const target = `\`\`\`diff
function test() {
- return true;
+ return false;
}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('diff');
        expect(result.getApprovedMarkdown()).toContain('- return true');
      });

      it('should handle git diff format', () => {
        const original = `\`\`\`
console.log("Hello");
\`\`\``;

        const target = `\`\`\`diff
@@@ -1,1 +1,2 @@@
 console.log("Hello");
+console.log("World");
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('@@@');
        expect(result.getApprovedMarkdown()).toContain('+console.log("World")');
      });

      it('should handle patch format with context', () => {
        const original = `\`\`\`
let x = 1;
let y = 2;
\`\`\``;

        const target = `\`\`\`patch
 let x = 1;
-let y = 2;
+let y = 3;
+let z = 4;
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('patch');
        expect(result.getApprovedMarkdown()).toContain('+let z = 4');
      });

      it('should handle unified diff headers', () => {
        const original = `\`\`\`
basic code
\`\`\``;

        const target = `\`\`\`diff
--- a/file.js
+++ b/file.js
@@ -1,1 +1,2 @@
 basic code
+additional line
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('--- a/file.js');
        expect(result.getApprovedMarkdown()).toContain('+++ b/file.js');
      });
    });

    describe('Empty code blocks with language hints', () => {
      it('should handle empty python block', () => {
        const original = `\`\`\`
\`\`\``;

        const target = `\`\`\`python
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('python');
        expect(result.getApprovedMarkdown()).toContain('python');
      });

      it('should handle empty block with complex language spec', () => {
        const original = `\`\`\`
\`\`\``;

        const target = `\`\`\`javascript{1-3,5}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('javascript{1-3,5}');
        expect(result.getApprovedMarkdown()).toContain('javascript{1-3,5}');
      });

      it('should handle adding content to empty blocks', () => {
        const original = `\`\`\`python
\`\`\``;

        const target = `\`\`\`python
print("Hello, World!")
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('Hello, World!');
        expect(result.getApprovedMarkdown()).toContain(
          'print("Hello, World!")',
        );
      });

      it('should handle removing content from blocks', () => {
        const original = `\`\`\`python
print("Hello, World!")
\`\`\``;

        const target = `\`\`\`python
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('-');
        expect(result.getApprovedMarkdown()).not.toContain(
          'print("Hello, World!")',
        );
      });
    });

    describe('Code blocks with very long lines', () => {
      it('should handle single very long line (1000+ characters)', () => {
        const longString = 'x'.repeat(1000);

        const original = `\`\`\`
short line
\`\`\``;

        const target = `\`\`\`javascript
const veryLongString = "${longString}";
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('veryLongString');
        expect(result.getApprovedMarkdown()).toContain(longString);
      });

      it('should handle multiple long lines in code block', () => {
        const longLine1 = 'const array1 = [' + '"item", '.repeat(200) + '];';
        const longLine2 = 'const array2 = [' + '"value", '.repeat(200) + '];';

        const original = `\`\`\`
const small = [];
\`\`\``;

        const target = `\`\`\`javascript
${longLine1}
${longLine2}
const small = [];
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('array1');
        expect(result.getApprovedMarkdown()).toContain('array2');
      });

      it('should handle very long single-line functions', () => {
        const longFunction =
          'function veryLongFunction(' +
          'param'
            .split('')
            .map((c, i) => c + i)
            .join(', ')
            .repeat(50) +
          ') { return true; }';

        const original = `\`\`\`
function short() {}
\`\`\``;

        const target = `\`\`\`javascript
${longFunction}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('veryLongFunction');
        expect(result.getApprovedMarkdown()).toContain('veryLongFunction');
      });

      it('should handle long lines with special characters', () => {
        const complexLongLine =
          'const regex = /' +
          '(\\\\w+|\\\\s+|[!@#$%^&*()_+={}\\\\[\\\\]:";\'<>?,.\\\\-])'.repeat(
            100,
          ) +
          '/g;';

        const original = `\`\`\`
const simple = /test/;
\`\`\``;

        const target = `\`\`\`javascript
${complexLongLine}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('regex');
        expect(result.getApprovedMarkdown()).toContain('regex');
      });

      it('should handle long lines with unicode characters', () => {
        const unicodeLongLine =
          'const unicode = "' + '🚀🌟💫⭐️🌈🦄🎨🎵🎪🎯'.repeat(150) + '";';

        const original = `\`\`\`
const emoji = "🚀";
\`\`\``;

        const target = `\`\`\`javascript
${unicodeLongLine}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('unicode');
        expect(result.getApprovedMarkdown()).toContain('🚀🌟💫');
      });

      it('should handle very long SQL queries', () => {
        const longSQL =
          'SELECT ' +
          Array.from({length: 100}, (_, i) => `column${i}`).join(', ') +
          ' FROM very_long_table_name_that_goes_on_and_on WHERE condition = "test";';

        const original = `\`\`\`sql
SELECT * FROM users;
\`\`\``;

        const target = `\`\`\`sql
${longSQL}
\`\`\``;

        const result = setupMarkdownDiffTest(original, target);

        expect(result.diff).toContain('column0');
        expect(result.getApprovedMarkdown()).toContain('very_long_table_name');
      });
    });
  });
});
