// @vitest-environment node
/**
 * Regression tests for the node set `MarkdownCollabContentAdapter` hands to its
 * headless Lexical editor.
 *
 * The adapter is registered in the ELECTRON MAIN process
 * (`collabContentAdapterRegistration.ts`), so it hits exactly the failure mode
 * `headlessBodyNodes.ts` was written to fix: it was constructing its headless
 * editor with the minimal `EditorNodes` set, which omits every node a renderer
 * editor extension registers (list, link, auto-link, horizontal rule, ...).
 * Any list- or link-bearing document therefore threw "Node list is not
 * registered" inside `$convertFromEnhancedMarkdownString`, which aborts the
 * whole conversion -- so the Y.Doc was never seeded and `exportToFile` came
 * back empty.
 *
 * That was a missed call site of the `HeadlessBodyNodes` fix.
 */
import { createHeadlessEditor } from '@lexical/headless';
import { createBinding, syncLexicalUpdateToYjs } from '@lexical/yjs';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  DecoratorNode,
  type EditorConfig,
  type Klass,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical';
import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

import { MarkdownCollabContentAdapter } from '../MarkdownCollabContentAdapter';
import { withHeadlessLexicalBridge } from '../withHeadlessLexicalBridge';
import HeadlessBodyNodes from '../../editor/nodes/headlessBodyNodes';
import { $createTrackerReferenceNode, TrackerReferenceNode } from '../../plugins/TrackerLinkPlugin/TrackerReferenceNode';
import {
  $createDocumentReferenceNode,
  DocumentReferenceNode,
} from '../../plugins/DocumentLinkPlugin/DocumentLinkNode';
// Side-effect: populate the transformer set (core + built-in extensions) so
// getEditorTransformers() returns the same list the main process uses.
import '../../editor/extensions/registerBuiltinExtensions';

// The shapes that live outside the minimal `EditorNodes` set: bullet list,
// ordered list, link, and a horizontal rule.
const LIST_AND_LINK_MARKDOWN = `## Notes

- first
- second

1. one
2. two

See [the docs](https://example.com/docs).

---

Done.`;

class RendererTrackerReferenceNode extends DecoratorNode<null> {
  __referenceKey: string;

  constructor(referenceKey: string, key?: NodeKey) {
    super(key);
    this.__referenceKey = referenceKey;
  }

  static getType(): string {
    return 'tracker-reference';
  }

  static clone(node: RendererTrackerReferenceNode): RendererTrackerReferenceNode {
    return new RendererTrackerReferenceNode(node.__referenceKey, node.__key);
  }

  static importJSON(
    serializedNode: SerializedLexicalNode & { referenceKey: string },
  ): RendererTrackerReferenceNode {
    return $createRendererTrackerReferenceNode(serializedNode.referenceKey);
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement('span');
  }

  updateDOM(): false {
    return false;
  }

  decorate(): null {
    return null;
  }

  exportJSON(): SerializedLexicalNode & { referenceKey: string } {
    return {
      type: 'tracker-reference',
      version: 1,
      referenceKey: this.__referenceKey,
    };
  }
}

function $createRendererTrackerReferenceNode(
  referenceKey: string,
): RendererTrackerReferenceNode {
  return $applyNodeReplacement(
    new RendererTrackerReferenceNode(referenceKey),
  );
}

function rendererAuthoredSharedDoc(
  namespace: string,
  nodeType: string,
  nodeClass: Klass<LexicalNode>,
  createNode: () => LexicalNode,
): Y.Doc {
  const doc = new Y.Doc();
  const provider = {
    awareness: {
      getLocalState: () => null,
      setLocalState: () => {},
      getStates: () => new Map(),
      on: () => {},
      off: () => {},
    },
    getYDoc: () => doc,
  } as any;
  const writer = createHeadlessEditor({
    namespace,
    nodes: [
      ...HeadlessBodyNodes.filter(
        (registeredNodeClass) => registeredNodeClass.getType() !== nodeType,
      ),
      nodeClass,
    ],
    onError: (error: Error) => {
      throw error;
    },
  });
  const binding = createBinding(
    writer,
    provider,
    'main',
    doc,
    new Map([['main', doc]]),
  );
  const removeListener = writer.registerUpdateListener(
    ({
      prevEditorState,
      editorState,
      dirtyLeaves,
      dirtyElements,
      normalizedNodes,
      tags,
    }) => {
      syncLexicalUpdateToYjs(
        binding,
        provider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      );
    },
  );

  writer.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          createNode(),
        ),
      );
    },
    { discrete: true },
  );
  removeListener();

  return doc;
}

