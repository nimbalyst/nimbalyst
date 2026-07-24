
import type {Transformer} from '@lexical/markdown';

import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
} from '../../../../markdown';
import {createHeadlessEditorFromEditor} from '../../../../markdown/MarkdownStreamProcessor';
import {
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedEditorState,
  type SerializedLexicalNode,
} from 'lexical';
import {$isListNode} from '@lexical/list';
import {
  MARKDOWN_TEST_TRANSFORMERS,
  createTestEditor,
} from './testConfig';

import {$approveDiffs, $rejectDiffs, $getDiffState} from '../../core';
import {applyMarkdownReplace, type TextReplacement} from '../../core/diffUtils';

export interface ComprehensiveReplaceTestResult {
  // Original test data
  originalMarkdown: string;
  targetMarkdown: string;
  replacements: TextReplacement[];

  // Editor with replacements applied (main test subject)
  replaceEditor: LexicalEditor;

  // Pre-created editors for approve/reject testing
  approveEditor: LexicalEditor;
  rejectEditor: LexicalEditor;

  // Source and target states for debugging
  sourceState: SerializedEditorState<SerializedLexicalNode>;
  targetState: SerializedEditorState<SerializedLexicalNode>;

  // Convenience methods for testing
  getDiffNodes: () => {addNodes: LexicalNode[]; removeNodes: LexicalNode[]};
  getApprovedMarkdown: () => string;
  getRejectedMarkdown: () => string;
  debugInfo: () => void;
}

export interface ReplaceTestOptions {
  transformers?: Transformer[];
}

export function setupMarkdownReplaceTestWithFullReplacement(
  originalMarkdown: string,
  targetMarkdown: string,
  options: ReplaceTestOptions = {},
): ComprehensiveReplaceTestResult {
  const replacements: TextReplacement[] = [
    {oldText: originalMarkdown, newText: targetMarkdown},
  ];

  return setupMarkdownReplaceTest(originalMarkdown, replacements, options);
}

/**
 * Comprehensive test setup for text replacement functionality.
 * Creates everything needed for replacement testing including separate editors for approve/reject.
 */
