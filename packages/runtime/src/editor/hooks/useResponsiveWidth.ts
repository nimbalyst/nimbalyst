/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {useEffect, useState} from 'react';

export type EditorWidthClass = 
  | 'editor-width-wide'
  | 'editor-width-medium' 
  | 'editor-width-small'
  | 'editor-width-very-small'
  | 'editor-width-extra-small';

// Width breakpoints for editor container
const WIDTH_BREAKPOINTS = {
  EXTRA_SMALL: 480,
  VERY_SMALL: 600,
  SMALL: 768,
  MEDIUM: 1024,
} as const;

function getWidthClass(width: number): EditorWidthClass {
  if (width <= WIDTH_BREAKPOINTS.EXTRA_SMALL) {
    return 'editor-width-extra-small';
  } else if (width <= WIDTH_BREAKPOINTS.VERY_SMALL) {
    return 'editor-width-very-small';
  } else if (width <= WIDTH_BREAKPOINTS.SMALL) {
    return 'editor-width-small';
  } else if (width <= WIDTH_BREAKPOINTS.MEDIUM) {
    return 'editor-width-medium';
  } else {
    return 'editor-width-wide';
  }
}

/**
 * Hook that measures the width of the editor container and returns appropriate CSS class
 */
export function useResponsiveWidth(containerRef: React.RefObject<HTMLElement | null>): EditorWidthClass {
  const [widthClass, setWidthClass] = useState<EditorWidthClass>('editor-width-wide');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidthClass = () => {
      const width = container.getBoundingClientRect().width;
      const newClass = getWidthClass(width);
      setWidthClass(newClass);
    };

    // Initial measurement
    updateWidthClass();

    // Use ResizeObserver for efficient width monitoring
    const resizeObserver = new ResizeObserver(() => {
      updateWidthClass();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [containerRef]);

  return widthClass;
}
