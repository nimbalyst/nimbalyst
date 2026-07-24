import type { Transformer } from '@lexical/markdown';
import type { Klass, LexicalEditor, LexicalNode } from 'lexical';
import { createEditor } from 'lexical';
import { createHeadlessEditor } from '@lexical/headless';

import EditorNodes from '../../../../nodes/EditorNodes';
import { getEditorTransformers } from '../../../../markdown';

// Side-effect import: runs every built-in extension's
// `setExtensionContributions` call so `getEditorTransformers()` returns
// the full transformer set (tables, mermaid, etc.) under test.
import '../../../../extensions/registerBuiltinExtensions';

// Nodes that the diff tests need but that are now registered by their
// extension rather than by `EditorNodes` (the editor instance built in
// tests doesn't go through `buildEditorFromExtensions`).
import { ImageNode } from '../../../ImagesPlugin/ImageNode';
import { PageBreakNode } from '../../../PageBreakPlugin/PageBreakNode';
import { MermaidNode } from '../../../MermaidPlugin/MermaidNode';
import {
  CollapsibleContainerNode,
  CollapsibleContentNode,
  CollapsibleTitleNode,
} from '../../../CollapsiblePlugin';
import { LayoutContainerNode } from '../../../LayoutPlugin/LayoutContainerNode';
import { LayoutItemNode } from '../../../LayoutPlugin/LayoutItemNode';
import { KanbanBoardNode } from '../../../KanbanBoardPlugin/KanbanBoardNode';
import { BoardHeaderNode } from '../../../KanbanBoardPlugin/BoardHeaderNode';
import { BoardColumnNode } from '../../../KanbanBoardPlugin/BoardColumnNode';
import { BoardColumnHeaderNode } from '../../../KanbanBoardPlugin/BoardColumnHeaderNode';
import { BoardColumnContentNode } from '../../../KanbanBoardPlugin/BoardColumnContentNode';
import { BoardCardNode } from '../../../KanbanBoardPlugin/BoardCardNode';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { ListNode, ListItemNode } from '@lexical/list';

export const MARKDOWN_TEST_TRANSFORMERS: Transformer[] = getEditorTransformers();

export const TEST_NODES: Array<Klass<LexicalNode>> = [
  ...EditorNodes,
  ImageNode,
  PageBreakNode,
  MermaidNode,
  CollapsibleContainerNode,
  CollapsibleContentNode,
  CollapsibleTitleNode,
  LayoutContainerNode,
  LayoutItemNode,
  KanbanBoardNode,
  BoardHeaderNode,
  BoardColumnNode,
  BoardColumnHeaderNode,
  BoardColumnContentNode,
  BoardCardNode,
  LinkNode,
  AutoLinkNode,
  HorizontalRuleNode,
  ListNode,
  ListItemNode,
];

export function createTestEditor(
  config: {
    namespace?: string;
    theme?: Record<string, unknown>;
    nodes?: ReadonlyArray<Klass<LexicalNode>>;
    onError?: (error: Error) => void;
  } = {},
): LexicalEditor {
  const customNodes = config.nodes || [];
  const editorConfig = {
    namespace: config.namespace || 'test',
    theme: config.theme || {},
    onError:
      config.onError ||
      ((e: Error) => {
        throw e;
      }),
    nodes: TEST_NODES.concat(customNodes as Array<Klass<LexicalNode>>),
  };

  const editor = createEditor(editorConfig);

  // Store the config so createHeadlessEditorFromEditor can access it
  (editor as unknown as { _createEditorArgs: typeof editorConfig })._createEditorArgs = editorConfig;
  return editor;
}

export function createTestHeadlessEditor(
  config: {
    nodes?: ReadonlyArray<Klass<LexicalNode>>;
    onError?: (error: Error) => void;
  } = {},
): LexicalEditor {
  const customNodes = config.nodes || [];
  return createHeadlessEditor({
    onError:
      config.onError ||
      ((error) => {
        throw error;
      }),
    nodes: TEST_NODES.concat(customNodes as Array<Klass<LexicalNode>>),
  });
}
