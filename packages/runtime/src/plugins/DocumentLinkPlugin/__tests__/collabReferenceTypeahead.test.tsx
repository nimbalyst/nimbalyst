/**
 * `@` typeahead insertion for shared-document references.
 *
 * In a local document, picking a `.mockup.html` / `.excalidraw` file inserts a
 * block-level embed. In a collaborative document the same pick has to produce
 * the same thing, carrying the `embedType` hint -- a collab deep link has no
 * file extension, so without the hint `isEmbeddableUrl` can never recognize it
 * and the reference stays a plain link forever (NIM-2473).
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { LinkNode } from '@lexical/link';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical';
import { afterEach, describe, expect, it } from 'vitest';

import type { DocumentService } from '../../../core/DocumentService';
import { DocumentLinkPlugin, type CollabReferenceSource } from '../index';
import { DocumentReferenceNode, $isDocumentReferenceNode } from '../DocumentLinkNode';
import {
  EmbeddedFileNode,
  $isEmbeddedFileNode,
} from '../../../editor/plugins/EmbedPlugin/EmbeddedFileNode';
import { setEmbeddableExtensions } from '../../../editor/plugins/EmbedPlugin/embeddableExtensions';

const ORG_TARGET = 'nimbalyst://doc/mockup-1?orgId=team-1';

type TypeaheadProps = {
  options: Array<{ id: string }>;
  onSelectOption: (
    option: { id: string },
    textNode: null,
    closeMenu: () => void,
    matchingString: string,
  ) => void;
  onOpen: () => void;
};

afterEach(() => {
  setEmbeddableExtensions([]);
});

function renderTypeahead(source: CollabReferenceSource) {
  let latest: TypeaheadProps | null = null;
  let editor: LexicalEditor | null = null;

  function TypeaheadStub(props: TypeaheadProps): null {
    latest = props;
    return null;
  }

  function CaptureEditor(): null {
    [editor] = useLexicalComposerContext();
    return null;
  }

  render(
    <LexicalComposer
      initialConfig={{
        namespace: 'collab-reference-typeahead-test',
        nodes: [LinkNode, DocumentReferenceNode, EmbeddedFileNode],
        onError: (error) => {
          throw error;
        },
      }}
    >
      <CaptureEditor />
      <DocumentLinkPlugin
        documentService={{} as DocumentService}
        TypeaheadMenuPlugin={TypeaheadStub}
        triggerFn={() => null}
        collabReferenceSource={source}
      />
    </LexicalComposer>,
  );

  return {
    get props() {
      if (!latest) throw new Error('typeahead never rendered');
      return latest;
    },
    get editor() {
      if (!editor) throw new Error('editor never captured');
      return editor;
    },
  };
}

/** Open the menu (loads options) and place the caret in a live paragraph. */
async function primeAndSelect(
  harness: ReturnType<typeof renderTypeahead>,
  documentId: string,
) {
  await act(async () => {
    harness.props.onOpen();
  });
  await act(async () => {
    harness.editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('');
        paragraph.append(text);
        $getRoot().clear().append(paragraph);
        text.select();
      },
      { discrete: true },
    );
  });

  const option = harness.props.options.find((o) => o.id === `doc-${documentId}`);
  expect(option).toBeDefined();
  await act(async () => {
    harness.props.onSelectOption(option!, null, () => {}, '');
  });
}

describe('collab `@` reference insertion', () => {
  it('inserts an embed carrying the embedType hint for an embeddable shared doc', async () => {
    setEmbeddableExtensions(['.mockup.html']);
    const harness = renderTypeahead({
      listOptions: () => [
        {
          documentId: 'mockup-1',
          title: 'unified-quick-open.mockup.html',
          target: ORG_TARGET,
          embedType: '.mockup.html',
        },
      ],
      openReference: () => {},
    });

    await primeAndSelect(harness, 'mockup-1');

    harness.editor.getEditorState().read(() => {
      const embed = $getRoot()
        .getChildren()
        .find($isEmbeddedFileNode);
      expect($isEmbeddedFileNode(embed)).toBe(true);
      if (!$isEmbeddedFileNode(embed)) return;
      expect(embed.getSrc()).toBe(ORG_TARGET);
      expect(embed.getLabel()).toBe('unified-quick-open.mockup.html');
      expect(embed.getAttrs()).toEqual({ embedType: '.mockup.html' });
    });
  });

  it('still inserts a plain reference for a shared markdown doc', async () => {
    setEmbeddableExtensions(['.mockup.html']);
    const harness = renderTypeahead({
      listOptions: () => [
        {
          documentId: 'spec-1',
          title: 'Product spec',
          target: 'nimbalyst://doc/spec-1?orgId=team-1',
          embedType: '.md',
        },
      ],
      openReference: () => {},
    });

    await primeAndSelect(harness, 'spec-1');

    harness.editor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChild();
      const nodes = paragraph && 'getChildren' in paragraph
        ? (paragraph as ReturnType<typeof $createParagraphNode>).getChildren()
        : [];
      expect(nodes.some($isDocumentReferenceNode)).toBe(true);
      expect($getRoot().getChildren().some($isEmbeddedFileNode)).toBe(false);
    });
  });
});
