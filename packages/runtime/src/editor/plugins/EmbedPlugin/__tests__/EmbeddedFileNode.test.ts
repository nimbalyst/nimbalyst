import { createHeadlessEditor } from '@lexical/headless';
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import { $isLinkNode, LinkNode } from '@lexical/link';
import { $getRoot, $isElementNode, type LexicalEditor } from 'lexical';
import { describe, expect, it } from 'vitest';

import {
  $createEmbeddedFileNode,
  $isEmbeddedFileNode,
  EmbeddedFileNode,
} from '../EmbeddedFileNode';

function createEditor(namespace: string): LexicalEditor {
  return createHeadlessEditor({
    namespace,
    nodes: [EmbeddedFileNode, LinkNode],
    onError: (error: Error) => {
      throw error;
    },
  });
}

describe('EmbeddedFileNode DOM serialization', () => {
  it('round-trips embedded files through HTML', () => {
    const sourceEditor = createEditor('embedded-file-dom-export');
    sourceEditor.update(
      () => {
        $getRoot().append(
          $createEmbeddedFileNode({
            src: './architecture.excalidraw',
            label: 'Architecture',
            attrs: {
              caption: 'Overall architecture',
              width: '1000',
            },
          }),
        );
      },
      { discrete: true },
    );

    let html = '';
    sourceEditor.getEditorState().read(() => {
      html = $generateHtmlFromNodes(sourceEditor);
    });

    const exportedAnchor = new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector('a');
    expect(exportedAnchor?.getAttribute('data-lexical-embedded-file')).toBe(
      'true',
    );

    const destinationEditor = createEditor('embedded-file-dom-import');
    const dom = new DOMParser().parseFromString(html, 'text/html');
    destinationEditor.update(
      () => {
        $getRoot().append(...$generateNodesFromDOM(destinationEditor, dom));
      },
      { discrete: true },
    );

    destinationEditor.getEditorState().read(() => {
      const importedNode = $getRoot().getFirstChild();
      expect($isEmbeddedFileNode(importedNode)).toBe(true);
      if (!$isEmbeddedFileNode(importedNode)) return;
      expect(importedNode.getSrc()).toBe('./architecture.excalidraw');
      expect(importedNode.getLabel()).toBe('Architecture');
      expect(importedNode.getAttrs()).toEqual({
        caption: 'Overall architecture',
        width: '1000',
      });
    });
  });

  it('leaves ordinary anchors to LinkNode', () => {
    const editor = createEditor('embedded-file-dom-ordinary-link');
    const dom = new DOMParser().parseFromString(
      '<p><a href="https://example.com">Example</a></p>',
      'text/html',
    );

    editor.update(
      () => {
        $getRoot().append(...$generateNodesFromDOM(editor, dom));
      },
      { discrete: true },
    );

    editor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChild();
      const importedLink = $isElementNode(paragraph)
        ? paragraph.getFirstChild()
        : null;
      expect($isLinkNode(importedLink)).toBe(true);
    });
  });
});