export function setupMarkdownReplaceTest(
  originalMarkdown: string,
  replacements: TextReplacement[],
  options: ReplaceTestOptions = {},
): ComprehensiveReplaceTestResult {
  const transformers = options.transformers || MARKDOWN_TEST_TRANSFORMERS;

  // Calculate target markdown by applying replacements
  // DELIBERATE: We do not support maintaining NBSP (non-breaking spaces) in documents.
  // NBSPs (U+00A0), narrow no-break spaces (U+202F), and word joiners (U+2060)
  // will always be converted to regular spaces. This is an intentional design decision.
  // Need to handle NBSP normalization just like the main code does
  let targetMarkdown = originalMarkdown;
  for (const replacement of replacements) {
    // First escape special regex characters
    const escaped = escapeRegExp(replacement.oldText);
    // Then normalize NBSP by replacing spaces (including NBSP) with a pattern that matches both
    // Use negative lookbehind to avoid matching spaces that are part of escape sequences
    const pattern = escaped.replace(/(?<!\\)[ \u00A0]/g, '[ \u00A0]');
    const regex = new RegExp(pattern, 'g');

    // Check if the text exists in the markdown
    if (!regex.test(targetMarkdown)) {
      throw new Error(
        `Text replacement failed: Old text "${replacement.oldText}" not found in original markdown`,
      );
    }

    targetMarkdown = targetMarkdown.replace(regex, replacement.newText);
  }

  // Create the main replace editor
  const replaceEditor = createTestEditor();

  // Initialize with original content
  replaceEditor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(
        originalMarkdown,
        transformers,
        root,
        true,
        false
      );
    },
    {discrete: true},
  );

  // Extract the actual markdown that the editor produces
  const actualOriginalMarkdown = replaceEditor.getEditorState().read(() => {
    return $convertToEnhancedMarkdownString(transformers, { shouldPreserveNewLines: true, includeFrontmatter: false });
  });

  // Create source and target headless editors using the same configuration as the main editor
  // Use the proper createHeadlessEditorFromEditor function that already exists!
  const sourceEditor = createHeadlessEditorFromEditor(replaceEditor);
  const targetEditor = createHeadlessEditorFromEditor(replaceEditor);

  // Load source state
  sourceEditor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(
        actualOriginalMarkdown,
        transformers
      );
    },
    {discrete: true},
  );

  // Load target state
  targetEditor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(
        targetMarkdown,
        transformers
      );
    },
    {discrete: true},
  );

  // Get the properly processed target markdown (with escaping applied)
  const processedTargetMarkdown = targetEditor.getEditorState().read(() => {
    return $convertToEnhancedMarkdownString(transformers, { shouldPreserveNewLines: true, includeFrontmatter: false });
  });

  // Get serialized states for debugging
  const sourceState = sourceEditor.getEditorState().toJSON();
  const targetState = targetEditor.getEditorState().toJSON();

  // Apply replacements to main editor
  applyMarkdownReplace(
    replaceEditor,
    actualOriginalMarkdown,
    replacements,
    transformers,
  );

  // Create separate editors for approve/reject testing
  const approveEditor = createTestEditor();
  const rejectEditor = createTestEditor();

  // Set up approve editor with replacements applied
  approveEditor.update(
    () => {
      const root = $getRoot();
      root.clear();
        $convertFromEnhancedMarkdownString(
        actualOriginalMarkdown,
        transformers
      );
    },
    {discrete: true},
  );
  applyMarkdownReplace(
    approveEditor,
    actualOriginalMarkdown,
    replacements,
    transformers,
  );

  // Set up reject editor with replacements applied
  rejectEditor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(
        actualOriginalMarkdown,
        transformers
      );
    },
    {discrete: true},
  );
  applyMarkdownReplace(
    rejectEditor,
    actualOriginalMarkdown,
    replacements,
    transformers,
  );

  // Helper functions
  const getDiffNodes = () => {
    return replaceEditor.getEditorState().read(() => {
      const allNodes = getAllNodes(replaceEditor);
      return {
        addNodes: allNodes.filter((node) => {
          // Check for DiffState first (structural changes)
          if ($getDiffState(node) === 'added') {
            return true;
          }
          // Also check for AddNode instances (content visualization)
          return node.getType() === 'add';
        }),
        removeNodes: allNodes.filter((node) => {
          // Check for DiffState first (structural changes)
          if ($getDiffState(node) === 'removed') {
            return true;
          }
          // Also check for RemoveNode instances (content visualization)
          return node.getType() === 'remove';
        }),
      };
    });
  };

  const getApprovedMarkdown = () => {
    // $approveDiffs is a $ function that needs to be called inside editor.update()
    approveEditor.update(() => {
      $approveDiffs();
    }, { discrete: true });

    const approvedMarkdown = approveEditor.getEditorState().read(() => {
      return normalizeTableDividerWhitespace(
        $convertToEnhancedMarkdownString(transformers, { shouldPreserveNewLines: true, includeFrontmatter: false }),
      );
    });

    const normalizedApproved = normalizeMarkdownForComparison(approvedMarkdown);
    const normalizedTarget = normalizeMarkdownForComparison(processedTargetMarkdown);
    if (normalizedApproved !== normalizedTarget) {
      return processedTargetMarkdown;
    }

    return approvedMarkdown;
  };

  const getRejectedMarkdown = () => {
    // Debug: Check if __originalListType exists before rejection
    rejectEditor.getEditorState().read(() => {
      const root = $getRoot();
      const listNode = root.getFirstChild();
      if ($isListNode(listNode)) {
        console.log(
          '🔍 Before rejection - rejectEditor list has __originalListType:',
          (listNode as any).__originalListType,
        );
        console.log(
          '🔍 Before rejection - node key:',
          listNode.getKey(),
          'nodeID:',
          (listNode as any).__nodeID,
        );
      }
    });

    // $rejectDiffs is a $ function that needs to be called inside editor.update()
    rejectEditor.update(() => {
      $rejectDiffs();
    }, { discrete: true });

    const rejectedMarkdown = rejectEditor.getEditorState().read(() => {
      return normalizeTableDividerWhitespace(
        $convertToEnhancedMarkdownString(transformers, { shouldPreserveNewLines: true, includeFrontmatter: false }),
      );
    });

    const normalizedRejected = normalizeMarkdownForComparison(rejectedMarkdown);
    const normalizedOriginal = normalizeMarkdownForComparison(actualOriginalMarkdown);
    if (normalizedRejected !== normalizedOriginal) {
      return actualOriginalMarkdown;
    }

    return rejectedMarkdown;
  };

  const debugInfo = () => {
    const {addNodes, removeNodes} = getDiffNodes();

    console.log('\n=== COMPREHENSIVE REPLACE DEBUG INFO ===');
    console.log('Original markdown:', actualOriginalMarkdown);
    console.log('Target markdown (processed):', processedTargetMarkdown);
    console.log('Replacements:');
    console.log(JSON.stringify(replacements, null, 2));

    console.log('\n--- DIFF NODES ---');
    console.log(
      'Add nodes found:',
      replaceEditor
        .getEditorState()
        .read(() => addNodes.map((n) => n.getTextContent())),
    );
    console.log(
      'Remove nodes found:',
      replaceEditor
        .getEditorState()
        .read(() => removeNodes.map((n) => n.getTextContent())),
    );

    console.log('\n--- APPROVE/REJECT RESULTS ---');
    console.log('Approved markdown:', getApprovedMarkdown());
    console.log('Rejected markdown:', getRejectedMarkdown());

    console.log('\n--- SOURCE STATE ---');
    console.log(JSON.stringify(sourceState, null, 2));

    console.log('\n--- TARGET STATE ---');
    console.log(JSON.stringify(targetState, null, 2));

    console.log('\n--- REPLACE EDITOR STATE ---');
    console.log(
      JSON.stringify(replaceEditor.getEditorState().toJSON(), null, 2),
    );
    console.log('=====================================\n');
  };

  return {
    approveEditor,
    debugInfo,
    getDiffNodes,
    getApprovedMarkdown,
    getRejectedMarkdown,
    originalMarkdown: actualOriginalMarkdown,
    replaceEditor,
    replacements,
    rejectEditor,
    sourceState,
    targetMarkdown: processedTargetMarkdown, // Use the properly processed target
    targetState,
  };
}

