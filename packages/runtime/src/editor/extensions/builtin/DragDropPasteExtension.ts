/**
 * Handles `DRAG_DROP_PASTE` (dispatched by RichTextPlugin when files are
 * dropped or pasted into the editor). If a host-supplied `uploadAsset`
 * callback is configured, files are uploaded through it; otherwise the
 * extension falls back to the electron document-service IPC for images,
 * with a final base64 fallback when the API is unavailable.
 *
 * Headless extension (Phase 7.3). Replaces the prior React-component
 * `DragDropPaste` mounted in Editor.tsx.
 */

import { $createLinkNode } from '@lexical/link';
import { DRAG_DROP_PASTE } from '@lexical/rich-text';
import { $wrapNodeInElement, isMimeType } from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $insertNodes,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_HIGH,
  type LexicalEditor,
  defineExtension,
} from 'lexical';

import type { UploadedEditorAsset } from '../../EditorConfig';
import { INSERT_IMAGE_COMMAND } from '../../plugins/ImagesPlugin';
import { uploadEditorImageAsset } from './imageAssetUpload';

const ACCEPTABLE_IMAGE_TYPES = [
  'image/',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/webp',
];

async function processImageFile(
  file: File,
  uploadAsset?: (file: File) => Promise<UploadedEditorAsset>,
): Promise<string> {
  return uploadEditorImageAsset(file, uploadAsset, { allowDataUrlFallback: true });
}

function insertUploadedAsset(
  editor: LexicalEditor,
  file: File,
  asset: UploadedEditorAsset,
): void {
  if (asset.kind === 'image') {
    editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
      altText: asset.altText ?? file.name,
      src: asset.src,
    });
    return;
  }
  editor.update(() => {
    const linkNode = $createLinkNode(asset.src);
    linkNode.append($createTextNode(asset.name ?? file.name));
    $insertNodes([linkNode]);
    if ($isRootOrShadowRoot(linkNode.getParentOrThrow())) {
      $wrapNodeInElement(linkNode, $createParagraphNode).selectEnd();
    }
  });
}

export interface DragDropPasteConfig {
  uploadAsset: ((file: File) => Promise<UploadedEditorAsset>) | undefined;
}

export const DragDropPasteExtension = defineExtension({
  name: '@nimbalyst/editor/drag-drop-paste',
  config: { uploadAsset: undefined } as DragDropPasteConfig,
  register: (editor, config) => {
    return editor.registerCommand(
      DRAG_DROP_PASTE,
      (files) => {
        (async () => {
          for (const file of files) {
            if (config.uploadAsset) {
              const asset = await config.uploadAsset(file);
              insertUploadedAsset(editor, file, asset);
              continue;
            }
            if (isMimeType(file, ACCEPTABLE_IMAGE_TYPES)) {
              const src = await processImageFile(file, config.uploadAsset);
              editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
                altText: file.name,
                src,
              });
            }
          }
        })();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  },
});
