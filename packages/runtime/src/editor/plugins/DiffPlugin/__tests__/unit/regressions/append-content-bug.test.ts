/**
 * Test for larger document with appended content
 * When adding content to the end of a document, TOPT should recognize that
 * the existing content is unchanged and only show additions at the end.
 */

import {describe, expect, it} from 'vitest';
import {$getRoot, COMMAND_PRIORITY_EDITOR} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
} from '../../../../../markdown';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {$getDiffState} from '../../../core/DiffState';
import {APPLY_MARKDOWN_REPLACE_COMMAND} from '../../..';
import {applyMarkdownReplace} from '../../../core/exports';
import * as fs from 'fs';
import * as path from 'path';

describe('Larger document with appended content', () => {
  it('should only show additions when content is appended to end', async () => {
    // Read the actual test files
    const oldPath = path.join(__dirname, '../larger', 'test6-old.md');
    const newPath = path.join(__dirname, '../larger', 'test6-new.md');

    const oldMarkdown = fs.readFileSync(oldPath, 'utf8');
    const newMarkdown = fs.readFileSync(newPath, 'utf8');

    console.log('\n=== LARGER DOC APPEND TEST ===');
    console.log(`Old length: ${oldMarkdown.length} chars`);
    console.log(`New length: ${newMarkdown.length} chars`);

    const editor = createTestHeadlessEditor();

    // Register the command handler
    editor.registerCommand(
      APPLY_MARKDOWN_REPLACE_COMMAND,
      (payload) => {
        const replacements = Array.isArray(payload) ? payload : payload?.replacements;
        applyMarkdownReplace(editor, oldMarkdown, replacements as any, MARKDOWN_TEST_TRANSFORMERS);
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );

    // Load old markdown
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== OLD DOCUMENT STRUCTURE ===');
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      console.log(`Total children: ${children.length}`);

      children.forEach((child: any, i: number) => {
        const type = child.getType();
        const text = child.getTextContent().substring(0, 50).replace(/\n/g, '\\n');
        console.log(`[${i}] ${type}: "${text}"`);
      });
    });

    // Apply diff
    const replacements = [{ oldText: oldMarkdown, newText: newMarkdown }];
    const result = editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, replacements);

    if (!result) {
      console.error('APPLY_MARKDOWN_REPLACE_COMMAND was not handled!');
      throw new Error('Command not handled');
    }

    // Wait for async operations
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        const allNodes: Array<{
          index: number;
          type: string;
          text: string;
          diffState: any;
        }> = [];

        editor.getEditorState().read(() => {
          const root = $getRoot();
          const children = root.getChildren();

          children.forEach((child, i) => {
            const diffState = $getDiffState(child);
            const text = child.getTextContent().trim();

            allNodes.push({
              index: i,
              type: child.getType(),
              text: text.substring(0, 60),
              diffState,
            });
          });
        });

        console.log('\n=== DOCUMENT STRUCTURE AFTER DIFF ===');
        console.log(`Total nodes: ${allNodes.length}`);

        let addedCount = 0;
        let removedCount = 0;
        let modifiedCount = 0;
        let unchangedCount = 0;

        allNodes.forEach((n) => {
          const icon =
            n.diffState === 'added' ? '➕' :
            n.diffState === 'removed' ? '➖' :
            n.diffState === 'modified' ? '🔄' : '  ';

          if (n.diffState === 'added') addedCount++;
          else if (n.diffState === 'removed') removedCount++;
          else if (n.diffState === 'modified') modifiedCount++;
          else unchangedCount++;

          console.log(`[${n.index}] ${icon} ${n.type}: "${n.text}"`);
        });

        console.log('\n=== DIFF STATS ===');
        console.log(`Added: ${addedCount}`);
        console.log(`Removed: ${removedCount}`);
        console.log(`Modified: ${modifiedCount}`);
        console.log(`Unchanged: ${unchangedCount}`);

        // The bug: Content that should be unchanged gets marked as removed/modified
        // Expected: Most content should be unchanged, only new content at end should be added

        // Since we're appending content to the end:
        // - There should be NO removals (nothing was deleted)
        // - There should be additions only (new content at end)
        // - There might be some modifications if sections were expanded, but minimal

        console.log('\n=== VALIDATION ===');
        console.log(`Removals should be 0, got: ${removedCount}`);

        if (removedCount > 0) {
          console.log('\n=== REMOVED NODES (SHOULD BE NONE) ===');
          allNodes.filter(n => n.diffState === 'removed').forEach(n => {
            console.log(`[${n.index}] ${n.type}: "${n.text}"`);
          });
        }

        if (modifiedCount > 5) {
          console.log('\n=== MODIFIED NODES (SHOULD BE MINIMAL) ===');
          allNodes.filter(n => n.diffState === 'modified').forEach(n => {
            console.log(`[${n.index}] ${n.type}: "${n.text}"`);
          });
        }

        // Assertions:
        // 1. No content should be removed when we're only appending
        expect(removedCount).toBe(0);

        // 2. There should be additions for the new content
        expect(addedCount).toBeGreaterThan(0);

        // 3. Most of the existing content should be unchanged
        // Since old doc has ~37 lines of content, we expect most nodes to be unchanged
        expect(unchangedCount).toBeGreaterThan(20);

        resolve();
      }, 100);
    });
  });
});
