/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable radix, @typescript-eslint/no-explicit-any */

import {applyPatch, parsePatch, createTwoFilesPatch} from 'diff';
import {createPatchError, createInvalidDiffError, DiffError} from './DiffError';

/**
 * Apply a unified diff string to markdown text with enhanced error reporting
 * Internal function used by diffUtils.ts - not exported from this module
 */
export function applyParsedDiffToMarkdown(
  markdown: string,
  diffString: string,
): string {
  // Normalize newlines to make patch application more robust
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n');
  let normalizedDiff = diffString.replace(/\r\n/g, '\n');

  // Remove the annoying "\ No newline at end of file" lines that cause patch failures
  normalizedDiff = normalizedDiff.replace(
    /\n\\ No newline at end of file/g,
    '',
  );

  try {
    // Apply the patch
    let result = applyPatch(normalizedMarkdown, normalizedDiff);

    if (result === false) {
      // Try again with trailing newline added to markdown if it's missing
      const markdownWithNewline = normalizedMarkdown.endsWith('\n')
        ? normalizedMarkdown
        : normalizedMarkdown + '\n';
      result = applyPatch(markdownWithNewline, normalizedDiff);

      if (result === false) {
        // Try again with trailing newline removed from markdown if it exists
        const markdownWithoutNewline = normalizedMarkdown.endsWith('\n')
          ? normalizedMarkdown.slice(0, -1)
          : normalizedMarkdown;
        result = applyPatch(markdownWithoutNewline, normalizedDiff);

        if (result === false) {
          // All attempts failed - throw structured error with detailed debugging info
          throw createPatchError(normalizedMarkdown, normalizedDiff);
        }
      }
    }

    return result;
  } catch (error) {
    // If it's already a DiffError, re-throw it
    if (error instanceof DiffError) {
      throw error;
    }

    // For other errors, wrap them in a DiffError with context
    throw createPatchError(normalizedMarkdown, normalizedDiff, error as Error);
  }
}

/**
 * Parse a unified diff string into structured format
 * Internal function - not exported from this module
 */
export function parseUnifiedDiff(diffString: string): any {
  try {
    const parsed = parsePatch(diffString);

    if (!parsed || parsed.length === 0) {
      throw createInvalidDiffError(
        diffString,
        'No patches found in diff string',
      );
    }

    // Convert from the diff library format to our format
    const hunks: any[] = [];

    for (const patch of parsed) {
      if (!patch.hunks || patch.hunks.length === 0) {
        throw createInvalidDiffError(diffString, 'Patch contains no hunks');
      }

      for (const hunk of patch.hunks) {
        hunks.push({
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: hunk.lines,
        });
      }
    }

    return {hunks};
  } catch (error) {
    // If it's already a DiffError, re-throw it
    if (error instanceof DiffError) {
      throw error;
    }

    // For other errors, wrap them in a DiffError
    throw createInvalidDiffError(
      diffString,
      `Failed to parse unified diff: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Generate a unified diff string from old and new text
 * Used by tests - exported for compatibility
 */
export function generateUnifiedDiff(
  oldText: string,
  newText: string,
  oldFileName: string = 'a/document.md',
  newFileName: string = 'b/document.md',
): string {
  try {
    // Use a HUGE context to ensure shifted content is recognized as equal
    // Default is 3 lines, which causes shifted content to be treated as removed+added
    // With context=9999, lines that match will be marked as equal even if far apart
    const patch = createTwoFilesPatch(
      oldFileName,
      newFileName,
      oldText,
      newText,
      undefined, // oldHeader
      undefined, // newHeader
      { context: 9999 }, // options - HUGE context window
    );

    // Remove the separator line that createTwoFilesPatch adds
    // It adds "===================================================================\n" at the beginning
    const lines = patch.split('\n');
    const separatorIndex = lines.findIndex((line) => line.startsWith('==='));

    if (separatorIndex !== -1) {
      // Remove the separator line and return the rest
      return lines.slice(separatorIndex + 1).join('\n');
    }

    return patch;
  } catch (error) {
    throw createInvalidDiffError(
      `oldText: ${oldText.substring(0, 100)}..., newText: ${newText.substring(
        0,
        100,
      )}...`,
      `Failed to generate unified diff: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
