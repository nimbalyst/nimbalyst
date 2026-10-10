/**
 * Unsaved page edits, kept outside the mounted editor.
 *
 * The editor is destroyed when its page closes, but a draft it could not write
 * (the file changed under it, or the write failed) must outlive it: the app
 * asks before leaving such a page, and a draft that is left anyway is held
 * here, so reopening the page restores it with its conflict still showing.
 *
 * One page editor is open at a time; it attaches itself so the app can finish
 * its save or ask before navigating away, and before the tab closes.
 */
import { createContext } from 'react';

export type Conflict = { diskMarkdown: string; diskVersion: string };
export type SaveOutcome = 'saved' | 'conflict' | 'error';

export interface PageDraft {
  pageId: string;
  /** The doc's markdown export, which seeds the doc again on reopen. */
  markdown: string;
  /** The export of what was last read or saved; equal to `markdown` means nothing to save. */
  baseline: string;
  /** The file version the draft was based on. */
  baseVersion: string | null;
  conflict: Conflict | null;
}

export interface OpenEditor {
  pageId: string;
  dirty(): boolean;
  conflicted(): boolean;
  save(overwrite?: boolean): Promise<SaveOutcome>;
  /** Drop the edits, so closing the editor holds nothing. */
  discard(): void;
}

export type LeaveDecision =
  | { kind: 'leave' }
  | { kind: 'stay' }
  | { kind: 'ask'; pageId: string; reason: 'conflict' | 'error' };

export type LeaveChoice = 'keep' | 'discard' | 'overwrite';

export class DraftStore {
  private readonly drafts = new Map<string, PageDraft>();
  private open: OpenEditor | null = null;

  attach(editor: OpenEditor): () => void {
    this.open = editor;
    return () => {
      if (this.open === editor) this.open = null;
    };
  }

  openEditor(): OpenEditor | null {
    return this.open;
  }

  hold(draft: PageDraft): void {
    this.drafts.set(draft.pageId, draft);
  }

  held(pageId: string): PageDraft | null {
    return this.drafts.get(pageId) ?? null;
  }

  drop(pageId: string): void {
    this.drafts.delete(pageId);
  }

  hasUnsaved(): boolean {
    return this.drafts.size > 0 || (this.open !== null && (this.open.dirty() || this.open.conflicted()));
  }
}

function outcomeDecision(pageId: string, outcome: SaveOutcome): LeaveDecision {
  return outcome === 'saved' ? { kind: 'leave' } : { kind: 'ask', pageId, reason: outcome };
}

/** Before navigating away: finish the open page's save, or say the person must choose. */
export async function prepareToLeave(store: DraftStore): Promise<LeaveDecision> {
  const editor = store.openEditor();
  if (!editor) return { kind: 'leave' };
  if (editor.conflicted()) return { kind: 'ask', pageId: editor.pageId, reason: 'conflict' };
  if (!editor.dirty()) return { kind: 'leave' };
  return outcomeDecision(editor.pageId, await editor.save());
}

/** The person's answer to the leave prompt. */
export async function resolveLeave(store: DraftStore, choice: LeaveChoice): Promise<LeaveDecision> {
  const editor = store.openEditor();
  if (choice === 'keep') return { kind: 'stay' };
  if (!editor) return { kind: 'leave' };
  if (choice === 'discard') {
    editor.discard();
    store.drop(editor.pageId);
    return { kind: 'leave' };
  }
  return outcomeDecision(editor.pageId, await editor.save(true));
}

export const DraftStoreContext = createContext<DraftStore>(new DraftStore());
