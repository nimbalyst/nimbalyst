/**
 * RTL Detection — analyzes text and determines its dominant direction.
 *
 * Algorithm:
 *  - Counts alphabetic/numeric characters
 *  - Checks each against Unicode RTL script ranges
 *  - If the RTL ratio is >= threshold → 'rtl', otherwise 'ltr'
 *
 * Granularity: per-block (each text block is analyzed independently)
 */

/** Unicode ranges for right-to-left scripts */
const RTL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo
  [0x0800, 0x083f], // Samaritan
  [0x0840, 0x085f], // Mandaic
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew Presentation Forms
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
];

const LTR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0041, 0x005a], // Basic Latin uppercase
  [0x0061, 0x007a], // Basic Latin lowercase
  [0x00c0, 0x024f], // Latin Extended
];

/** Whether a code point belongs to an RTL script */
function isRtlChar(code: number): boolean {
  for (const [start, end] of RTL_RANGES) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/** Whether a character is a meaningful letter/number (from any script) */
function isMeaningfulChar(char: string): boolean {
  // \p{L} = any letter, \p{N} = any number (covers Latin, Arabic, Persian, Hebrew, etc.)
  return /[\p{L}\p{N}]/u.test(char);
}

/**
 * Detects the dominant direction of a text.
 *
 * @param text input text (may be multi-line)
 * @param threshold minimum RTL ratio to classify as RTL (default 0.3 = 30%)
 * @returns 'rtl' or 'ltr'
 */
export function detectDirection(
  text: string,
  threshold: number = 0.3
): 'rtl' | 'ltr' {
  if (!text || !text.trim()) return 'ltr';

  let rtlCount = 0;
  let totalCount = 0;

  for (const char of text) {
    if (!isMeaningfulChar(char)) continue;

    totalCount++;
    const code = char.codePointAt(0);
    if (code !== undefined && isRtlChar(code)) {
      rtlCount++;
    }
  }

  if (totalCount === 0) return 'ltr';
  return rtlCount / totalCount >= threshold ? 'rtl' : 'ltr';
}

/**
 * Detects direction for separate text blocks.
 * Splits text on blank lines and analyzes each block independently.
 *
 * @returns array of { text, direction }
 */
export function detectBlocks(
  text: string,
  threshold: number = 0.3
): Array<{ text: string; direction: 'rtl' | 'ltr' }> {
  if (!text) return [];

  // Split on blank lines (i.e. paragraphs)
  const blocks = text.split(/\n\s*\n/);
  return blocks.map((block) => ({
    text: block,
    direction: detectDirection(block, threshold),
  }));
}

/**
 * Detects the overall direction of a message — used to decide the
 * default direction for the whole message. Decided by block majority.
 */
export function detectMessageDirection(
  text: string,
  threshold: number = 0.3
): 'rtl' | 'ltr' {
  if (!text || !text.trim()) return 'ltr';

  const blocks = detectBlocks(text, threshold);
  const rtlBlocks = blocks.filter((b) => b.direction === 'rtl').length;
  const ltrBlocks = blocks.length - rtlBlocks;

  // Majority of blocks decides; tie → LTR
  return rtlBlocks > ltrBlocks ? 'rtl' : 'ltr';
}

/**
 * Splits text into same-direction runs (for inline RTL handling).
 * e.g. "Hello سلام world" → [{Hello, ltr}, {سلام, rtl}, {world, ltr}]
 *
 * Used for inline rendering so each RTL run displays correctly in isolation.
 *
 * @returns array of { text, direction }
 */
export function detectInlineRuns(
  text: string,
  threshold: number = 0.3
): Array<{ text: string; direction: 'rtl' | 'ltr' }> {
  if (!text) return [];

  const result: Array<{ text: string; direction: 'rtl' | 'ltr' }> = [];
  let currentRun = '';
  let currentDir: 'rtl' | 'ltr' | 'neutral' = 'neutral';

  const flush = (dir: 'rtl' | 'ltr') => {
    if (currentRun) {
      result.push({ text: currentRun, direction: dir });
      currentRun = '';
    }
  };

  for (const char of text) {
    const code = char.codePointAt(0);
    const isMeaningful = code !== undefined && /[\p{L}\p{N}]/u.test(char);

    if (!isMeaningful) {
      // Neutral character (space, punctuation) — append to current run
      currentRun += char;
      continue;
    }

    const isRtl = code !== undefined && isRtlChar(code);
    const charDir: 'rtl' | 'ltr' = isRtl ? 'rtl' : 'ltr';

    if (currentDir === 'neutral') {
      currentDir = charDir;
      currentRun += char;
    } else if (currentDir === charDir) {
      currentRun += char;
    } else {
      // Direction change — flush the previous run
      flush(currentDir as 'rtl' | 'ltr');
      currentDir = charDir;
      currentRun = char;
    }
  }

  // Flush the final run
  if (currentDir !== 'neutral') {
    flush(currentDir as 'rtl' | 'ltr');
  } else if (currentRun) {
    // Only neutral (e.g. just whitespace) — classify as ltr
    result.push({ text: currentRun, direction: 'ltr' });
  }

  // threshold is only used for block-level detection, not inline
  void threshold;

  // Merge adjacent same-direction runs (including neutrals between them)
  return mergeNeutralRuns(result);
}

/** Merges neutral runs between two same-direction runs */
function mergeNeutralRuns(
  runs: Array<{ text: string; direction: 'rtl' | 'ltr' }>
): Array<{ text: string; direction: 'rtl' | 'ltr' }> {
  if (runs.length <= 1) return runs;
  const merged: Array<{ text: string; direction: 'rtl' | 'ltr' }> = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const last = merged[merged.length - 1];
    if (last.direction === runs[i].direction) {
      last.text += runs[i].text;
    } else {
      merged.push(runs[i]);
    }
  }
  return merged;
}

// LTR_RANGES is retained for potential future use (e.g. strict LTR classification)
void LTR_RANGES;
