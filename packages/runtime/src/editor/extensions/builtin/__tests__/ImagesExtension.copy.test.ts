import { buildEditorFromExtensions } from '@lexical/extension';
import { RichTextExtension } from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $getRoot,
  $setSelection,
  COPY_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { copyImageToClipboard } from '../../../../utils/clipboard';
import { $createImageNode } from '../../../plugins/ImagesPlugin/ImageNode';
import { buildNimbalystRootExtension } from '../../NimbalystEditorExtensions';
import { createTransformers } from '../../../markdown';

vi.mock('../../../../utils/clipboard', () => ({
  copyImageToClipboard: vi.fn(async () => {}),
  copyToClipboard: vi.fn(async () => {}),
}));

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

function copyEvent(): ClipboardEvent {
  if (typeof ClipboardEvent === 'undefined') {
    Object.defineProperty(globalThis, 'ClipboardEvent', {
      configurable: true,
      value: class ClipboardEvent extends Event {},
    });
  }
  return new ClipboardEvent('copy', { bubbles: true, cancelable: true });
}

const COLLAB_SRC = 'collab-asset://doc/d1/asset/a1';

describe('ImagesExtension copy', () => {
  beforeEach(() => {
    vi.mocked(copyImageToClipboard).mockClear();
  });

  it('copies the real image bytes when a collab image node is selected', () => {
    const editor = createCollabEditor();
    try {
      let imageKey = '';
      editor.update(
        () => {
          const imageNode = $createImageNode({
            src: COLLAB_SRC,
            altText: 'image.png',
          });
          $getRoot().append($createParagraphNode().append(imageNode));
          imageKey = imageNode.getKey();

          const selection = $createNodeSelection();
          selection.add(imageKey);
          $setSelection(selection);
        },
        { discrete: true },
      );

      const event = copyEvent();
      editor.dispatchCommand(COPY_COMMAND, event);

      expect(event.defaultPrevented).toBe(true);
      expect(copyImageToClipboard).toHaveBeenCalledTimes(1);
      expect(vi.mocked(copyImageToClipboard).mock.calls[0][0]).toEqual({
        src: COLLAB_SRC,
      });
    } finally {
      editor.dispose();
    }
  });

  it('does not intercept copy when no image node is selected', () => {
    const editor = createCollabEditor();
    try {
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChild();
          (paragraph as any)?.selectEnd?.();
        },
        { discrete: true },
      );

      const event = copyEvent();
      editor.dispatchCommand(COPY_COMMAND, event);

      expect(copyImageToClipboard).not.toHaveBeenCalled();
    } finally {
      editor.dispose();
    }
  });
});
