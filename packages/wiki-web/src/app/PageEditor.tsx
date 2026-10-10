/**
 * A page body: the shared Lexical editor over an in-memory Y.Doc seeded from
 * the page's markdown file, saved back as markdown.
 *
 * - Open: `readBody` gives the markdown and its version; the doc is seeded
 *   before mounting (the mount never bootstraps an in-memory doc itself).
 * - Save: edits are debounced and written with the version they were based on.
 *   A 409 means the file changed under us; the person picks which text wins.
 * - Outside edits: a change event for this page re-reads the file. With no
 *   unsaved edits here it is applied in place (`replaceMarkdown`); otherwise
 *   it is the same conflict as a rejected save.
 *
 * The baseline is the editor's own export of what was last read or saved, not
 * the file text: the markdown round trip may normalize, and comparing against
 * the file would write a reformatted copy of every page someone merely opened.
 * Y.Doc-only state (inline comment threads) does not survive; marks written as
 * markdown text do.
 *
 * Closing: the app asks this editor to finish its save before navigating away
 * (see `drafts.ts`). Edits it still cannot write when it closes are held in the
 * draft store and restored, conflict included, when the page opens again.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Doc as YDoc } from 'yjs';
import {
  asTeamMemberId,
  MarkdownCollabContentAdapter,
  mountCollabEditor,
  type CollabEditorHandle,
  type TrackerReferenceResolver,
} from '@nimbalyst/collab-bundle/editor';
import { wikiApi, wikiChanges } from '../api/client';
import { DraftStoreContext, type Conflict, type PageDraft, type SaveOutcome } from './drafts';

const SAVE_DELAY_MS = 600;
const LOCAL_USER = { memberId: asTeamMemberId('local'), name: 'You' };

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';

export function saveStateLabel(state: SaveState, error: string | null): string {
  return state === 'saving' ? 'Saving…' : state === 'unsaved' ? 'Unsaved changes' : state === 'error' ? `Not saved: ${error}` : 'Saved to file';
}

export function PageEditor({
  pageId,
  trackerReferences,
  trackerReferenceSource,
  onSaveState,
}: {
  pageId: string;
  trackerReferences?: TrackerReferenceResolver;
  trackerReferenceSource?: { itemId: string; type: string };
  /** When given, the host shows the save state (in its header); otherwise it is a line under the body. */
  onSaveState?: (state: SaveState, error: string | null) => void;
}) {
  const drafts = useContext(DraftStoreContext);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [malformed, setMalformed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Live state the async paths share; refs so the editor never remounts.
  const handleRef = useRef<CollabEditorHandle | null>(null);
  const versionRef = useRef<string | null>(null);
  const baselineRef = useRef<string>('');
  const conflictRef = useRef<Conflict | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The write in flight; the next one waits for it, so a page never races its own version. */
  const savingRef = useRef<Promise<SaveOutcome> | null>(null);
  const malformedRef = useRef(false);
  malformedRef.current = malformed;

  const docRef = useRef<YDoc | null>(null);
  /** Set while a disk version is applied, so its doc updates are not taken for typing. */
  const applyingRef = useRef(false);

  /**
   * The doc's own markdown export: the one comparison space for "has this
   * changed". The editor's `getMarkdown` is empty until the binding has painted
   * the doc, which happens after `onReady`.
   */
  const exported = useCallback((): string | null => {
    const doc = docRef.current;
    return doc ? String(MarkdownCollabContentAdapter.exportToFile(doc)) : null;
  }, []);

  const showConflict = useCallback((next: Conflict | null) => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

  const applyDisk = useCallback((markdown: string, version: string) => {
    const handle = handleRef.current;
    if (!handle?.replaceMarkdown) return;
    applyingRef.current = true;
    try {
      handle.replaceMarkdown(markdown);
    } finally {
      applyingRef.current = false;
    }
    versionRef.current = version;
    baselineRef.current = exported() ?? '';
    setSaveState('saved');
  }, [exported]);

  /** The unsaved state, or null when the doc matches what was last read or saved. */
  const capture = useCallback((): PageDraft | null => {
    const markdown = exported();
    if (markdown === null || malformedRef.current) return null;
    if (markdown === baselineRef.current && !conflictRef.current) return null;
    return { pageId, markdown, baseline: baselineRef.current, baseVersion: versionRef.current, conflict: conflictRef.current };
  }, [exported, pageId]);

  const writeOnce = useCallback(async (handle: CollabEditorHandle | null, doc: YDoc | null, overwrite: boolean): Promise<SaveOutcome> => {
    const snapshot = doc ? String(MarkdownCollabContentAdapter.exportToFile(doc)) : null;
    if (!handle || snapshot === null) return 'saved';
    if (conflictRef.current && !overwrite) return 'conflict';
    if (snapshot === baselineRef.current && !overwrite) {
      setSaveState('saved');
      return 'saved';
    }
    const markdown = handle.getMarkdown();
    setSaveState('saving');
    const expected = overwrite ? conflictRef.current?.diskVersion ?? versionRef.current : versionRef.current;
    // A draft held after the editor closed tracks this write's outcome.
    const held = drafts.held(pageId);
    try {
      const result = await wikiApi.writeBody(pageId, markdown, expected);
      if (result.ok) {
        versionRef.current = result.version;
        baselineRef.current = snapshot;
        showConflict(null);
        setSaveError(null);
        if (held && held.markdown === snapshot) drafts.drop(pageId);
        // More typing may have landed during the request.
        const now = exported();
        const moved = now !== null && now !== snapshot;
        setSaveState(moved ? 'unsaved' : 'saved');
        if (moved) timerRef.current = setTimeout(() => void saveRef.current(), SAVE_DELAY_MS);
        return 'saved';
      }
      const conflict = { diskMarkdown: result.markdown, diskVersion: result.currentVersion };
      showConflict(conflict);
      setSaveState('unsaved');
      if (held) drafts.hold({ ...held, conflict });
      return 'conflict';
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaveState('error');
      return 'error';
    }
  }, [drafts, exported, pageId, showConflict]);

  const save = useCallback((overwrite = false): Promise<SaveOutcome> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    // Captured now: the editor may close while an earlier write is still in flight.
    const [handle, doc, previous] = [handleRef.current, docRef.current, savingRef.current];
    const run = (previous ?? Promise.resolve<SaveOutcome>('saved')).then(() => writeOnce(handle, doc, overwrite));
    savingRef.current = run;
    void run.finally(() => {
      if (savingRef.current === run) savingRef.current = null;
    });
    return run;
  }, [writeOnce]);
  // Read by the debounce timer and the draft store, which outlive a render.
  const saveRef = useRef(save);
  saveRef.current = save;
  const captureRef = useRef(capture);
  captureRef.current = capture;

  const scheduleSave = useCallback(() => {
    setSaveState('unsaved');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    let live = true;
    let doc: YDoc | null = null;
    let handle: CollabEditorHandle | null = null;
    setLoadError(null);
    showConflict(null);
    setSaveState('saved');

    // Edits left here unsaved last time. They stay held until the doc carries them again.
    const held = drafts.held(pageId);
    const detach = drafts.attach({
      pageId,
      dirty: () => captureRef.current() !== null,
      conflicted: () => conflictRef.current !== null,
      save: (overwrite) => saveRef.current(overwrite),
      discard: () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        baselineRef.current = exported() ?? baselineRef.current;
        showConflict(null);
      },
    });

    void wikiApi.readBody(pageId).then((body) => {
      if (!live) return;
      const restore = held && body.malformed !== true ? held : null;
      versionRef.current = restore ? restore.baseVersion : body.version;
      setMalformed(body.malformed === true);
      doc = new YDoc();
      MarkdownCollabContentAdapter.seedFromFile(doc, restore ? restore.markdown : body.markdown);
      docRef.current = doc;
      baselineRef.current = restore ? restore.baseline : exported() ?? '';
      if (restore) {
        // The file moved past the draft's base: the same choice a rejected save offers.
        showConflict(body.version === restore.baseVersion ? null : { diskMarkdown: body.markdown, diskVersion: body.version });
        setSaveState('unsaved');
        drafts.drop(pageId);
      }
      handle = mountCollabEditor({
        element,
        source: { kind: 'in-memory', document: doc },
        user: LOCAL_USER,
        // A file whose frontmatter does not parse is shown whole and not written until fixed by hand.
        readOnly: body.malformed === true,
        trackerReferences,
        trackerReferenceAppearance: 'quiet',
        trackerReferenceSource,
        onReady: (ready) => {
          handleRef.current = ready;
          if (restore && !conflictRef.current) scheduleSave();
        },
        onError: (error) => setLoadError(error.message),
        onBindingError: (error) => setLoadError(`This page could not be shown: ${error.message}`),
      });
      doc.on('update', () => {
        if (handleRef.current && !malformedRef.current && !applyingRef.current) scheduleSave();
      });
    }).catch((error: unknown) => {
      if (live) setLoadError(error instanceof Error ? error.message : String(error));
    });

    const unsubscribe = wikiChanges.subscribe((event) => {
      if (event.type !== 'change' || !event.change.changedIds.includes(pageId)) return;
      void wikiApi.readBody(pageId).then((body) => {
        if (!live || body.version === versionRef.current) return; // our own write coming back
        const current = exported();
        if (current === null || !handleRef.current) return;
        if (current === baselineRef.current && !conflictRef.current) applyDisk(body.markdown, body.version);
        else showConflict({ diskMarkdown: body.markdown, diskVersion: body.version });
      }).catch(() => {
        // Trashed or moved away; the tree's refresh shows that.
      });
    });

    return () => {
      live = false;
      unsubscribe();
      detach();
      // Unsaved edits outlive the editor; a write that lands below drops them again.
      const draft = capture();
      if (draft) drafts.hold(draft);
      // Last edits are written on the way out rather than dropped.
      const writing = draft && !draft.conflict ? save() : savingRef.current;
      handleRef.current = null;
      docRef.current = null;
      // The editor owns a React root; unmounting it inside this commit makes React warn and race.
      // A write still in flight reads the editor, so it is destroyed after that settles.
      const [closing, closingDoc] = [handle, doc];
      void Promise.resolve(writing).finally(() => setTimeout(() => {
        closing?.destroy();
        closingDoc?.destroy();
      }, 0));
    };
    // trackerReferences and its source are read at mount, like the console's mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;
  useEffect(() => {
    onSaveStateRef.current?.(saveState, saveError);
  }, [saveState, saveError]);

  useEffect(() => {
    const flush = () => {
      if (timerRef.current) void save();
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [save]);

  return (
    <div className="wiki-web-page-editor flex min-h-0 flex-1 flex-col">
      {malformed ? (
        <div className="wiki-web-banner mx-8 my-2 rounded border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim-muted" role="status">
          This file&apos;s frontmatter does not parse, so it is shown whole and read-only. Fix it in an editor and it opens normally.
        </div>
      ) : null}
      {conflict ? (
        <div className="wiki-web-conflict mx-8 my-2 flex flex-wrap items-center gap-2 rounded border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim" role="alert">
          <span className="flex-1">This page changed on disk while you were editing it.</span>
          <button type="button" className="rounded border border-nim px-2 py-1 hover:bg-nim-hover" onClick={() => {
            applyDisk(conflict.diskMarkdown, conflict.diskVersion);
            showConflict(null);
          }}>
            Use the file
          </button>
          <button type="button" className="rounded border border-nim px-2 py-1 hover:bg-nim-hover" onClick={() => void save(true)}>
            Keep mine
          </button>
        </div>
      ) : null}
      {loadError ? (
        <div className="wiki-web-banner mx-8 my-2 text-xs text-nim-error" role="alert">{loadError}</div>
      ) : null}
      {/* The console's editor surface (web-console collab/editorSurfaceStyles.ts): the editor fills the pane. */}
      <div ref={hostRef} className="wiki-web-editor-host collab-editor-surface flex min-h-[200px] flex-1 flex-col bg-nim" data-testid="wiki-web-editor" />
      {onSaveState ? null : (
        <div className="wiki-web-save-state px-8 pb-2 text-[11px] text-nim-faint" data-save-state={saveState} aria-live="polite">
          {saveStateLabel(saveState, saveError)}
        </div>
      )}
    </div>
  );
}
