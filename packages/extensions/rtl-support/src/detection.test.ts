/**
 * Tests for direction detection and inline run detection.
 *
 * Run:
 *   node --experimental-strip-types -e "await import('./src/detection.test.ts')"
 *
 * Note: Persian/Arabic/Hebrew sample strings below are intentional — they are
 * real RTL text used to verify the algorithm detects the correct direction.
 */

import {
  detectDirection,
  detectMessageDirection,
  detectBlocks,
  detectInlineRuns,
} from './detection';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error('FAIL: ' + message);
  }
  console.log('PASS: ' + message);
}

console.log('\n=== RTL Detection Tests ===\n');

// Persian sample text (RTL)
assert(detectDirection('سلام دنیا، این یک متن فارسی است') === 'rtl', 'Persian should be RTL');
// Arabic sample text (RTL)
assert(detectDirection('مرحبا بالعالم هذا نص عربي') === 'rtl', 'Arabic should be RTL');
// Hebrew sample text (RTL)
assert(detectDirection('שלום עולם זה טקסט בעברית') === 'rtl', 'Hebrew should be RTL');
// English sample text (LTR)
assert(detectDirection('Hello world, this is English text') === 'ltr', 'English should be LTR');

// Mixed — Persian majority (RTL)
assert(detectDirection('سلام این متن فارسی است با کمی English') === 'rtl', 'Persian-majority mixed should be RTL');
// Mixed — English majority (LTR)
assert(detectDirection('This is mostly English with one word: سلام') === 'ltr', 'English-majority mixed should be LTR');

// Edge cases
assert(detectDirection('') === 'ltr', 'Empty should default to LTR');
assert(detectDirection('   ') === 'ltr', 'Whitespace should default to LTR');
assert(detectDirection('12345 67890') === 'ltr', 'Numbers should be LTR');
assert(detectDirection('😀🎉🚀') === 'ltr', 'Emoji should be LTR');
// Persian digits
assert(detectDirection('در سال ۱۴۰۳ این اتفاق افتاد') === 'rtl', 'Persian with Persian digits should be RTL');

// Block detection (mixed message with paragraphs)
const blocks = detectBlocks('سلام دنیا\n\nHello world\n\nاین هم فارسی است');
assert(blocks.length === 3, 'Should detect 3 blocks');
assert(blocks[0].direction === 'rtl', 'Block 0 (Persian) should be RTL');
assert(blocks[1].direction === 'ltr', 'Block 1 (English) should be LTR');
assert(blocks[2].direction === 'rtl', 'Block 2 (Persian) should be RTL');

// Message-level direction by block majority
assert(
  detectMessageDirection('سلام دنیا\n\nHello\n\nاین هم فارسی است\n\nباز هم فارسی') === 'rtl',
  'RTL majority should be RTL'
);
assert(
  detectMessageDirection('Hello world\n\nسلام\n\nMore English\n\nEven more') === 'ltr',
  'LTR majority should be LTR'
);

console.log('\n=== Inline Detection Tests ===\n');

// Pure English → one LTR run
const engRuns = detectInlineRuns('Hello world');
assert(engRuns.length === 1, 'English-only should be 1 run');
assert(engRuns[0].direction === 'ltr', 'English-only run should be ltr');

// Pure Persian → one RTL run
const perRuns = detectInlineRuns('سلام دنیا');
assert(perRuns.length === 1, 'Persian-only should be 1 run');
assert(perRuns[0].direction === 'rtl', 'Persian-only run should be rtl');

// Mixed → at least 2 runs
const mixedRuns = detectInlineRuns('Hello سلام world');
assert(mixedRuns.length >= 2, 'Mixed should have at least 2 runs');
assert(mixedRuns.some((r) => r.direction === 'rtl' && r.text.includes('سلام')), 'Mixed should have RTL run with Persian');
assert(mixedRuns.some((r) => r.direction === 'ltr' && r.text.includes('Hello')), 'Mixed should have LTR run with English');

// Empty
assert(detectInlineRuns('').length === 0, 'Empty should be 0 runs');

// Whitespace only
const wsRuns = detectInlineRuns('   ');
assert(wsRuns.length === 1, 'Whitespace-only should be 1 run');

// Persian in the middle of English — isolation
const midRuns = detectInlineRuns('The word سلام is Persian');
assert(midRuns.length >= 3, 'Mid-Persian should have at least 3 runs');
const rtlMidRun = midRuns.find((r) => r.direction === 'rtl');
assert(rtlMidRun !== undefined && rtlMidRun.text.includes('سلام'), 'Mid-Persian should have RTL run');

// Neutral characters (space) attach to the adjacent run
const spaceRuns = detectInlineRuns('hello سلام');
assert(spaceRuns.length === 2, 'hello+space+سلام should be 2 runs (neutral merged)');
assert(spaceRuns[0].direction === 'ltr' && spaceRuns[0].text === 'hello ', 'First run should be "hello " ltr');
assert(spaceRuns[1].direction === 'rtl' && spaceRuns[1].text === 'سلام', 'Second run should be Persian rtl');

console.log('\n=== All tests passed! ===\n');
