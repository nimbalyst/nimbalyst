/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Structured error class for markdown diff operations with detailed debugging information
 */
export class DiffError extends Error {
  public readonly errorType: string;
  public readonly context: DiffErrorContext;
  public readonly originalError?: Error;

  constructor(
    message: string,
    errorType: string,
    context: DiffErrorContext,
    originalError?: Error,
  ) {
    super(message);
    this.name = 'DiffError';
    this.errorType = errorType;
    this.context = context;
    this.originalError = originalError;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DiffError);
    }
  }

  /**
   * Generate a comprehensive error report for debugging
   */
  toDetailedString(): string {
    const sections: string[] = [
      `[${this.errorType}] ${this.message}`,
      '',
      '=== DIFF ERROR DETAILS ===',
    ];

    // Add context information
    if (this.context.originalMarkdown !== undefined) {
      const originalLines = this.context.originalMarkdown.split('\n');
      sections.push(
        `Original markdown (${originalLines.length} lines):`,
        this.formatTextPreview(this.context.originalMarkdown, 'original'),
        '',
      );
    }

    if (this.context.targetMarkdown !== undefined) {
      const targetLines = this.context.targetMarkdown.split('\n');
      sections.push(
        `Target markdown (${targetLines.length} lines):`,
        this.formatTextPreview(this.context.targetMarkdown, 'target'),
        '',
      );
    }

    if (this.context.diffString !== undefined) {
      const diffLines = this.context.diffString.split('\n');
      sections.push(
        `Diff string (${diffLines.length} lines):`,
        this.formatTextPreview(this.context.diffString, 'diff'),
        '',
      );
    }

    // Add diff analysis
    if (this.context.diffString && this.context.originalMarkdown) {
      sections.push(...this.analyzeDiff());
    }

    // Add editor state info if available
    if (this.context.editorState) {
      sections.push(
        'Editor state:',
        JSON.stringify(this.context.editorState, null, 2).substring(0, 500) +
          '...',
        '',
      );
    }

    // Add additional context
    if (this.context.additionalInfo) {
      sections.push(
        'Additional info:',
        JSON.stringify(this.context.additionalInfo, null, 2),
        '',
      );
    }

    // Add original error if present
    if (this.originalError) {
      sections.push(
        'Original error:',
        this.originalError.stack || this.originalError.message,
        '',
      );
    }

    sections.push('=== END DIFF ERROR DETAILS ===');

    return sections.join('\n');
  }

  private formatTextPreview(text: string, label: string): string {
    const lines = text.split('\n');
    const preview: string[] = [];

    // First few lines
    preview.push(`  First 5 lines of ${label}:`);
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      preview.push(`    ${i + 1}: ${lines[i]}`);
    }

    if (lines.length > 10) {
      preview.push('    ...');
    }

    // Last few lines (if text is long enough)
    if (lines.length > 5) {
      preview.push(`  Last 3 lines of ${label}:`);
      for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) {
        preview.push(`    ${i + 1}: ${lines[i]}`);
      }
    }

    preview.push(`  Character count: ${text.length}`);
    preview.push(`  Line count: ${lines.length}`);
    preview.push(`  Ends with newline: ${text.endsWith('\n')}`);

    return preview.join('\n');
  }

  private analyzeDiff(): string[] {
    const analysis: string[] = ['=== DIFF ANALYSIS ==='];

    if (!this.context.diffString || !this.context.originalMarkdown) {
      return analysis;
    }

    const diffLines = this.context.diffString.split('\n');
    const originalLines = this.context.originalMarkdown.split('\n');

    // Extract hunk headers
    const hunkHeaders = diffLines.filter((line) => line.startsWith('@@'));
    analysis.push(`Found ${hunkHeaders.length} diff hunks:`);

    hunkHeaders.forEach((header, i) => {
      analysis.push(`  Hunk ${i + 1}: ${header}`);

      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = header.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      if (match) {
        const [, oldStart, oldCount, newStart, newCount] = match;
        analysis.push(
          `    Expected old lines: ${oldStart}-${
            parseInt(oldStart) + parseInt(oldCount) - 1
          } (${oldCount} lines)`,
        );
        analysis.push(
          `    Target new lines: ${newStart}-${
            parseInt(newStart) + parseInt(newCount) - 1
          } (${newCount} lines)`,
        );
        analysis.push(`    Original has lines 1-${originalLines.length}`);

        // Check if the ranges make sense
        if (
          parseInt(oldStart) + parseInt(oldCount) - 1 >
          originalLines.length
        ) {
          analysis.push(
            `    ❌ ERROR: Diff expects more lines than original has!`,
          );
        }
      }
    });

    // Count diff line types
    const addLines = diffLines.filter((line) => line.startsWith('+')).length;
    const removeLines = diffLines.filter((line) => line.startsWith('-')).length;
    const contextLines = diffLines.filter((line) =>
      line.startsWith(' '),
    ).length;
    const headerLines = diffLines.filter(
      (line) =>
        line.startsWith('@@') ||
        line.startsWith('---') ||
        line.startsWith('+++'),
    ).length;

    analysis.push('');
    analysis.push('Diff line breakdown:');
    analysis.push(`  Header lines (---, +++, @@): ${headerLines}`);
    analysis.push(`  Add lines (+): ${addLines}`);
    analysis.push(`  Remove lines (-): ${removeLines}`);
    analysis.push(`  Context lines ( ): ${contextLines}`);
    analysis.push(`  Total lines: ${diffLines.length}`);

    // Check for common issues
    if (diffLines.some((line) => line.includes('No newline at end of file'))) {
      analysis.push(`  ⚠️  Contains "No newline at end of file" markers`);
    }

    if (diffLines.some((line) => line.includes('\r'))) {
      analysis.push(`  ⚠️  Contains Windows line endings (\\r)`);
    }

    return analysis;
  }
}

