/**
 * Re-render on selection changes, at most once per animation frame, for the
 * components that show something about the selection (toolbar state, status
 * bar). A drag fires a change per cell; the frame batching keeps that to one
 * render per paint.
 */

import { useEffect, useState } from 'react';
import type { EditorCore } from './editorCore';

export function useSelectionVersion(core: EditorCore): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let frame: number | null = null;
    const listener = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setVersion((v) => v + 1);
      });
    };
    core.selectionListeners.add(listener);
    return () => {
      core.selectionListeners.delete(listener);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [core]);
  return version;
}
