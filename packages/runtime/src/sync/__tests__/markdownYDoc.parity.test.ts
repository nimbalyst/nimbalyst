// @vitest-environment node
/**
 * The headless writer (`markdownYDoc.ts`, shipped to the collab worker as
 * `@nimbalyst/markdown-ydoc`) against the path every body is written through
 * today, `MarkdownCollabContentAdapter`, set up with the transformers a
 * desktop renderer has registered.
 *
 * Equal Lexical JSON is necessary but not sufficient -- two Y shapes can
 * decode alike -- so the Y tree is compared too, with client ids stripped.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  DecoratorNode,
  type SerializedLexicalNode,
} from 'lexical';

import { MarkdownCollabContentAdapter } from '../MarkdownCollabContentAdapter';
import { lexicalYDocToMarkdown, markdownToLexicalYUpdate } from '../markdownYDoc';
import { withHeadlessLexicalBridge } from '../withHeadlessLexicalBridge';
import { HeadlessBodyNodes } from '../../editor/nodes/headlessBodyNodes';
import { registerReferenceNodeContributions } from '../../plugins/referenceNodeContributions';
import { setExtensionContributions } from '../../editor/extensions/extensionContributionsStore';
import { EMBED_TRANSFORMER } from '../../editor/plugins/EmbedPlugin/EmbedTransformer';
// Side effect: the built-in transformers a desktop renderer publishes.
import '../../editor/extensions/registerBuiltinExtensions';

beforeAll(() => {
  registerReferenceNodeContributions();
  // What EmbedExtension publishes at load; importing it drags in Monaco.
  setExtensionContributions('@nimbalyst/editor/embed', { markdownTransformers: [EMBED_TRANSFORMER] });
});

const CORPUS = `---
title: Parity corpus
tags: [a, b]
---
# Heading one

Intro with **bold**, _italic_, ~~struck~~, \`code\`, ==marked== and a [link](https://example.com/docs). #hashtag :tada:

## Lists

- bullet one
  - nested two
    - nested three
- bullet four

1. first
2. second
   1. second-a

- [ ] open task
- [x] done task
  - [ ] nested task

> Quoted line

### Media and references

![Architecture](https://example.com/arch.png)

See [NIM-42](nimbalyst://NIM-42) and [NIM-7](nimbalyst://NIM-7 "view=card").

Plan: [Roadmap](./plans/roadmap.md) and shared [Spec](nimbalyst://doc/abc123?orgId=org1).

- [Storage in [Flagship](https://flagship.dev) is **ours**.[GH](nimbalyst://cite/s1/answer/k1 "by='Greg Hinkle' quote='Say %22no%22 %5Bnow%5D%0Aplease'")]{decided by="Greg" on=2026-09-30 over="our own engine"}
- [Is it fast enough?]{open by="Spike 6"} See [Docs](https://x.dev "cite").

[Board](./boards/flow.excalidraw "height=400")

\`\`\`ts
const answer: number = 42;
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`decision
id: dec-1
ask: Which option?
kind: single
options:
  - id: a
    label: Option A
  - id: b
    label: Option B
\`\`\`

---

| Name | Notes |
| --- | --- |
| **Alpha** | [docs](https://example.com) |
| Beta | [NIM-9](nimbalyst://NIM-9) and [Spec](nimbalyst://doc/abc123?orgId=org1) |

Closing line.
`;

function adapterDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  MarkdownCollabContentAdapter.seedFromFile(doc, markdown);
  return doc;
}

function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

function lexicalJson(doc: Y.Doc): unknown {
  return withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, (headless) =>
    headless.editor.getEditorState().toJSON(),
  );
}

/** The Y tree with client ids and item identity dropped. */
function yShape(value: unknown): unknown {
  const attrs = (attributes: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, yShape(v)]));
  if (value instanceof Y.XmlText) {
    return {
      xmlText: value.toDelta().map((op: { insert: unknown; attributes?: Record<string, unknown> }) => ({
        insert: yShape(op.insert),
        ...(op.attributes ? { attributes: attrs(op.attributes) } : {}),
      })),
      attributes: attrs(value.getAttributes()),
    };
  }
  if (value instanceof Y.XmlElement) {
    return {
      element: value.nodeName,
      attributes: attrs(value.getAttributes()),
      children: value.toArray().map(yShape),
    };
  }
  if (value instanceof Y.Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([k, v]) => [k, yShape(v)]));
  }
  // A nested editor (an image caption) is a subdocument; its guid is random.
  if (value instanceof Y.Doc) {
    return { subdoc: Array.from(value.share.keys()).map((key) => [key, yShape(value.get(key, Y.XmlText))]) };
  }
  if (value instanceof Y.AbstractType) throw new Error(`unhandled Y type ${value.constructor.name}`);
  return value;
}

/** `@lexical/yjs` keeps the tree in the `root` shared type; 'main' is only the binding id. */
function rootShape(doc: Y.Doc): unknown {
  return yShape(doc.get('root', Y.XmlText));
}