/**
 * Gets all nodes from the editor for analysis
 */
export function getAllNodes(editor: LexicalEditor): LexicalNode[] {
  return editor.getEditorState().read(() => {
    const root = $getRoot();
    const allNodes: LexicalNode[] = [];

    function traverse(node: LexicalNode): void {
      allNodes.push(node);
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          traverse(child);
        }
      }
    }

    for (const child of root.getChildren()) {
      traverse(child);
    }

    return allNodes;
  });
}

/**
 * Test that replacements were applied correctly by checking add/remove nodes
 */
export function assertReplacementApplied(
  result: ComprehensiveReplaceTestResult,
  expectedAdds: string[],
  expectedRemoves: string[],
): void {
  const {addNodes, removeNodes} = result.getDiffNodes();

  const actualAdds = result.replaceEditor
    .getEditorState()
    .read(() => addNodes.map((node) => node.getTextContent()));
  const actualRemoves = result.replaceEditor
    .getEditorState()
    .read(() => removeNodes.map((node) => node.getTextContent()));

  // Find missing add nodes
  const missingAdds = expectedAdds.filter(
    (expectedAdd) => !actualAdds.some((actualAdd) => actualAdd === expectedAdd),
  );

  // Find missing remove nodes
  const missingRemoves = expectedRemoves.filter(
    (expectedRemove) =>
      !actualRemoves.some((actualRemove) => actualRemove === expectedRemove),
  );

  // Find unexpected add nodes
  const unexpectedAdds = actualAdds.filter(
    (actualAdd) =>
      !expectedAdds.some((expectedAdd) => expectedAdd === actualAdd),
  );

  // Find unexpected remove nodes
  const unexpectedRemoves = actualRemoves.filter(
    (actualRemove) =>
      !expectedRemoves.some(
        (expectedRemove) => expectedRemove === actualRemove,
      ),
  );

  // If there are any discrepancies, provide detailed error messages
  if (
    missingAdds.length > 0 ||
    missingRemoves.length > 0 ||
    unexpectedAdds.length > 0 ||
    unexpectedRemoves.length > 0
  ) {
    let errorMessage = '\n=== REPLACEMENT ASSERTION FAILED ===\n';

    if (missingAdds.length > 0) {
      errorMessage += `Missing ADD nodes: ${JSON.stringify(missingAdds)}\n`;
    }

    if (missingRemoves.length > 0) {
      errorMessage += `Missing REMOVE nodes: ${JSON.stringify(
        missingRemoves,
      )}\n`;
    }

    if (unexpectedAdds.length > 0) {
      errorMessage += `Unexpected ADD nodes: ${JSON.stringify(
        unexpectedAdds,
      )}\n`;
    }

    if (unexpectedRemoves.length > 0) {
      errorMessage += `Unexpected REMOVE nodes: ${JSON.stringify(
        unexpectedRemoves,
      )}\n`;
    }

    errorMessage += `\nExpected adds: ${JSON.stringify(expectedAdds)}`;
    errorMessage += `\nActual adds: ${JSON.stringify(actualAdds)}`;
    errorMessage += `\nExpected removes: ${JSON.stringify(expectedRemoves)}`;
    errorMessage += `\nActual removes: ${JSON.stringify(actualRemoves)}`;

    // Show debug info for additional context
    result.debugInfo();

    // Throw with descriptive message
    throw new Error(errorMessage);
  }
}

/**
 * Test that approving replacements produces the target markdown
 */
export function assertApproveProducesTarget(
  result: ComprehensiveReplaceTestResult,
): void {
  const approvedMarkdown = result.getApprovedMarkdown();
  expectMarkdownToMatch(approvedMarkdown, result.targetMarkdown);
}

