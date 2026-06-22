/**
 * EditorStateHandlers
 *
 * Renderer -> main reporting of editor state that the main process otherwise
 * cannot see. Currently just dirty (unsaved-buffer) transitions, consumed by the
 * DirtyEditorRegistry so personal docs sync can avoid clobbering unsaved edits.
 */
import { safeOn } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { dirtyEditorRegistry } from '../services/DirtyEditorRegistry';

export function registerEditorStateHandlers(): void {
  safeOn('editor:dirty-changed', (_event, payload: { filePath?: string; isDirty?: boolean }) => {
    if (!payload?.filePath) {
      logger.main.warn('[EditorState] editor:dirty-changed received without filePath');
      return;
    }
    dirtyEditorRegistry.setDirty(payload.filePath, !!payload.isDirty);
  });
}
