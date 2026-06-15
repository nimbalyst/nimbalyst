/**
 * تست‌های الگوریتم تشخیص جهت متن + inline detection.
 *
 * اجرا:
 *   node --experimental-strip-types -e "await import('./src/detection.test.ts')"
 */

import {
  detectDirection,
  detectMessageDirection,
  detectBlocks,
  detectInlineRuns,
} from './detection';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`PASS: ${message}`);
}

console.log('\n=== RTL Detection Tests ===\n');

assert(detectDirection('سلام دنیا، این یک متن فارسی است') === 'rtl', 'Persian → RTL');
assert(detectDirection('مرحبا بالعالم هذا نص عربي') === 'rtl', 'Arabic → RTL');
assert(detectDirection('Hello world, this is English text') === 'ltr', 'English → LTR');
assert(detectDirection('سلام این متن فارسی است با کمی English') === 'rtl', 'Persian-majority mixed → RTL');
assert(detectDirection('This is mostly English with one word: سلام') === 'ltr', 'English-majority mixed → LTR');
assert(detectDirection('') === 'ltr', 'Empty → LTR');
assert(detectDirection('   ') === 'ltr', 'Whitespace → LTR');
assert(detectDirection('12345 67890') === 'ltr', 'Numbers → LTR');
assert(detectDirection('😀🎉🚀') === 'ltr', 'Emoji → LTR');
assert(detectDirection('שלום עולם זה טקסט בעברית') === 'rtl', 'Hebrew → RTL');

const blocks = detectBlocks('سلام دنیا\n\nHello world\n\nاین هم فارسی است');
assert(blocks.length === 3, '3 blocks detected');
assert(blocks[0].direction === 'rtl', 'Block 0 (Persian) → RTL');
assert(blocks[1].direction === 'ltr', 'Block 1 (English) → LTR');
assert(blocks[2].direction === 'rtl', 'Block 2 (Persian) → RTL');

assert(
  detectMessageDirection('سلام دنیا\n\nHello\n\nاین هم فارسی است\n\nباز هم فارسی') === 'rtl',
  'RTL majority → RTL'
);
assert(
  detectMessageDirection('Hello world\n\nسلام\n\nMore English\n\nEven more') === 'ltr',
  'LTR majority → LTR'
);
assert(detectDirection('در سال ۱۴۰۳ این اتفاق افتاد') === 'rtl', 'Persian with Persian digits → RTL');

console.log('\n=== Inline Detection Tests ===\n');

// متن انگلیسی خالص → یه run LTR
const engRuns = detectInlineRuns('Hello world');
assert(engRuns.length === 1, 'English-only → 1 run');
assert(engRuns[0].direction === 'ltr', 'English-only run → ltr');

// متن فارسی خالص → یه run RTL
const perRuns = detectInlineRuns('سلام دنیا');
assert(perRuns.length === 1, 'Persian-only → 1 run');
assert(perRuns[0].direction === 'rtl', 'Persian-only run → rtl');

// مخلوط → حداقل ۲ run
const mixedRuns = detectInlineRuns('Hello سلام world');
assert(mixedRuns.length >= 2, 'Mixed → at least 2 runs');
const hasRtl = mixedRuns.some((r) => r.direction === 'rtl' && r.text.includes('سلام'));
const hasLtr = mixedRuns.some((r) => r.direction === 'ltr' && r.text.includes('Hello'));
assert(hasRtl, 'Mixed has RTL run with سلام');
assert(hasLtr, 'Mixed has LTR run with Hello');

// متن خالی
assert(detectInlineRuns('').length === 0, 'Empty → 0 runs');

// فقط فاصله
const wsRuns = detectInlineRuns('   ');
assert(wsRuns.length === 1, 'Whitespace-only → 1 run');

// فارسی در وسط انگلیسی — isolation
const midRuns = detectInlineRuns('The word سلام is Persian');
assert(midRuns.length >= 3, 'Mid-Persian → at least 3 runs');
const rtlMidRun = midRuns.find((r) => r.direction === 'rtl');
assert(rtlMidRun !== undefined && rtlMidRun.text.includes('سلام'), 'Mid-Persian has RTL run');

// neutral characters (فاصله) به run مجاور اضافه می‌شن
const spaceRuns = detectInlineRuns('hello سلام');
assert(spaceRuns.length === 2, 'hello+space+سلام → 2 runs (neutral merged)');
assert(spaceRuns[0].direction === 'ltr' && spaceRuns[0].text === 'hello ', 'First run: "hello " ltr');
assert(spaceRuns[1].direction === 'rtl' && spaceRuns[1].text === 'سلام', 'Second run: "سلام" rtl');

console.log('\n=== All tests passed! ===\n');