/**
 * Context information for diff errors
 */
export interface DiffErrorContext {
  originalMarkdown?: string;
  targetMarkdown?: string;
  diffString?: string;
  editorState?: any;
  operation?: string;
  nodeType?: string;
  handlerName?: string;
  additionalInfo?: Record<string, any>;
}

/**
 * Create a DiffError for patch application failures
 */
export function createPatchError(
  originalMarkdown: string,
  diffString: string,
  originalError?: Error,
): DiffError {
  const originalLines = originalMarkdown.split('\n');
  const diffLines = diffString.split('\n');

  // Extract expected line count from diff
  const hunkMatch = diffString.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
  const expectedOldLines = hunkMatch ? parseInt(hunkMatch[2]) : 'unknown';

  const message = [
    'Failed to apply patch. The diff does not match the current content.',
    `Original text has ${originalLines.length} lines, diff expects ${expectedOldLines} lines.`,
    `Diff has ${diffLines.length} total lines.`,
  ].join('\n');

  return new DiffError(
    message,
    'PATCH_APPLICATION_FAILED',
    {
      originalMarkdown,
      diffString,
      operation: 'applyPatch',
      additionalInfo: {
        originalLineCount: originalLines.length,
        expectedLineCount: expectedOldLines,
        diffLineCount: diffLines.length,
        hunkHeader: hunkMatch ? hunkMatch[0] : 'not found',
      },
    },
    originalError,
  );
}

/**
 * Create a DiffError for invalid diff format
 */
export function createInvalidDiffError(
  diffString: string,
  reason: string,
): DiffError {
  return new DiffError(
    `Invalid markdown diff format: ${reason}`,
    'INVALID_DIFF_FORMAT',
    {
      diffString,
      operation: 'parseDiff',
      additionalInfo: {
        reason,
        hasUnifiedDiffHeaders:
          diffString.includes('---') && diffString.includes('+++'),
        hasHunkHeaders: diffString.includes('@@'),
        diffLength: diffString.length,
      },
    },
  );
}

/**
 * Create a DiffError for handler failures
 */
export function createHandlerError(
  handlerName: string,
  operation: string,
  context: any,
  originalError?: Error,
): DiffError {
  return new DiffError(
    `Handler ${handlerName} failed during ${operation}`,
    'HANDLER_FAILED',
    {
      operation,
      handlerName,
      additionalInfo: context,
    },
    originalError,
  );
}

/**
 * Create a DiffError for node mapping failures
 */
export function createMappingError(
  reason: string,
  sourceState?: any,
  targetState?: any,
): DiffError {
  return new DiffError(
    `Node mapping failed: ${reason}`,
    'NODE_MAPPING_FAILED',
    {
      operation: 'buildNodeMappings',
      additionalInfo: {
        reason,
        sourceNodeCount: sourceState?.children?.length || 'unknown',
        targetNodeCount: targetState?.children?.length || 'unknown',
      },
    },
  );
}

/**
 * Create a DiffError for text replacement failures
 */
export function createTextReplacementError(
  originalMarkdown: string,
  replacement: {oldText: string; newText: string},
): DiffError {
  return new DiffError(
    `Text replacement failed: Old text "${replacement.oldText}" not found in original markdown`,
    'TEXT_REPLACEMENT_FAILED',
    {
      originalMarkdown,
      operation: 'applyTextReplacement',
      additionalInfo: {
        targetText: replacement.oldText,
        replacementText: replacement.newText,
        originalMarkdownLength: originalMarkdown.length,
        originalMarkdownLines: originalMarkdown.split('\n').length,
        searchTextLength: replacement.oldText.length,
        replacementTextLength: replacement.newText.length,
      },
    },
  );
}