describe('markdownYDoc parity with MarkdownCollabContentAdapter', () => {
  it('writes the same document as the adapter', () => {
    const reference = adapterDoc(CORPUS);
    const headless = docFromUpdate(markdownToLexicalYUpdate(CORPUS));

    const referenceJson = lexicalJson(reference);
    expect(JSON.stringify(referenceJson)).toContain('"type":"decision"');
    expect(lexicalJson(headless)).toEqual(referenceJson);
    const referenceShape = rootShape(reference);
    expect(JSON.stringify(referenceShape)).toContain('"__type":"tracker-reference"');
    expect(rootShape(headless)).toEqual(referenceShape);
  });

  it('reads back the markdown the adapter exports', () => {
    const update = markdownToLexicalYUpdate(CORPUS);
    const exported = lexicalYDocToMarkdown(update);
    expect(exported).toBe(MarkdownCollabContentAdapter.exportToFile(docFromUpdate(update)));
    // Idempotent after one normalization pass.
    expect(lexicalYDocToMarkdown(markdownToLexicalYUpdate(exported))).toBe(exported);
    expect(exported).toContain('title: Parity corpus');
    expect(exported).toContain('[NIM-7](nimbalyst://NIM-7 "view=card")');
    expect(exported).toContain('```decision\nid: dec-1');
  });

  it('carries a marked sentence with a link, bold and legacy and console-link citations through the Y.Doc byte for byte', () => {
    const markdown = [
      'Intro.',
      '',
      '- [Storage in [Flagship](https://flagship.dev) is **ours**.[GH](nimbalyst://cite/s1/answer/k1 "by=\'Greg Hinkle\' quote=\'Say %22no%22 %5Bnow%5D%0Aplease\'")]{decided by="Greg" on=2026-09-30 over="our \\"own\\" engine"}',
      '- [Is it fast enough?]{open by="Spike 6"} See [Docs](https://x.dev "cite").[AB](https://console.nimbalyst.com/app/cite/s2/prompt/p%2F1 "by=\'Ana B\' email=ana@example.com")',
    ].join('\n');
    const update = markdownToLexicalYUpdate(markdown);
    expect(JSON.stringify(rootShape(docFromUpdate(update)))).toContain('"__type":"page-mark"');
    expect(lexicalYDocToMarkdown(update)).toBe(markdown);
    expect(MarkdownCollabContentAdapter.exportToFile(adapterDoc(markdown))).toBe(markdown);
  });

  it('keeps the written label of a console item link through the Y.Doc', () => {
    const markdown = 'Sync runs on [the sync engine](https://console.nimbalyst.com/org/o/project/p/page/item/NIM-12 "rel=built-on") today.';
    const update = markdownToLexicalYUpdate(markdown);
    expect(JSON.stringify(rootShape(docFromUpdate(update)))).toContain('"__type":"tracker-reference"');
    expect(lexicalYDocToMarkdown(update)).toBe(markdown);
    expect(MarkdownCollabContentAdapter.exportToFile(adapterDoc(markdown))).toBe(markdown);
  });

  it('replaces an existing body the way applyFromFile does', () => {
    const prior = adapterDoc('# Old\n\n- stale item\n\nOld paragraph.');
    const reference = docFromUpdate(Y.encodeStateAsUpdate(prior));
    MarkdownCollabContentAdapter.applyFromFile(reference, CORPUS);

    const live = docFromUpdate(Y.encodeStateAsUpdate(prior));
    const delta = markdownToLexicalYUpdate(CORPUS, { existingState: Y.encodeStateAsUpdate(live) });
    Y.applyUpdate(live, delta);

    expect(lexicalJson(live)).toEqual(lexicalJson(reference));
    expect(rootShape(live)).toEqual(rootShape(reference));
    // A delta: nothing re-sent from the prior document, whose content it deletes.
    const priorClients = Y.decodeStateVector(Y.encodeStateVector(prior));
    const decoded = Y.decodeUpdate(delta);
    expect(decoded.structs.some((struct) => priorClients.has(struct.id.client))).toBe(false);
    expect(Array.from(decoded.ds.clients.keys()).some((client) => priorClients.has(client))).toBe(true);
    expect(lexicalYDocToMarkdown(Y.encodeStateAsUpdate(live))).not.toContain('stale item');
  });
});

/** A node only an extension registers -- the headless set has no class for it. */
type SerializedMathNode = SerializedLexicalNode & { equation: string };
class MathNode extends DecoratorNode<null> {
  __equation: string;
  static getType(): string {
    return 'math';
  }
  static clone(node: MathNode): MathNode {
    return new MathNode(node.__equation, node.__key);
  }
  static importJSON(json: SerializedMathNode): MathNode {
    return $applyNodeReplacement(new MathNode(json.equation));
  }
  constructor(equation: string, key?: string) {
    super(key);
    this.__equation = equation;
  }
  exportJSON(): SerializedMathNode {
    return { ...super.exportJSON(), equation: this.__equation };
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

describe('extension-donated syntax', () => {
  it('stays literal text instead of throwing', () => {
    const markdown = 'Energy: $E = mc^2$\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```board-table\n| a |\n```\n\n<details>\n<summary>More</summary>\n\nHidden\n</details>';
    const exported = lexicalYDocToMarkdown(markdownToLexicalYUpdate(markdown));
    expect(exported).toContain('$E = mc^2$');
    expect(exported).toContain('\\int_0^1');
    expect(exported).toContain('<summary>More</summary>');
  });

  it('reads and replaces a body holding a node the headless set has no class for', () => {
    const prior = new Y.Doc();
    withHeadlessLexicalBridge(prior, { nodes: [...HeadlessBodyNodes, MathNode] }, (headless) => {
      headless.applyUpdate(() => {
        $getRoot().clear().append(
          $createParagraphNode().append($createTextNode('before '), $applyNodeReplacement(new MathNode('x^2'))),
        );
      });
    });
    expect(JSON.stringify(rootShape(prior))).toContain('"__type":"math"');

    const state = Y.encodeStateAsUpdate(prior);
    expect(lexicalYDocToMarkdown(state).trim()).toBe('before x^2');
    const delta = markdownToLexicalYUpdate('# Fresh', { existingState: state });
    Y.applyUpdate(prior, delta);
    expect(lexicalYDocToMarkdown(Y.encodeStateAsUpdate(prior)).trim()).toBe('# Fresh');
  });
});
