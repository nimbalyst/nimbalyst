/**
 * Decision for the per-window `close` handler in WindowManager: should this
 * close trigger a global session-state re-save?
 *
 * The re-save exists so a window the user closes mid-session is not restored
 * on next launch. But during app teardown the same handler fires for EVERY
 * window as Electron closes them, each time re-saving a shrinking window
 * list that ends at `{ windows: [] }` — clobbering the complete state that
 * `before-quit` already saved, so the next launch restores nothing.
 *
 * NIM-869 guarded the restart path; NIM-1518 is the same clobber on the
 * normal quit path, which was left unguarded.
 */
export function shouldSaveSessionOnWindowClose(opts: {
  isQuitting: boolean;
  isRestarting: boolean;
}): boolean {
  return !opts.isQuitting && !opts.isRestarting;
}
