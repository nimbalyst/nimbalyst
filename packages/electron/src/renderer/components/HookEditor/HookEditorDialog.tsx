/** The hook editor as a full-window dialog. Opened through the dialog registry with DIALOG_IDS.HOOK_EDITOR. */

import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import { HookEditor } from './HookEditor';

export interface HookEditorDialogData {
  workspacePath: string;
  source: SettingsSource;
  selectId: string | null;
  focusPalette: boolean;
  /** Runs after the dialog closes, so the settings page can read the files again. */
  onClosed: () => void;
  /** The dialog provider calls this when the dialog goes away by any route, such as Escape or another dialog. */
  onDismiss?: () => void;
}

export function HookEditorDialog({ isOpen, onClose, data }: { isOpen: boolean; onClose: () => void; data: HookEditorDialogData }) {
  if (!isOpen) return null;
  const close = () => {
    onClose();
    data.onClosed();
  };
  return (
    <div
      className="hook-editor-dialog fixed inset-0 z-[10000] flex bg-black/50 p-4"
      // A click on the dark margin would move the focus out of the editor, and then Escape reaches nothing.
      // So the click keeps the focus in the editor.
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.currentTarget.querySelector<HTMLElement>('.hook-editor')?.focus();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Claude Code hooks" className="flex flex-1 overflow-hidden rounded-lg border border-[var(--nim-border)]">
        <HookEditor
          workspacePath={data.workspacePath}
          source={data.source}
          selectId={data.selectId}
          focusPalette={data.focusPalette}
          onClose={close}
        />
      </div>
    </div>
  );
}