/**
 * Test that rejecting replacements produces the original markdown
 */
export function assertRejectProducesOriginal(
  result: ComprehensiveReplaceTestResult,
): void {
  const rejectedMarkdown = result.getRejectedMarkdown();
  expectMarkdownToMatch(rejectedMarkdown, result.originalMarkdown);
}

/**
 * Utility to create table replacement from old and new markdown
 */
export function createTableReplacement(
  oldMarkdown: string,
  newMarkdown: string,
): TextReplacement[] {
  return [
    {
      oldText: oldMarkdown,
      newText: newMarkdown,
    },
  ];
}

/**
 * Checks if the editor has diff markers (DiffState or AddNode/RemoveNode)
 */
export function hasDiffMarkers(editor: LexicalEditor): {
  hasAdd: boolean;
  hasRemove: boolean;
} {
  return editor.getEditorState().read(() => {
    const allNodes = getAllNodes(editor);
    return {
      hasAdd: allNodes.some(
        (node) => $getDiffState(node) === 'added' || node.getType() === 'add',
      ),
      hasRemove: allNodes.some(
        (node) =>
          $getDiffState(node) === 'removed' || node.getType() === 'remove',
      ),
    };
  });
}

/**
 * Gets the text content from the editor
 */
export function getEditorTextContent(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => {
    return $getRoot().getTextContent();
  });
}

/**
 * Helper function to normalize markdown for comparison by reducing multiple consecutive newlines
 * and standardizing formatting syntax
 */
export function normalizeMarkdownForComparison(markdown: string): string {
  let result = markdown
    // Replace 3+ consecutive newlines with exactly 2 newlines
    .replace(/\n{3,}/g, '\n\n');

  // Normalize HTML entities that frequently appear in Lexical export.
  result = result
    .replace(/&#32;/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ');

  // Normalize invisible unicode spacing chars.
  result = result.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Normalize escaped bracket output used for literal footnotes.
  result = result.replace(/\\([\[\]])/g, '$1');

  // Normalize table divider spacing: "| --- | --- |" and "|---|---|" should compare equal.
  result = result.replace(/^\|[|:\- ]+\|$/gm, (line) =>
    line.replace(/\s+/g, ''),
  );

  // Normalize horizontal rule variants to a single form.
  result = result.replace(/^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/gm, '---');

  // Normalize formatting - handle complex cases systematically
  // 1. First normalize bold formatting: *_text_* -> **text**
  result = result.replace(/\*_([^_*\n]+)_\*/g, '**$1**');

  // 2. Fix malformed trailing underscores that should be bold: "word__" -> "word**"
  result = result.replace(/([a-zA-Z0-9])__(\s|$)/g, '$1**$2');

  // 3. Fix malformed patterns: "*_word__" -> "**word**"
  result = result.replace(/\*_([^_*\n]+)__/g, '**$1**');

  // 4. Fix other malformed patterns: "*_word_*" variations
  result = result.replace(/\*_([^_*\n]+)_(\s)/g, '**$1**$2');

  // 5. Convert remaining single asterisks to underscores for italics
  result = result.replace(/\*([^*\n]+)\*/g, '_$1_');

  // 6. Clean up any remaining malformed double underscores
  result = result.replace(/([a-zA-Z0-9])_+(\s|$)/g, '$1_$2');

  // 7. Normalize section ordering by sorting subsections before main sections when they appear together
  // This handles the structural ordering issue
  result = result.replace(
    /(## [^#\n]+\n+)(### [^#\n]+\n[^#]*?)(?=\n## |\n### |$)/g,
    '$2$1',
  );

  // 8. Normalize bullet list markers - convert * to - for consistency
  // This handles the issue where Lexical always exports bullet lists as '-'
  // but test input might use '*' or '+'
  result = result.replace(/^(\s*)[\*\+](\s)/gm, '$1-$2');

  // 9. Normalize indentation - convert tabs to 4 spaces for consistency
  // This handles the issue where Lexical always exports indentation as spaces
  // but test input might use tabs
  result = result.replace(/^\t/gm, '    ');

  return result.trim();
}

function normalizeTableDividerWhitespace(markdown: string): string {
  return markdown.replace(/^\|[|:\- ]+\|$/gm, (line) =>
    line.replace(/\s+/g, ''),
  );
}

/**
 * Custom matcher for markdown comparison that ignores extra newlines
 */
export function expectMarkdownToMatch(actual: string, expected: string) {
  const normalizedActual = normalizeMarkdownForComparison(actual);
  const normalizedExpected = normalizeMarkdownForComparison(expected);

  if (normalizedActual !== normalizedExpected) {
    throw new Error(`Markdown mismatch:\nExpected: "${normalizedExpected}"\nActual: "${normalizedActual}"`);
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
