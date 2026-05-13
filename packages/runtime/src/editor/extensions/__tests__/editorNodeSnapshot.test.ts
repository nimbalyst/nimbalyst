/**
 * Regression guard for the node set the Nimbalyst editor instantiates.
 *
 * Phase 7 collapsed `EditorNodes.ts` + `pluginRegistry.getAllNodes()` into
 * a single composed dependency graph rooted in
 * `NimbalystEditorExtensions.ts`. The composer pulls each node from the
 * extension that owns it; dropping an extension from the `dependencies`
 * list silently drops every node that extension declared, which would only
 * surface at runtime as "unknown node type" exceptions during import.
 *
 * This test snapshots the registered node-type names so any future change
 * to the dependency list trips immediately. If a node legitimately moves
 * out or a new one is added, update `EXPECTED_NODE_TYPES`; do not delete
 * the assertion.
 */

import { describe, expect, it } from 'vitest';
import { buildEditorFromExtensions } from '@lexical/extension';

import { buildNimbalystRootExtension } from '../NimbalystEditorExtensions';
import '../registerBuiltinExtensions';

/**
 * Node types that the editor MUST register. Includes Lexical built-ins
 * (root, text, paragraph, linebreak, tab, artificial) plus every node
 * owned by a Nimbalyst built-in extension. Sorted alphabetically.
 */
const EXPECTED_NODE_TYPES = [
  'artificial',
  'autolink',
  'board-header',
  'code',
  'code-highlight',
  'collapsible-container',
  'collapsible-content',
  'collapsible-title',
  'embedded-file',
  'emoji',
  'hashtag',
  'heading',
  'horizontalrule',
  'image',
  'kanban-board',
  'kanban-card',
  'kanban-column',
  'kanban-column-content',
  'kanban-column-header',
  'layout-container',
  'layout-item',
  'linebreak',
  'link',
  'list',
  'listitem',
  'mark',
  'mermaid',
  'overflow',
  'page-break',
  'paragraph',
  'quote',
  'root',
  'tab',
  'table',
  'tablecell',
  'tablerow',
  'text',
];

describe('Nimbalyst editor node-set snapshot', () => {
  it('registers exactly the expected node set in standalone mode', () => {
    const root = buildNimbalystRootExtension({ editable: true });
    const editor = buildEditorFromExtensions(root);
    try {
      const registered = Array.from(editor._nodes.keys()).sort();
      expect(registered).toEqual(EXPECTED_NODE_TYPES);
    } finally {
      editor.dispose();
    }
  });

  it('registers the same node set when collaboration mode is on', () => {
    // Collaboration mode swaps out HistoryExtension but must not move
    // any node-bearing extension out of the dependency graph.
    const root = buildNimbalystRootExtension({
      editable: true,
      collaboration: true,
    });
    const editor = buildEditorFromExtensions(root);
    try {
      const registered = Array.from(editor._nodes.keys()).sort();
      expect(registered).toEqual(EXPECTED_NODE_TYPES);
    } finally {
      editor.dispose();
    }
  });
});
