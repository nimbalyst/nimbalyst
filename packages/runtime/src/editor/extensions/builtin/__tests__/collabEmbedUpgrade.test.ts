import { buildEditorFromExtensions } from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  COLLABORATION_TAG,
  SKIP_COLLAB_TAG,
  type LexicalEditor,
} from 'lexical';
import { $createLinkNode, $isLinkNode } from '@lexical/link';
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type Provider,
} from '@lexical/yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Doc as YDoc, UndoManager, applyUpdate, encodeStateAsUpdate } from 'yjs';

import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { createTransformers } from '../../../markdown';
import {
  $isEmbeddedFileNode,
} from '../../../plugins/EmbedPlugin/EmbeddedFileNode';
import { setEmbeddableExtensions } from '../../../plugins/EmbedPlugin/embeddableExtensions';
import { buildNimbalystRootExtension } from '../../NimbalystEditorExtensions';
import { MarkdownCollabContentAdapter } from '../../../../sync/MarkdownCollabContentAdapter';
import { CollabDocumentReferenceTransformer } from '../../../../plugins/DocumentLinkPlugin/DocumentLinkNode';

afterEach(() => {
  setEmbeddableExtensions([]);
});

const NOOP_PROVIDER = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    setLocalState: () => {},
    setLocalStateField: () => {},
    on: () => {},
    off: () => {},
  },
  connect: () => Promise.resolve(),
  disconnect: () => {},
  on: () => {},
  off: () => {},
} as unknown as Provider;

/**
 * Wire an editor to a Y.Doc the way `CollaborationPlugin` /
 * `useYjsCollaboration` does in the renderer: bind, observe, and let Yjs
 * changes reach Lexical only through `syncYjsChangesToLexical`. Content that
 * arrives after this call therefore paints as `COLLABORATION_TAG` updates with
 * `skipTransforms: true`, exactly like a real remote hydration.
 */
function mountCollabBinding(editor: LexicalEditor, doc: YDoc): () => void {
  const docMap = new Map<string, YDoc>([['main', doc]]);
  const binding = createBinding(editor, NOOP_PROVIDER, 'main', doc, docMap);
  const onYjsTreeChanges = (
    events: unknown[],
    transaction: { origin: unknown },
  ) => {
    if (transaction.origin === binding) return;
    syncYjsChangesToLexical(
      binding,
      NOOP_PROVIDER,
      events as never,
      transaction.origin instanceof UndoManager,
    );
  };
  const sharedType = binding.root.getSharedType();
  sharedType.observeDeep(onYjsTreeChanges);
  const removeUpdateListener = editor.registerUpdateListener(({
    prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags,
  }) => {
    if (tags.has(SKIP_COLLAB_TAG)) return;
    syncLexicalUpdateToYjs(
      binding,
      NOOP_PROVIDER,
      prevEditorState,
      editorState,
      dirtyElements,
      dirtyLeaves,
      normalizedNodes,
      tags,
    );
  });
  return () => {
    sharedType.unobserveDeep(onYjsTreeChanges);
    removeUpdateListener();
    binding.root.destroy(binding);
  };
}

function buildCollabEditor() {
  return buildEditorFromExtensions(
    buildNimbalystRootExtension({
      collaboration: true,
      $initialEditorState: null,
      markdownTransformers: createTransformers([
        CollabDocumentReferenceTransformer,
      ]),
    }),
  );
}

