/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type { JSX } from 'react';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { TreeView } from '@lexical/react/LexicalTreeView';

import { $getDiffState } from '../DiffPlugin/core';

/**
 * Debug-only tree view, mounted when `EditorConfig.showTreeView` or the
 * `showTreeView` runtime setting is true. Wired from the "Toggle Debug
 * Tree" menu items in `UnifiedEditorHeaderBar` and the toolbar.
 *
 * Thin wrapper around `@lexical/react/LexicalTreeView` (which has no
 * `@lexical/extension` equivalent today). The custom `customPrintNode`
 * surfaces Nimbalyst's diff-state annotations next to each node so the
 * dev tree shows pending AI edits inline.
 */
export default function TreeViewPlugin(): JSX.Element {
  const [editor] = useLexicalComposerContext();

  function customPrintNode(node: any): string {
    const diffState = $getDiffState(node);
    return diffState ? `[${diffState}] ` : '';
  }

  return (
    <TreeView
      viewClassName="tree-view-output"
      treeTypeButtonClassName="debug-treetype-button"
      timeTravelPanelClassName="debug-timetravel-panel"
      timeTravelButtonClassName="debug-timetravel-button"
      timeTravelPanelSliderClassName="debug-timetravel-panel-slider"
      timeTravelPanelButtonClassName="debug-timetravel-panel-button"
      editor={editor}
      customPrintNode={customPrintNode}
    />
  );
}
