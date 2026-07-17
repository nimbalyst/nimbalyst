/**
 * Intercepts PASTE_COMMAND, detects markdown-looking plain text via
 * `isLikelyMarkdown`, and inserts a parsed editor-state instead of letting
 * the default handler treat it as plain text. HTML-bearing paste payloads
 * usually fall through to the default handler; the only exception is HTML
 * with inline `data:image/...` sources, which is rewritten through the
 * asset upload pipeline before import.
 *
 * Headless extension (Phase 7.3). Replaces the prior React-component
 * `MarkdownPastePlugin` mounted in Editor.tsx.
 */

import {
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
  $insertNodes,
  $parseSerializedNode,
  defineExtension,
} from 'lexical';
import { $generateNodesFromDOM } from '@lexical/html';
import type { Transformer } from '@lexical/markdown';

import type { UploadedEditorAsset } from '../../EditorConfig';
import { markdownToJSONSync } from '../../markdown';
import { LINK } from '../../markdown/MarkdownTransformers';
import { INSERT_IMAGE_COMMAND, type InsertImagePayload } from '../../plugins/ImagesPlugin';
import { isLikelyMarkdown } from '../../utils/markdownDetection';
import { dataUrlToImageFile, uploadEditorImageAsset } from './imageAssetUpload';

export interface MarkdownPasteConfig {
  transformers: Transformer[];
  minConfidenceScore: number;
  uploadAsset?: (file: File) => Promise<UploadedEditorAsset>;
}

interface RewrittenHtmlPasteResult {
  html: string | null;
  imagePayloads: InsertImagePayload[];
}

/**
 * Resolve the actual bytes for a pasted `<img>`, returning a File ready for
 * upload or `null` when the image should be left untouched.
 *
 * A browser image copy ships the real bytes as a clipboard File while the HTML
 * references them via an ephemeral src (`webkit-fake-url:`, `blob:`) or the
 * original remote URL -- Lexical's default handler imports that ephemeral src
 * and the image dies on refresh (NIM-1646). Preferring the clipboard File makes
 * the asset durable regardless of the src scheme.
 */
async function resolveImageBytes(
  img: HTMLImageElement,
  imageFilesQueue: File[],
  index: number,
): Promise<File | null> {
  const src = img.getAttribute('src')?.trim() ?? '';

  if (src.startsWith('data:image/')) {
    return dataUrlToImageFile(src, `pasted-html-image-${index + 1}`);
  }

  // Real clipboard bytes trump whatever scheme the HTML used to reference them.
  if (imageFilesQueue.length > 0) {
    return imageFilesQueue.shift() ?? null;
  }

  // A blob: URL with no accompanying File is still fetchable within this
  // renderer session; grab the bytes before it is revoked.
  if (src.startsWith('blob:')) {
    try {
      const response = await fetch(src);
      if (response.ok) {
        const blob = await response.blob();
        return new File([blob], `pasted-html-image-${index + 1}`, {
          type: blob.type || 'image/png',
        });
      }
    } catch {
      // Unresolved -- fall through.
    }
  }

  // External http(s) images with no local bytes are intentionally left pointing
  // at the remote; NIM-1646 keeps the fix narrow (no auto-download of remote
  // content into E2E-encrypted collab storage).
  return null;
}

export async function rewriteClipboardHtmlImages(
  htmlData: string,
  uploadAsset?: (file: File) => Promise<UploadedEditorAsset>,
  imageFiles: File[] = [],
): Promise<RewrittenHtmlPasteResult | null> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlData, 'text/html');
  const images = Array.from(doc.querySelectorAll('img'));
  if (images.length === 0) {
    return null;
  }

  const imageFilesQueue = [...imageFiles];
  const imagePayloads: InsertImagePayload[] = [];
  let unresolved = 0;

  for (let index = 0; index < images.length; index += 1) {
    const img = images[index];
    const file = await resolveImageBytes(img, imageFilesQueue, index);
    if (!file) {
      unresolved += 1;
      continue;
    }

    const uploadedSrc = await uploadEditorImageAsset(file, uploadAsset, {
      allowDataUrlFallback: false,
    });
    img.setAttribute('src', uploadedSrc);
    imagePayloads.push({
      altText: img.getAttribute('alt') || file.name,
      src: uploadedSrc,
    });
  }

  if (imagePayloads.length === 0) {
    return null;
  }

  // Only shortcut to direct image insertion when every image was rewritten and
  // there is no surrounding text; a left-behind external image must ride along
  // in the HTML so it is not dropped.
  const imagesOnly = unresolved === 0 && (doc.body.textContent || '').trim().length === 0;
  return {
    html: imagesOnly ? null : doc.body.innerHTML,
    imagePayloads,
  };
}