describe('collaborative embed markdown upgrade', () => {
  it('imports an isolated hinted deep link as an EmbeddedFileNode', () => {
    setEmbeddableExtensions(['.mockup.html']);
    const transformers = createTransformers([
      CollabDocumentReferenceTransformer,
    ]);
    const editor = buildEditorFromExtensions(
      buildNimbalystRootExtension({
        markdownTransformers: transformers,
        $initialEditorState: () => {
          $convertFromEnhancedMarkdownString(
            '[Wireframe](nimbalyst://doc/mockup-1?orgId=team-1 "width=800 embedType=.mockup.html")',
            transformers,
          );
        },
      }),
    );

    try {
      editor.update(() => {}, { discrete: true });
      editor.getEditorState().read(() => {
        const node = $getRoot().getFirstChild();
        expect($isEmbeddedFileNode(node)).toBe(true);
        if (!$isEmbeddedFileNode(node)) return;
        expect(node.getSrc()).toBe(
          'nimbalyst://doc/mockup-1?orgId=team-1',
        );
        expect(node.getAttrs()).toEqual({
          width: '800',
          embedType: '.mockup.html',
        });
      });
    } finally {
      editor.dispose();
    }
  });

  it('reconciles a hinted link hydrated with collaboration transforms skipped', async () => {
    setEmbeddableExtensions(['.mockup.html']);
    const editor = buildEditorFromExtensions(
      buildNimbalystRootExtension({
        markdownTransformers: createTransformers([
          CollabDocumentReferenceTransformer,
        ]),
      }),
    );

    try {
      editor.update(() => {
        const link = $createLinkNode(
          'nimbalyst://doc/mockup-1?orgId=team-1',
          { title: 'height=300 embedType=.mockup.html' },
        );
        link.append($createTextNode('Wireframe'));
        const paragraph = $createParagraphNode();
        paragraph.append(link);
        $getRoot().append(paragraph);
      }, {
        discrete: true,
        skipTransforms: true,
        tag: COLLABORATION_TAG,
      });

      // The reconcile is debounced so a typing collaborator can't trigger a
      // full tree walk per remote transaction.
      await vi.waitFor(() => {
        editor.getEditorState().read(() => {
          expect($isEmbeddedFileNode($getRoot().getFirstChild())).toBe(true);
        });
      });

      editor.getEditorState().read(() => {
        const node = $getRoot().getFirstChild();
        expect($isEmbeddedFileNode(node)).toBe(true);
        if (!$isEmbeddedFileNode(node)) return;
        expect(node.getSrc()).toBe(
          'nimbalyst://doc/mockup-1?orgId=team-1',
        );
      });
    } finally {
      editor.dispose();
    }
  });

  // NIM-2473: the share-to-team seed writes a plain LinkNode carrying the
  // `embedType` hint into the shared Y.Doc (the headless seeder runs no node
  // transforms). A recipient opening that document cold gets the whole body in
  // one hydration burst; nothing about it is a live edit, so the upgrade has to
  // come from the collab reconcile rather than the LinkNode transform.
  it('upgrades a hinted link that arrives as the first paint of a populated shared doc', async () => {
    setEmbeddableExtensions(['.mockup.html']);

    // Sharer side: exactly what Share-to-Team seeds into the room.
    const sharedDoc = new YDoc();
    MarkdownCollabContentAdapter.seedFromFile(
      sharedDoc,
      '[Wireframe](nimbalyst://doc/mockup-1?orgId=team-1 "embedType=.mockup.html")',
    );

    // Recipient side: bind first, hydrate after -- the order
    // `CollabLexicalProvider`'s editor-doc bridge guarantees.
    const editor = buildCollabEditor();
    const editorDoc = new YDoc();
    const unmount = mountCollabBinding(editor, editorDoc);

    try {
      applyUpdate(editorDoc, encodeStateAsUpdate(sharedDoc));

      // The hint has to survive the Y.Doc round trip, otherwise nothing
      // downstream could ever upgrade it.
      editor.getEditorState().read(() => {
        const paragraph = $getRoot().getFirstChild();
        const link = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
        if ($isLinkNode(link)) {
          expect(link.getTitle()).toContain('embedType=.mockup.html');
        }
      });

      await vi.waitFor(
        () => {
          editor.getEditorState().read(() => {
            expect($isEmbeddedFileNode($getRoot().getFirstChild())).toBe(true);
          });
        },
        { timeout: 2000 },
      );
    } finally {
      unmount();
      editor.dispose();
    }
  });

  // Startup ordering: a restored tab can hydrate before the extension host has
  // registered any embeddable type, so the collab rescan is skipped (nothing
  // could upgrade yet). Registration afterwards has to pick the link up.
  it('upgrades a collab-hydrated link when the embeddable type registers after the first paint', async () => {
    setEmbeddableExtensions([]);

    const sharedDoc = new YDoc();
    setEmbeddableExtensions(['.mockup.html']);
    MarkdownCollabContentAdapter.seedFromFile(
      sharedDoc,
      '[Wireframe](nimbalyst://doc/mockup-1?orgId=team-1 "embedType=.mockup.html")',
    );
    setEmbeddableExtensions([]);

    const editor = buildCollabEditor();
    const editorDoc = new YDoc();
    const unmount = mountCollabBinding(editor, editorDoc);

    try {
      applyUpdate(editorDoc, encodeStateAsUpdate(sharedDoc));
      await new Promise((resolve) => setTimeout(resolve, 400));
      editor.getEditorState().read(() => {
        expect($isEmbeddedFileNode($getRoot().getFirstChild())).toBe(false);
      });

      setEmbeddableExtensions(['.mockup.html']);

      await vi.waitFor(
        () => {
          editor.getEditorState().read(() => {
            expect($isEmbeddedFileNode($getRoot().getFirstChild())).toBe(true);
          });
        },
        { timeout: 2000 },
      );
    } finally {
      unmount();
      editor.dispose();
    }
  });
});
