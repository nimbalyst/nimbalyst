/**
 * The "Paused hooks" tray under the canvas. A paused hook is out of the file,
 * so it does not run. "Turn back on" puts it back at the end of its event. A hook that is
 * already in the file (a restored backup can bring it back) only leaves the tray.
 */

import { ALREADY_IN_FILE_TEXT, BUTTON, REMOVE_FROM_TRAY_TEXT, RESUME_BUTTON_TEXT } from './hookEditorText';
import type { PausedRow } from './hookEditorState';

export function HookPausedTray({ rows, onResume }: { rows: readonly PausedRow[]; onResume: (index: number) => void }) {
  if (rows.length === 0) return null;
  return (
    <section className="hook-paused-tray m-4 rounded border border-[var(--nim-border)] p-2" data-testid="hook-paused-tray">
      <h3 className="text-sm font-semibold">Paused hooks</h3>
      {rows.map((row) => (
        <div key={row.index} className="flex items-center gap-2 py-1 text-sm">
          <span className="select-text flex-1">
            {row.name}
            {row.main === '' ? '' : ` (${row.main})`} {row.place}
            {row.inFile && <span className="ml-2 text-[var(--nim-text-muted)]">{ALREADY_IN_FILE_TEXT}</span>}
          </span>
          <button type="button" data-testid={`hook-resume-${row.index}`} className={`${BUTTON.ghost} ${BUTTON.small}`} onClick={() => onResume(row.index)}>
            {row.inFile ? REMOVE_FROM_TRAY_TEXT : RESUME_BUTTON_TEXT}
          </button>
        </div>
      ))}
    </section>
  );
}
