import { buildEditorFromExtensions } from '@lexical/extension';
import { $isLinkNode } from '@lexical/link';
import { RichTextExtension } from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getRoot,
  PASTE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { describe, expect, it, vi } from 'vitest';

import { rewriteClipboardHtmlImages } from '../MarkdownPasteExtension';
import type { UploadedEditorAsset } from '../../../EditorConfig';
import { buildNimbalystRootExtension } from '../../NimbalystEditorExtensions';
import { createTransformers } from '../../../markdown';

function createCollabEditor(): LexicalEditor & { dispose(): void } {
  return buildEditorFromExtensions(
    buildNimbalystRootExtension({
      collaboration: true,
      extensionDependencies: [RichTextExtension],
      markdownTransformers: createTransformers(),
      $initialEditorState: () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.select();
      },
    }),
  );
}

function pastePlainText(editor: LexicalEditor, text: string): ClipboardEvent {
  if (typeof DragEvent === 'undefined') {
    Object.defineProperty(globalThis, 'DragEvent', {
      configurable: true,
      value: class DragEvent extends Event {},
    });
  }
  if (typeof ClipboardEvent === 'undefined') {
    Object.defineProperty(globalThis, 'ClipboardEvent', {
      configurable: true,
      value: class ClipboardEvent extends Event {},
    });
  }
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      types: ['text/plain'],
    },
  });

  editor.dispatchCommand(PASTE_COMMAND, event);
  editor.update(() => {}, { discrete: true });
  return event;
}

function readClickableLinks(editor: LexicalEditor): Array<{ text: string; url: string }> {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .flatMap((textNode) => {
        const parent = textNode.getParent();
        return $isLinkNode(parent)
          ? [{ text: parent.getTextContent(), url: parent.getURL() }]
          : [];
      }),
  );
}

function readTextContent(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

function imageFile(name = 'shot.png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

function uploader(uri = 'collab-asset://doc/d1/asset/a1') {
  return vi.fn(
    async (file: File): Promise<UploadedEditorAsset> => ({
      kind: 'image',
      src: uri,
      name: file.name,
      altText: file.name,
    }),
  );
}

describe('rewriteClipboardHtmlImages', () => {
  it('uploads a file-backed pasted image and rewrites it to a collab-asset URI', async () => {
    // Browser image copies ship the real bytes as a clipboard File alongside
    // HTML that references them via an ephemeral src (blob: / webkit-fake-url:).
    const html = '<img src="blob:https://app.local/abcd-1234">';
    const upload = uploader();

    const result = await rewriteClipboardHtmlImages(html, upload, [imageFile()]);

    expect(result).not.toBeNull();
    // The real bytes (the clipboard File), not a fetched blob URL, were uploaded.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBeInstanceOf(File);
    // Images-only paste inserts image nodes directly.
    expect(result!.html).toBeNull();
    expect(result!.imagePayloads).toHaveLength(1);
    expect(result!.imagePayloads[0].src).toBe('collab-asset://doc/d1/asset/a1');
  });

  it('leaves an external http image untouched when no bytes are present', async () => {
    // A bare <img src="https://..."> with no accompanying File is out of scope:
    // it still resolves from the remote and must not be auto-downloaded.
    const html = '<img src="https://example.com/remote.png">';
    const upload = uploader();

    const result = await rewriteClipboardHtmlImages(html, upload, []);

    expect(result).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('MarkdownPasteExtension link paste', () => {
  it('pastes an inline markdown link as a clickable LinkNode', () => {
    const editor = createCollabEditor();
    try {
      const event = pastePlainText(editor, '[label](https://example.com)');

      expect(event.defaultPrevented).toBe(true);
      expect(readClickableLinks(editor)).toEqual([
        { text: 'label', url: 'https://example.com' },
      ]);
    } finally {
      editor.dispose();
    }
  });

  it('pastes a bare URL as a clickable LinkNode', () => {
    const editor = createCollabEditor();
    try {
      const event = pastePlainText(editor, 'https://example.com/docs');

      expect(event.defaultPrevented).toBe(true);
      expect(readClickableLinks(editor)).toEqual([
        {
          text: 'https://example.com/docs',
          url: 'https://example.com/docs',
        },
      ]);
    } finally {
      editor.dispose();
    }
  });

  it('does not treat bracketed prose as a markdown link', () => {
    const editor = createCollabEditor();
    try {
      pastePlainText(editor, 'Notes [draft] (not a link)');

      expect(readClickableLinks(editor)).toEqual([]);
      expect(readTextContent(editor)).toBe('Notes [draft] (not a link)');
    } finally {
      editor.dispose();
    }
  });
});
