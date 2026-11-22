import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { readWindowsClipboardImage } from '@nimbalyst/runtime/utils/clipboard';
import type { AIInputSnapshot, PushOptions } from '../../store/atoms/aiInputUndo';

interface PastedImageOptions {
  sessionId?: string;
  getUndoCount: () => number;
  captureSnapshot: () => AIInputSnapshot;
  pushSnapshot: (snapshot: AIInputSnapshot, options: PushOptions) => void;
  handleFileAttachment: (file: File) => Promise<void>;
  setProcessingAttachments: Dispatch<SetStateAction<Array<{ id: string; filename: string }>>>;
}

/** Includes the host clipboard read in the paste's undo and processing lifetime. */
export function usePastedImage(options: PastedImageOptions) {
  const session = useMemo(() => ({}), [options.sessionId]);
  const latest = useRef({ ...options, session });
  latest.current = { ...options, session };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return useCallback(async (clipboardFile?: File) => {
    const start = latest.current;
    if (!start.sessionId) return;
    const undoCount = start.getUndoCount();
    start.pushSnapshot(start.captureSnapshot(), { boundary: true });
    const id = `clipboard-${crypto.randomUUID()}`;
    start.setProcessingAttachments(previous => [...previous, { id, filename: 'Clipboard image' }]);
    try {
      const file = clipboardFile ?? await readWindowsClipboardImage();
      if (!file || !mounted.current || latest.current.session !== start.session || start.getUndoCount() !== undoCount) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = file.type.split('/')[1] || 'png';
      const renamedFile = new File([file], `pasted-image-${timestamp}.${ext}`, { type: file.type });
      start.setProcessingAttachments(previous => previous.filter(item => item.id !== id));
      // Use the current callback: the user may have edited the prompt while reading Windows' clipboard.
      await latest.current.handleFileAttachment(renamedFile);
    } finally {
      if (mounted.current) start.setProcessingAttachments(previous => previous.filter(item => item.id !== id));
    }
  }, []);
}
