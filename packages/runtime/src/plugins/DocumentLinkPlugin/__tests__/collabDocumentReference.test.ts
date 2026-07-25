import { describe, it, expect } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from '@lexical/markdown';
import { $getRoot, $isElementNode, $createParagraphNode } from 'lexical';
import { $isLinkNode, LinkNode } from '@lexical/link';

import {
  DocumentReferenceNode,
  DocumentReferenceTransformer,
  CollabDocumentReferenceTransformer,
  LegacyDocumentReferenceTransformer,
  $isDocumentReferenceNode,
  $createDocumentReferenceNode,
  documentReferenceClassName,
} from '../DocumentLinkNode';
import {
  isCollabReferenceHref,
  parseCollabReferenceDocumentId,
} from '../documentLinkPaths';
import { setEmbeddableExtensions } from '../../../editor/plugins/EmbedPlugin/embeddableExtensions';

// Order mirrors registerDocumentLinkPlugin: the main transformer's regex
// excludes `://` targets, so the collab transformer owns collab-scheme links.
const TRANSFORMERS = [
  DocumentReferenceTransformer,
  CollabDocumentReferenceTransformer,
  LegacyDocumentReferenceTransformer,
];

function makeEditor() {
  return createHeadlessEditor({
    nodes: [DocumentReferenceNode, LinkNode],
    onError: (error) => {
      throw error;
    },
  });
}

function findReferenceNode() {
  const root = $getRoot();
  const paragraph = root.getFirstChild();
  if (!paragraph || !$isElementNode(paragraph)) return null;
  return paragraph.getChildren().find($isDocumentReferenceNode) ?? null;
}

describe('CollabDocumentReferenceTransformer', () => {
  it('leaves an explicit collab embed as a LinkNode for the block embed transform', () => {
    setEmbeddableExtensions(['.mockup.html']);
    const editor = makeEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          '[Mockup](nimbalyst://doc/mockup-1?orgId=team-1 "width=800 embedType=.mockup.html")',
          TRANSFORMERS,
        );
      },
      { discrete: true },
    );

    editor.read(() => {
      const paragraph = $getRoot().getFirstChild();
      const link = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
      expect($isLinkNode(link)).toBe(true);
      expect(findReferenceNode()).toBeNull();
    });
    setEmbeddableExtensions([]);
  });

  it('imports a nimbalyst:// deep-link reference as a document reference node', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          'See [My Spec](nimbalyst://doc/abc123?orgId=org-9) for details',
          TRANSFORMERS,
        );
      },
      { discrete: true },
    );

    editor.read(() => {
      const ref = findReferenceNode();
      expect(ref).not.toBeNull();
      expect(ref!.getName()).toBe('My Spec');
      expect(ref!.getPath()).toBe('nimbalyst://doc/abc123?orgId=org-9');
      expect(ref!.getDocumentId()).toBe('abc123');
      expect(ref!.getTextContent()).toBe('My Spec');
    });
  });

  it('round-trips a collab reference back to the deep-link markdown', () => {
    const editor = makeEditor();
    const markdown = '[My Spec](nimbalyst://doc/abc123?orgId=org-9)';
    editor.update(
      () => {
        $convertFromMarkdownString(markdown, TRANSFORMERS);
      },
      { discrete: true },
    );

    let exported = '';
    editor.read(() => {
      exported = $convertToMarkdownString(TRANSFORMERS);
    });
    expect(exported).toBe(markdown);
  });

  it('imports the internal collab:// URI form as well', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          '[Doc](collab://org:org-9:doc:abc123)',
          TRANSFORMERS,
        );
      },
      { discrete: true },
    );

    editor.read(() => {
      const ref = findReferenceNode();
      expect(ref).not.toBeNull();
      expect(ref!.getPath()).toBe('collab://org:org-9:doc:abc123');
      expect(ref!.getDocumentId()).toBe('abc123');
    });
  });

  it('does not treat a collab reference as a local file path', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          '[My Spec](nimbalyst://doc/abc123?orgId=org-9)',
          TRANSFORMERS,
        );
      },
      { discrete: true },
    );

    editor.read(() => {
      const ref = findReferenceNode();
      // A local-file import would have stripped the scheme / produced a
      // workspace-relative path; the collab path must survive intact.
      expect(ref!.getPath()).toContain('nimbalyst://');
    });
  });

  it('still imports a local file link as a document reference', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('[Readme](docs/readme.md)', TRANSFORMERS);
      },
      { discrete: true },
    );

    editor.read(() => {
      const ref = findReferenceNode();
      expect(ref).not.toBeNull();
      expect(ref!.getPath()).toBe('docs/readme.md');
    });
  });

  it('exports a programmatically-created collab reference node', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const target = 'nimbalyst://doc/xyz789?orgId=team-1';
        const node = $createDocumentReferenceNode('xyz789', 'Roadmap', target);
        paragraph.append(node);
        root.append(paragraph);
      },
      { discrete: true },
    );

    let exported = '';
    editor.read(() => {
      exported = $convertToMarkdownString(TRANSFORMERS);
    });
    expect(exported).toContain('[Roadmap](nimbalyst://doc/xyz789?orgId=team-1)');
  });
});

describe('collab reference href helpers', () => {
  it('recognizes collab-scheme hrefs', () => {
    expect(isCollabReferenceHref('nimbalyst://doc/abc?orgId=x')).toBe(true);
    expect(isCollabReferenceHref('collab://org:x:doc:abc')).toBe(true);
    expect(isCollabReferenceHref('docs/readme.md')).toBe(false);
    expect(isCollabReferenceHref('https://example.com')).toBe(false);
    expect(isCollabReferenceHref(null)).toBe(false);
  });

  it('parses the documentId from both forms', () => {
    expect(parseCollabReferenceDocumentId('nimbalyst://doc/abc123?orgId=org-9')).toBe('abc123');
    expect(parseCollabReferenceDocumentId('collab://org:org-9:doc:abc123')).toBe('abc123');
    expect(parseCollabReferenceDocumentId('docs/readme.md')).toBeNull();
  });

  it('decodes a percent-encoded documentId in the deep link', () => {
    expect(parseCollabReferenceDocumentId('nimbalyst://doc/a%2Fb?orgId=x')).toBe('a/b');
  });
});

describe('documentReferenceClassName', () => {
  it('adds the --shared modifier for collab-scheme references', () => {
    expect(documentReferenceClassName('nimbalyst://doc/abc?orgId=x')).toBe(
      'document-reference document-reference--shared',
    );
    expect(documentReferenceClassName('collab://org:x:doc:abc')).toBe(
      'document-reference document-reference--shared',
    );
  });

  it('keeps the plain class for local file references', () => {
    expect(documentReferenceClassName('docs/readme.md')).toBe('document-reference');
    expect(documentReferenceClassName('./notes/spec.md')).toBe('document-reference');
  });
});
