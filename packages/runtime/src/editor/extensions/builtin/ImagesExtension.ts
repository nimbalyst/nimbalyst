/**
 * Headless extension that owns `ImageNode` registration, the markdown
 * transformer, the `INSERT_IMAGE_COMMAND` handler, and drag/drop wiring.
 *
 * Replaces the React `ImagesPlugin` body (the dialogs stay in
 * `editor/plugins/ImagesPlugin/index.tsx` and are imported by callers that
 * actually render insert UI).
 */

import {
  $createRangeSelection,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRootOrShadowRoot,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COPY_COMMAND,
  DRAGOVER_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  defineExtension,
  getDOMSelectionFromTarget,
  isHTMLElement,
  $createParagraphNode,
  type LexicalEditor,
} from 'lexical';
import { $wrapNodeInElement, mergeRegister } from '@lexical/utils';

import { copyImageToClipboard } from '../../../utils/clipboard';
import {
  $createImageNode,
  $isImageNode,
  ImageNode,
} from '../../plugins/ImagesPlugin/ImageNode';
import { IMAGE_TRANSFORMER } from '../../plugins/ImagesPlugin/ImageTransformer';
import {
  INSERT_IMAGE_COMMAND,
  type InsertImagePayload,
} from '../../plugins/ImagesPlugin/ImageCommands';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/images';

const TRANSPARENT_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let dragImage: HTMLImageElement | null = null;
function getDragImage(): HTMLImageElement {
  if (!dragImage) {
    dragImage = document.createElement('img');
    dragImage.src = TRANSPARENT_IMAGE;
  }
  return dragImage;
}

function $getImageNodeInSelection(): ImageNode | null {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) return null;
  const nodes = selection.getNodes();
  const node = nodes[0];
  return $isImageNode(node) ? node : null;
}

declare global {
  interface DragEvent {
    rangeOffset?: number;
    rangeParent?: Node;
  }
}

function canDropImage(event: DragEvent): boolean {
  const target = event.target;
  return !!(
    isHTMLElement(target) &&
    !target.closest('code, span.editor-image') &&
    isHTMLElement(target.parentElement) &&
    target.parentElement.closest('div.ContentEditable__root')
  );
}

function getDragSelection(event: DragEvent): Range | null | undefined {
  let range;
  const domSelection = getDOMSelectionFromTarget(event.target);
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(event.clientX, event.clientY);
  } else if (event.rangeParent && domSelection !== null) {
    domSelection.collapse(event.rangeParent, event.rangeOffset || 0);
    range = domSelection.getRangeAt(0);
  } else {
    throw Error('Cannot get the selection when dragging');
  }
  return range;
}

function getDragImageData(event: DragEvent): InsertImagePayload | null {
  const dragData = event.dataTransfer?.getData('application/x-lexical-drag');
  if (!dragData) return null;
  const { type, data } = JSON.parse(dragData);
  if (type !== 'image') return null;
  return data;
}

/**
 * When an image node is the current selection, Lexical's default copy path
 * serializes `ImageNode.exportDOM()` — which only emits the `collab-asset://`
 * (or file) URL as `<img src>`, so nothing usable lands on the clipboard. Fetch
 * the actual image bytes and write them via the native clipboard instead.
 */
function $onCopy(event: ClipboardEvent | KeyboardEvent | null): boolean {
  const node = $getImageNodeInSelection();
  if (!node) return false;
  const src = node.__src;
  if (!src) return false;
  event?.preventDefault();
  void copyImageToClipboard({ src }).catch((error) => {
    console.error('[ImagesExtension] Failed to copy image to clipboard', error);
  });
  return true;
}

function $onDragStart(event: DragEvent): boolean {
  const node = $getImageNodeInSelection();
  if (!node) return false;
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return false;
  dataTransfer.setData('text/plain', '_');
  dataTransfer.setDragImage(getDragImage(), 0, 0);
  dataTransfer.setData(
    'application/x-lexical-drag',
    JSON.stringify({
      data: {
        altText: node.__altText,
        caption: node.__caption,
        height: node.__height,
        key: node.getKey(),
        maxWidth: node.__maxWidth,
        showCaption: node.__showCaption,
        src: node.__src,
        width: node.__width,
      },
      type: 'image',
    }),
  );
  return true;
}

function $onDragover(event: DragEvent): boolean {
  const node = $getImageNodeInSelection();
  if (!node) return false;
  if (!canDropImage(event)) event.preventDefault();
  return true;
}

function $onDrop(event: DragEvent, editor: LexicalEditor): boolean {
  const node = $getImageNodeInSelection();
  if (!node) return false;
  const data = getDragImageData(event);
  if (!data) return false;
  event.preventDefault();
  if (canDropImage(event)) {
    const range = getDragSelection(event);
    node.remove();
    const rangeSelection = $createRangeSelection();
    if (range !== null && range !== undefined) {
      rangeSelection.applyDOMRange(range);
    }
    $setSelection(rangeSelection);
    editor.dispatchCommand(INSERT_IMAGE_COMMAND, data);
  }
  return true;
}

export const ImagesExtension = defineExtension({
  name: NAME,
  nodes: [ImageNode],
  register: (editor) =>
    mergeRegister(
      editor.registerCommand<InsertImagePayload>(
        INSERT_IMAGE_COMMAND,
        (payload) => {
          const imageNode = $createImageNode(payload);
          $insertNodes([imageNode]);
          if ($isRootOrShadowRoot(imageNode.getParentOrThrow())) {
            $wrapNodeInElement(imageNode, $createParagraphNode).selectEnd();
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand<ClipboardEvent | KeyboardEvent | null>(
        COPY_COMMAND,
        (event) => $onCopy(event),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand<DragEvent>(
        DRAGSTART_COMMAND,
        (event) => $onDragStart(event),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand<DragEvent>(
        DRAGOVER_COMMAND,
        (event) => $onDragover(event),
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand<DragEvent>(
        DROP_COMMAND,
        (event) => $onDrop(event, editor),
        COMMAND_PRIORITY_HIGH,
      ),
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [IMAGE_TRANSFORMER],
});