function trackerReferenceSharedDoc(referenceKey: string): Y.Doc {
  return rendererAuthoredSharedDoc(
    'tracker-reference-shared-doc-writer',
    'tracker-reference',
    RendererTrackerReferenceNode,
    () => $createRendererTrackerReferenceNode(referenceKey),
  );
}

describe('MarkdownCollabContentAdapter node set', () => {
  it('syncs setView to a legacy peer and preserves it when that peer clones the node', () => {
    const doc = rendererAuthoredSharedDoc('view-sync-writer', 'tracker-reference', TrackerReferenceNode, () => $createTrackerReferenceNode('NIM-123', 'card'));
    const legacyNodes = HeadlessBodyNodes.map(node => node === TrackerReferenceNode ? RendererTrackerReferenceNode : node);
    const warn = vi.spyOn(console, 'warn').mockImplementation(error => { throw error; });
    try {
      withHeadlessLexicalBridge(doc, { nodes: legacyNodes }, legacy => {
        const readLegacyView = () => legacy.editor.read(() => {
          const node = $getRoot().getFirstDescendant() as RendererTrackerReferenceNode & { __view?: string };
          expect(node).toBeInstanceOf(RendererTrackerReferenceNode);
          expect(node.__referenceKey).toBe('NIM-123');
          return node.__view;
        });
        expect(readLegacyView()).toBe('card');
        const updates = vi.fn();
        doc.on('update', updates);
        withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, writer => {
          writer.applyUpdate(() => {
            ($getRoot().getFirstDescendant() as TrackerReferenceNode).setView('statements');
          });
        });
        doc.off('update', updates);
        expect(updates).toHaveBeenCalledTimes(1);
        Y.applyUpdate(legacy.binding.doc, Y.encodeStateAsUpdate(doc));
        legacy.hydrateFromYDoc();
        expect(readLegacyView()).toBe('statements');
        legacy.applyUpdate(() => {
          $getRoot().getFirstDescendant()!.getWritable();
          $getRoot().getFirstChildOrThrow().getWritable();
          ($getRoot().getFirstDescendant() as RendererTrackerReferenceNode).insertAfter($createTextNode(' edited'));
        });
      });
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toBe('[NIM-123](nimbalyst://NIM-123 "view=statements") edited');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      doc.destroy();
    }
  });

  it.each(['chip', 'card', 'statements', 'unknown'] as const)('round-trips tracker %s views through headless markdown and Yjs', (view) => {
    const doc = new Y.Doc();
    const restored = new Y.Doc();
    const title = view === 'chip' ? '' : ` "view=${view}"`;
    const expectedTitle = view === 'unknown' ? '' : title;
    // The written label survives the round trip; only the key-equal label is implicit.
    const expected = `[label](nimbalyst://NIM-123${expectedTitle})`;
    MarkdownCollabContentAdapter.seedFromFile(doc, `[label](nimbalyst://NIM-123${title})`);
    const markdown = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(markdown).toBe(expected);
    MarkdownCollabContentAdapter.seedFromFile(restored, markdown);
    expect(MarkdownCollabContentAdapter.exportToFile(restored)).toBe(expected);
    doc.destroy();
    restored.destroy();
  });

  it('preserves a renderer-authored card through markdown export and import', () => {
    const doc = rendererAuthoredSharedDoc('tracker-card-writer', 'tracker-reference', TrackerReferenceNode, () => $createTrackerReferenceNode('NIM-123', 'card'));
    const restored = new Y.Doc();
    const markdown = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(markdown).toBe('[NIM-123](nimbalyst://NIM-123 "view=card")');
    MarkdownCollabContentAdapter.seedFromFile(restored, markdown);
    expect(MarkdownCollabContentAdapter.exportToFile(restored)).toBe(markdown);
    doc.destroy();
    restored.destroy();
  });

  it('seeds list and link markdown into the Y.Doc instead of aborting', () => {
    const yDoc = new Y.Doc();

    MarkdownCollabContentAdapter.seedFromFile(yDoc, LIST_AND_LINK_MARKDOWN);

    const exported = MarkdownCollabContentAdapter.exportToFile(yDoc);
    const markdown = typeof exported === 'string'
      ? exported
      : new TextDecoder('utf-8').decode(exported as Uint8Array);

    // Every one of these lives outside `EditorNodes` and so was silently lost.
    expect(markdown).toContain('first');
    expect(markdown).toContain('second');
    expect(markdown).toContain('one');
    expect(markdown).toContain('https://example.com/docs');
    expect(markdown).toContain('Done.');
  });

  it('round-trips a list through applyFromFile without dropping the body', () => {
    const yDoc = new Y.Doc();

    // Seed once, then replace -- applyFromFile uses the same wipe-and-reseed
    // path and the same headless node set.
    MarkdownCollabContentAdapter.seedFromFile(yDoc, 'placeholder');
    MarkdownCollabContentAdapter.applyFromFile(yDoc, LIST_AND_LINK_MARKDOWN);

    const exported = MarkdownCollabContentAdapter.exportToFile(yDoc);
    const markdown = typeof exported === 'string'
      ? exported
      : new TextDecoder('utf-8').decode(exported as Uint8Array);

    expect(markdown).not.toContain('placeholder');
    expect(markdown).toContain('first');
    expect(markdown).toContain('https://example.com/docs');
  });

  it('does not duplicate content when reading a populated doc', () => {
    // The headless editor binds to a fresh working doc and replays the source
    // state into it. If that replay echoed back through the bridge, every read
    // would append a second copy of the document.
    const yDoc = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(yDoc, LIST_AND_LINK_MARKDOWN);

    // Read repeatedly -- each read builds a new binding over the same doc.
    MarkdownCollabContentAdapter.exportToFile(yDoc);
    MarkdownCollabContentAdapter.toPlainText(yDoc);
    const exported = MarkdownCollabContentAdapter.exportToFile(yDoc);
    const markdown = typeof exported === 'string'
      ? exported
      : new TextDecoder('utf-8').decode(exported as Uint8Array);

    expect(markdown.match(/first/g) ?? []).toHaveLength(1);
    expect(markdown.match(/Done\./g) ?? []).toHaveLength(1);
    expect(markdown.match(/example\.com\/docs/g) ?? []).toHaveLength(1);
  });

  it('exports renderer-authored tracker references without a headless node error', () => {
    const yDoc = trackerReferenceSharedDoc('NIM-2043');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const exported = MarkdownCollabContentAdapter.exportToFile(yDoc);
      const markdown =
        typeof exported === 'string'
          ? exported
          : new TextDecoder('utf-8').decode(exported as Uint8Array);

      expect(markdown).toContain('[NIM-2043](nimbalyst://NIM-2043)');
      expect(
        warn.mock.calls.some((call) =>
          call.some((value) =>
            String(value).includes('Node tracker-reference is not registered'),
          ),
        ),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('exports renderer-authored document references without a headless node error', () => {
    const target = 'nimbalyst://doc/shared-roadmap?orgId=org-123';
    const yDoc = rendererAuthoredSharedDoc(
      'document-reference-shared-doc-writer',
      'document-reference',
      DocumentReferenceNode,
      () => $createDocumentReferenceNode('shared-roadmap', 'Roadmap', target),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const exported = MarkdownCollabContentAdapter.exportToFile(yDoc);
      const markdown =
        typeof exported === 'string'
          ? exported
          : new TextDecoder('utf-8').decode(exported as Uint8Array);

      expect(markdown).toContain(`[Roadmap](${target})`);
      expect(
        warn.mock.calls.some((call) =>
          call.some((value) =>
            String(value).includes('Node document-reference is not registered'),
          ),
        ),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('imports collaborative document links as document references headlessly', () => {
    const target = 'nimbalyst://doc/shared-roadmap?orgId=org-123';
    const yDoc = new Y.Doc();

    MarkdownCollabContentAdapter.seedFromFile(
      yDoc,
      `[Roadmap](${target})`,
    );

    const exported = MarkdownCollabContentAdapter.exportToFile(yDoc);
    const markdown =
      typeof exported === 'string'
        ? exported
        : new TextDecoder('utf-8').decode(exported as Uint8Array);

    expect(markdown).toContain(`[Roadmap](${target})`);
  });
});
