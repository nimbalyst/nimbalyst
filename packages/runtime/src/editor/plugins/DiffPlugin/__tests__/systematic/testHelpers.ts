/**
 * Systematic test utilities for diff testing
 * Pattern: old markdown → apply diff → verify visualization → accept/reject → verify result
 */

import {LexicalEditor, $getRoot, $isElementNode} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '../../../../markdown';
import {applyMarkdownReplace} from '../../core/diffUtils';
import {$getDiffState, $clearDiffState} from '../../core/DiffState';
import {createTestHeadlessEditor} from '../utils/testConfig';
import {getAllNodes} from '../utils';

export interface DiffTestCase {
  name: string;
  oldMarkdown: string;
  newMarkdown: string;
  expectedVisualization?: {
    added?: string[];    // Text content of nodes that should be marked as added
    removed?: string[];  // Text content of nodes that should be marked as removed
    modified?: string[]; // Text content of nodes that should be marked as modified
  };
}

export interface DiffTestResult {
  visualization: {
    added: Array<{text: string; type: string; position: number}>;
    removed: Array<{text: string; type: string; position: number}>;
    modified: Array<{text: string; type: string; position: number}>;
  };
  acceptMarkdown: string;
  rejectMarkdown: string;
}

/**
 * Run a complete diff test: old→new→accept/reject
 */
export function runDiffTest(testCase: DiffTestCase): DiffTestResult {
  const {oldMarkdown, newMarkdown} = testCase;
  const editor = createTestHeadlessEditor();
  const transformers = getEditorTransformers();

  // Load old markdown
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, transformers);
    },
    {discrete: true},
  );

  // Apply diff
  editor.update(
    () => {
      const original = $convertToEnhancedMarkdownString(transformers);
      applyMarkdownReplace(
        editor,
        original,
        [{oldText: oldMarkdown, newText: newMarkdown}],
        transformers,
      );
    },
    {discrete: true},
  );

  // Capture visualization state
  const visualization = editor.getEditorState().read(() => {
    const root = $getRoot();
    const allChildren = root.getChildren();

    const states = {
      added: [] as Array<{text: string; type: string; position: number}>,
      removed: [] as Array<{text: string; type: string; position: number}>,
      modified: [] as Array<{text: string; type: string; position: number}>,
    };

    allChildren.forEach((node, index) => {
      if (!$isElementNode(node)) return;

      const state = $getDiffState(node);
      const text = node.getTextContent().trim();
      const type = node.getType();

      if (!text) return;

      if (state === 'added') {
        states.added.push({text, type, position: index});
      } else if (state === 'removed') {
        states.removed.push({text, type, position: index});
      } else if (state === 'modified') {
        states.modified.push({text, type, position: index});
      }
    });

    return states;
  });

  // Test accept: should produce newMarkdown
  const acceptEditor = createTestHeadlessEditor();
  acceptEditor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, transformers);
    },
    {discrete: true},
  );

  acceptEditor.update(
    () => {
      const original = $convertToEnhancedMarkdownString(transformers);
      applyMarkdownReplace(
        acceptEditor,
        original,
        [{oldText: oldMarkdown, newText: newMarkdown}],
        transformers,
      );
    },
    {discrete: true},
  );

  // Apply accept: clears all diff markers, keeping the changes
  acceptEditor.update(
    () => {
      const root = $getRoot();
      root.getChildren().forEach(child => {
        if ($isElementNode(child)) {
          // Clear diff state to accept changes
          const diffState = $getDiffState(child);
          if (diffState) {
            // For modified/added nodes, we keep them (they're already in the tree)
            // For removed nodes, we would delete them, but applyMarkdownReplace
            // doesn't create removed nodes in this test setup
            $clearDiffState(child);
          }
        }
      });
    },
    {discrete: true},
  );

  const acceptMarkdown = acceptEditor.getEditorState().read(() => {
    return $convertToEnhancedMarkdownString(transformers);
  });

  // Test reject: should produce oldMarkdown
  const rejectEditor = createTestHeadlessEditor();
  rejectEditor.update(
    () => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, transformers);
    },
    {discrete: true},
  );

  rejectEditor.update(
    () => {
      const original = $convertToEnhancedMarkdownString(transformers);
      applyMarkdownReplace(
        rejectEditor,
        original,
        [{oldText: oldMarkdown, newText: newMarkdown}],
        transformers,
      );
    },
    {discrete: true},
  );

  // TODO: Apply reject operation here once we have the reject API

  const rejectMarkdown = rejectEditor.getEditorState().read(() => {
    return $convertToEnhancedMarkdownString(transformers);
  });

  return {
    visualization,
    acceptMarkdown,
    rejectMarkdown,
  };
}

/**
 * Normalize markdown for comparison (handle whitespace differences)
 */
export function normalizeMarkdown(markdown: string): string {
  return markdown.trim();
}
