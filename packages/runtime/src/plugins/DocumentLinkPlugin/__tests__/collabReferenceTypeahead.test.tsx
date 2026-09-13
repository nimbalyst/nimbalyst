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
  $isElementNode,
  PASTE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentPathProvider } from '../../../DocumentPathContext';

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
  vi.unstubAllGlobals();
});

function renderTypeahead(source: CollabReferenceSource | null, documentPath: string | null = null) {
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
      <DocumentPathProvider documentPath={documentPath}>
      <DocumentLinkPlugin
        documentService={{ listDocuments: async () => [{ id: 'local-panel', name: 'Panel', path: 'docs/panel.mockup.html' }] } as unknown as DocumentService}
        TypeaheadMenuPlugin={TypeaheadStub}
        triggerFn={() => null}
        collabReferenceSource={source}
      />
      </DocumentPathProvider>
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

/**
 * Pasting a copied shared-doc link (NIM-3585).
 *
 * The typeahead was the only producer of a `DocumentReferenceNode`, so the
 * gesture a reader is most likely to try -- copy a document's link, paste it --
 * left inert text.
 */
describe('collab reference paste', () => {
  const SPEC_TARGET = 'nimbalyst://doc/spec-1?orgId=team-1';

  function sourceWithSpec(): CollabReferenceSource {
    return {
      listOptions: () => [
        {
          documentId: 'spec-1',
          title: 'Product spec',
          target: SPEC_TARGET,
          embedType: '.md',
        },
      ],
      openReference: () => {},
    };
  }

  /**
   * Put the caret in a live paragraph, then run a plain-text paste through the
   * command Lexical would dispatch for one.
   *
   * The command rather than a DOM `paste` event: this harness mounts no
   * `ContentEditable`, so the editor has no root element to receive one, and
   * attaching one would drag the whole rich-text plugin set into a test about
   * a single handler. Returns whether a handler claimed the paste.
   */
  async function pasteInto(
    harness: ReturnType<typeof renderTypeahead>,
    text: string,
  ): Promise<boolean> {
    await act(async () => {
      harness.editor.update(
        () => {
          const paragraph = $createParagraphNode();
          const node = $createTextNode('');
          paragraph.append(node);
          $getRoot().clear().append(paragraph);
          node.select();
        },
        { discrete: true },
      );
    });

    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? text : ''),
      },
    });

    let handled = false;
    await act(async () => {
      handled = harness.editor.dispatchCommand(PASTE_COMMAND, event);
    });
    return handled;
  }

  it('turns a pasted shared-doc link into the same reference the typeahead makes', async () => {
    const harness = renderTypeahead(sourceWithSpec());

    expect(await pasteInto(harness, SPEC_TARGET)).toBe(true);

    harness.editor.getEditorState().read(() => {
      const reference = $getRoot()
        .getChildren()
        .flatMap((child) => ($isElementNode(child) ? child.getChildren() : []))
        .find($isDocumentReferenceNode);
      expect($isDocumentReferenceNode(reference)).toBe(true);
      if (!$isDocumentReferenceNode(reference)) return;
      expect(reference.getPath()).toBe(SPEC_TARGET);
      expect(reference.getTextContent()).toContain('Product spec');
    });
  });

  it('embeds a pasted link to an embeddable shared doc, as the typeahead does', async () => {
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

    expect(await pasteInto(harness, ORG_TARGET)).toBe(true);

    harness.editor.getEditorState().read(() => {
      const embed = $getRoot().getChildren().find($isEmbeddedFileNode);
      expect($isEmbeddedFileNode(embed)).toBe(true);
      if (!$isEmbeddedFileNode(embed)) return;
      expect(embed.getAttrs()).toEqual({ embedType: '.mockup.html' });
    });
  });

  /**
   * The label is baked into the node and exported to markdown, so a guessed one
   * outlives the paste. Text is the honest result for a document this reader
   * cannot see.
   */
  it('leaves a link to an unknown document as text rather than guessing a title', async () => {
    const harness = renderTypeahead(sourceWithSpec());

    expect(await pasteInto(harness, 'nimbalyst://doc/not-shared-with-me?orgId=team-1')).toBe(false);

    harness.editor.getEditorState().read(() => {
      expect($getRoot().getChildren().some($isEmbeddedFileNode)).toBe(false);
      const references = $getRoot()
        .getChildren()
        .flatMap((child) => ($isElementNode(child) ? child.getChildren() : []))
        .filter($isDocumentReferenceNode);
      expect(references).toHaveLength(0);
    });
  });

  it('ignores a paste that is not a shared-doc link', async () => {
    const harness = renderTypeahead(sourceWithSpec());
    expect(await pasteInto(harness, 'https://example.com/spec-1')).toBe(false);
  });
});

it('inserts a local picker embed relative to its host document', async () => {
  vi.stubGlobal('__workspacePath', '/ws');
  setEmbeddableExtensions(['.mockup.html']);
  const harness = renderTypeahead(null, '/ws/docs/host.md');
  await primeAndSelect(harness, 'local-panel');
  harness.editor.getEditorState().read(() => {
    const embed = $getRoot().getFirstChild();
    if (!$isEmbeddedFileNode(embed)) throw new Error('Expected a file embed');
    expect(embed.getSrc()).toBe('./panel.mockup.html');
  });
});
