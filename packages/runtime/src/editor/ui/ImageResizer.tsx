/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';
import type {JSX} from 'react';

import * as React from 'react';

import BlockResizer from './BlockResizer';

/** The image's resize handles plus its "Add Caption" button. */
export default function ImageResizer({
  onResizeStart,
  onResizeEnd,
  buttonRef,
  imageRef,
  maxWidth,
  editor,
  showCaption,
  setShowCaption,
  captionsEnabled,
}: {
  editor: LexicalEditor;
  buttonRef: {current: null | HTMLButtonElement};
  imageRef: {current: null | HTMLElement};
  maxWidth?: number;
  onResizeEnd: (width: 'inherit' | number, height: 'inherit' | number) => void;
  onResizeStart: () => void;
  setShowCaption: (show: boolean) => void;
  showCaption: boolean;
  captionsEnabled: boolean;
}): JSX.Element {
  return (
    <BlockResizer
      editor={editor}
      targetRef={imageRef}
      maxWidth={maxWidth}
      onResizeStart={onResizeStart}
      onResizeEnd={onResizeEnd}>
      {!showCaption && captionsEnabled && (
        <button
          className="image-caption-button"
          ref={buttonRef}
          onClick={() => {
            setShowCaption(!showCaption);
          }}>
          Add Caption
        </button>
      )}
    </BlockResizer>
  );
}
