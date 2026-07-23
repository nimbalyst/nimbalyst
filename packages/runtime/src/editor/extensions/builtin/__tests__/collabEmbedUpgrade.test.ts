import { buildEditorFromExtensions } from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COLLABORATION_TAG,
} from 'lexical';
import { $createLinkNode } from '@lexical/link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { createTransformers } from '../../../markdown';
import {
  $isEmbeddedFileNode,
} from '../../../plugins/EmbedPlugin/EmbeddedFileNode';
import { setEmbeddableExtensions } from '../../../plugins/EmbedPlugin/embeddableExtensions';
import { buildNimbalystRootExtension } from '../../NimbalystEditorExtensions';
import { CollabDocumentReferenceTransformer } from '../../../../plugins/DocumentLinkPlugin/DocumentLinkNode';

afterEach(() => {
  setEmbeddableExtensions([]);
});

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
});