function insertHtmlIntoEditor(editor: LexicalEditor, html: string): void {
  editor.update(() => {
    const parser = new DOMParser();
    const dom = parser.parseFromString(html, 'text/html');
    const nodes = $generateNodesFromDOM(editor, dom);
    $insertNodes(nodes);
  });
}

export const MarkdownPasteExtension = defineExtension({
  name: '@nimbalyst/editor/markdown-paste',
  config: { transformers: [] as Transformer[], minConfidenceScore: 15, uploadAsset: undefined } as MarkdownPasteConfig,
  register: (editor, config) => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) {
          return false;
        }

        // Clipboard image bytes that accompany the HTML (browser copies ship
        // both). These are the durable source for a pasted image.
        const imageFiles = clipboardData.files
          ? Array.from(clipboardData.files).filter((f) => f.type.startsWith('image/'))
          : [];

        // HTML payload available. Intercept when the HTML contains images we can
        // rewrite to durable asset paths: inline data: URLs, fetchable blob:
        // URLs, or any <img> backed by real clipboard bytes.
        const htmlData = clipboardData.getData('text/html');
        if (htmlData && htmlData.trim().length > 0) {
          const hasImgTag = /<img[\s/>]/i.test(htmlData);
          const hasDataImage = /<img[^>]+src\s*=\s*["']data:image\//i.test(htmlData);
          const hasBlobImage = /<img[^>]+src\s*=\s*["']blob:/i.test(htmlData);
          const canRewriteImages =
            hasDataImage || hasBlobImage || (hasImgTag && imageFiles.length > 0);
          if (!canRewriteImages) {
            return false;
          }

          event.preventDefault();
          (async () => {
            try {
              const rewrittenPaste = await rewriteClipboardHtmlImages(
                htmlData,
                config.uploadAsset,
                imageFiles,
              );
              if (!rewrittenPaste) {
                // Nothing was resolvable (e.g. an ephemeral src we could not
                // fetch and no clipboard bytes). Preserve the original paste
                // rather than dropping it -- no worse than the default handler.
                insertHtmlIntoEditor(editor, htmlData);
                return;
              }

              if (rewrittenPaste.html === null) {
                for (const payload of rewrittenPaste.imagePayloads) {
                  editor.dispatchCommand(INSERT_IMAGE_COMMAND, payload);
                }
                return;
              }

              insertHtmlIntoEditor(editor, rewrittenPaste.html);
            } catch (error) {
              console.error('[MarkdownPasteExtension] Failed to rewrite HTML image paste:', error);
            }
          })();
          return true;
        }

        const plainText = clipboardData.getData('text/plain');
        if (!plainText || plainText.trim().length === 0) {
          return false;
        }

        // Shift+paste = "paste as plain text"; skip transformation.
        if ((event as ClipboardEvent & { shiftKey?: boolean }).shiftKey) {
          return false;
        }

        // A single inline markdown link is intentionally below the general
        // markdown-confidence threshold, but its syntax is unambiguous and the
        // LINK transformer must run before RichText's plain-text paste path can
        // split it into literal brackets plus an auto-linked URL.
        const isMarkdown =
          LINK.importRegExp?.test(plainText) === true ||
          isLikelyMarkdown(plainText, {
            minConfidenceScore: config.minConfidenceScore,
          });
        if (!isMarkdown) {
          return false;
        }

        event.preventDefault();

        try {
          editor.update(() => {
            const importedEditorStateJSON = markdownToJSONSync(
              editor,
              config.transformers,
              plainText,
            );
            const nodes = importedEditorStateJSON.root.children.map($parseSerializedNode);
            $insertNodes(nodes);
          });
          return true;
        } catch (error) {
          console.error('[MarkdownPasteExtension] Failed to transform markdown:', error);
          return false;
        }
      },
      COMMAND_PRIORITY_HIGH,
    );
  },
});
