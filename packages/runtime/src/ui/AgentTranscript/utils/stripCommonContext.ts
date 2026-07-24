/**
 * Strips common prefix and suffix from old and new text to show only the actual changes.
 * This is useful for diff displays where the LLM includes extra context for accuracy,
 * but we only want to show users what actually changed.
 *
 * Uses word boundaries to avoid splitting words (e.g., "Chat" -> "Agent" shows full words,
 * not "Cha" -> "Agen").
 */
export interface StrippedContext {
  oldText: string;
  newText: string;
  commonPrefix: string;
  commonSuffix: string;
}

/**
 * Checks if a character is a word boundary (whitespace or punctuation, but not underscore)
 */
function isWordBoundary(char: string): boolean {
  // \s matches whitespace
  // [^\w] matches non-word characters (includes punctuation)
  // But we exclude underscore because it's part of identifiers in code
  return /\s/.test(char) || (/[^\w]/.test(char) && char !== '_');
}

/**
 * Adjusts index backwards to the nearest word boundary
 */
function adjustToWordBoundaryLeft(text: string, index: number): number {
  // If already at a word boundary, use it
  if (index === 0 || isWordBoundary(text[index - 1])) {
    return index;
  }

  // Move left to find the start of the word
  while (index > 0 && !isWordBoundary(text[index - 1])) {
    index--;
  }

  return index;
}

/**
 * Adjusts index forwards to the nearest word boundary
 */
function adjustToWordBoundaryRight(text: string, index: number): number {
  // If already at a word boundary, use it
  if (index === text.length || isWordBoundary(text[index])) {
    return index;
  }

  // Move right to find the end of the word
  while (index < text.length && !isWordBoundary(text[index])) {
    index++;
  }

  return index;
}

export function stripCommonContext(oldText: string, newText: string): StrippedContext {
  if (!oldText || !newText) {
    return {
      oldText,
      newText,
      commonPrefix: '',
      commonSuffix: '',
    };
  }

  // Handle identical strings
  if (oldText === newText) {
    return {
      oldText: '',
      newText: '',
      commonPrefix: oldText,
      commonSuffix: '',
    };
  }

  // Find common prefix (character-based first)
  let prefixLength = 0;
  const minLength = Math.min(oldText.length, newText.length);

  while (prefixLength < minLength && oldText[prefixLength] === newText[prefixLength]) {
    prefixLength++;
  }

  // Adjust prefix to word boundary (move left to include the full word where diff starts)
  prefixLength = adjustToWordBoundaryLeft(oldText, prefixLength);

  // Find common suffix (character-based first, but don't overlap with prefix)
  let suffixLength = 0;
  const maxSuffixLength = minLength - prefixLength;

  while (
    suffixLength < maxSuffixLength &&
    oldText[oldText.length - 1 - suffixLength] === newText[newText.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  // Adjust suffix to word boundary (move right to include the full word where diff ends)
  const suffixStartInOld = oldText.length - suffixLength;
  const adjustedSuffixStart = adjustToWordBoundaryRight(oldText, suffixStartInOld);
  suffixLength = oldText.length - adjustedSuffixStart;

  const commonPrefix = oldText.substring(0, prefixLength);
  const commonSuffix = oldText.substring(oldText.length - suffixLength);

  const strippedOld = oldText.substring(prefixLength, oldText.length - suffixLength);
  const strippedNew = newText.substring(prefixLength, newText.length - suffixLength);

  return {
    oldText: strippedOld,
    newText: strippedNew,
    commonPrefix,
    commonSuffix,
  };
}
