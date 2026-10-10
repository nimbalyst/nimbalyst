/**
 * Agent reads and edits of Personal pages (Decision 20). Like shared pages,
 * an agent edit lands as final text with no review step; the page's local
 * history is how a person reverts it.
 *
 *   personal://<documentId>              Local page body: the page's markdown file in the
 *                                        wiki folder (`local-wiki:*` IPC), or a database
 *                                        Personal page not exported yet (`personal-pages:*`)
 *   personal://tracker-content/<itemId>  Personal typed-page body (the tracker item's content)
 *
 * A page open in a tab is edited through its mounted editor, which saves
 * through its own path. Editing the stored body under it would leave the tab
 * showing old text, and a typed page's pending autosave would write that old
 * text straight back over the agent's edit. Otherwise the stored body is
 * edited directly: read with its version, apply the replacements, write back
 * only if the version still matches (one retry on a race). Either kind keeps
 * its pre-edit text in local history first.
 */
import type { LexicalEditor } from 'lexical';
import type { TextReplacement } from '@nimbalyst/runtime';
// Deep paths, not the barrels: see HeadlessCollabDocEdit.
import { applyTextReplacementsToString } from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/diffUtils';
import {
  APPLY_MARKDOWN_REPLACE_COMMAND,
  type ApplyMarkdownReplaceResult,
} from '@nimbalyst/runtime/editor/plugins/DiffPlugin/DiffCommands';
import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import { parsePersonalPageUri, personalTypedPageHistoryKey } from '../../shared/personalPageUri';

const PERSONAL_DOC_EDITOR_PREFIX = 'personal-doc://';

type BodyWrite = { version: number } | { conflict: true; version: number; content: string };
/** A Local wiki page: its body (frontmatter excluded), body version and markdown file. */
type WikiPageBody = { content: string; version: string; filePath: string };
type TypedPageBodyWrite = { written: true } | { conflict: true; version: number };

/** A typed page's body editor while it is mounted. */
export interface LiveTypedPageEditor {
  editor: LexicalEditor;
  getContent(): string;
  /** Replace the whole body (a history restore); the editor's autosave stores it. */
  replaceContent(markdown: string): void;
}

export interface PersonalPageIo {
  getBody(workspacePath: string, documentId: string): Promise<{ content: string; version: number } | null>;
  updateBody(workspacePath: string, documentId: string, content: string, expectedVersion?: number): Promise<BodyWrite>;
  /** The page in the Local wiki folder; null when it is not there (a database page, or unknown). */
  getWikiPage?(workspacePath: string, documentId: string): Promise<WikiPageBody | null>;
  /** Writes a Local wiki page's body if it is still at `expectedVersion`. */
  writeWikiPage?(workspacePath: string, documentId: string, content: string, expectedVersion: string): Promise<{ ok: boolean }>;
  /** Keep text in a page's local history under its history key. */
  keepInHistory(historyKey: string, content: string, description: string): Promise<void>;
  /** The body with its `body_version`; version null when it cannot be read together with the text. */
  getTypedPageBody(itemId: string): Promise<{ content: unknown; version: number | null }>;
  setTypedPageBody(itemId: string, content: string, expectedVersion: number): Promise<TypedPageBodyWrite>;
  /** The typed page's mounted body editor, if any. */
  liveTypedPage(itemId: string): LiveTypedPageEditor | null;
  /** The editor mounted for this path, if any, applies the replacements itself. */
  mountedEditor: {
    has(path: string): boolean;
    applyReplacements(path: string, replacements: TextReplacement[], requestId?: string): Promise<{ success: boolean; error?: string } | undefined>;
    getContent(path: string): string;
  };
}

const liveTypedPages = new Map<string, LiveTypedPageEditor[]>();

/**
 * Called by a typed page's body editor when it mounts; returns the
 * unregister. The same item can be mounted twice (a Pages tab and Tracker
 * mode's detail); an edit goes to the visible one, else the latest.
 */
export function registerLiveTypedPageEditor(itemId: string, live: LiveTypedPageEditor): () => void {
  liveTypedPages.set(itemId, [...(liveTypedPages.get(itemId) ?? []), live]);
  return () => {
    const rest = (liveTypedPages.get(itemId) ?? []).filter((entry) => entry !== live);
    if (rest.length > 0) liveTypedPages.set(itemId, rest);
    else liveTypedPages.delete(itemId);
  };
}

function isShown(editor: LexicalEditor): boolean {
  try {
    const root = editor.getRootElement();
    return !!root && root.isConnected && root.offsetParent !== null;
  } catch {
    // A headless editor has no root element.
    return false;
  }
}

function liveTypedPage(itemId: string): LiveTypedPageEditor | null {
  const entries = liveTypedPages.get(itemId) ?? [];
  return entries.find((entry) => isShown(entry.editor)) ?? entries.at(-1) ?? null;
}

const rendererIo: PersonalPageIo = {
  getBody: (workspacePath, documentId) =>
    window.electronAPI.invoke('personal-pages:get-body', workspacePath, documentId),
  updateBody: (workspacePath, documentId, content, expectedVersion) =>
    window.electronAPI.invoke('personal-pages:update-body', workspacePath, documentId, content, expectedVersion),
  getWikiPage: async (workspacePath, documentId) => {
    const filePath = await window.electronAPI.invoke('local-wiki:page-path', workspacePath, documentId) as string | null;
    if (!filePath) return null;
    const body = await window.electronAPI.invoke('local-wiki:read-body', workspacePath, documentId) as { markdown: string; version: string };
    return { content: body.markdown, version: body.version, filePath };
  },
  writeWikiPage: (workspacePath, documentId, content, expectedVersion) =>
    window.electronAPI.invoke('local-wiki:write-body', workspacePath, documentId, content, expectedVersion),
  keepInHistory: async (historyKey, content, description) => {
    await window.electronAPI.invoke('history:create-snapshot', historyKey, content, 'pre-apply', description);
  },
  getTypedPageBody: async (itemId) => {
    // Every body write caches its text under the version it bumped to; this
    // reads the row at the current version, text and version in one query.
    const cached = await window.electronAPI.documentService.getTrackerBodyCacheForDetail({ itemId });
    if (cached.success && cached.row) return { content: cached.row.content, version: cached.row.bodyVersion };
    const result = await window.electronAPI.documentService.getTrackerItemContent({ itemId });
    if (!result.success) throw new Error(result.error || `Could not read the typed page ${itemId}`);
    return { content: result.content, version: null };
  },
  setTypedPageBody: async (itemId, content, expectedVersion) => {
    const result = await window.electronAPI.documentService.updateTrackerItemContent({
      itemId,
      content,
      expectedBodyVersion: expectedVersion,
    });
    if (result.conflict) return { conflict: true, version: result.bodyVersion ?? 0 };
    if (!result.success) throw new Error(result.error || `Could not save the typed page ${itemId}`);
    return { written: true };
  },
  liveTypedPage,
  mountedEditor: editorRegistry,
};

export interface PersonalEditResult {
  success: boolean;
  error?: string;
  code?: string;
}

function personalDocEditorPath(documentId: string): string {
  return `${PERSONAL_DOC_EDITOR_PREFIX}${documentId}`;
}

function failure(error: unknown, code?: string): PersonalEditResult {
  return {
    success: false,
    ...(code ? { code } : {}),
    error: error instanceof Error ? error.message : String(error),
  };
}

function markdownOf(value: unknown, what: string): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${what} is not stored as markdown and cannot be edited as text.`);
  return value;
}

/** Current text of a Personal page or typed-page body. Throws when it cannot be read. */
export async function readPersonalPageForAgent(
  uri: string,
  workspacePath: string | null | undefined,
  io: PersonalPageIo = rendererIo,
): Promise<string> {
  const target = parsePersonalPageUri(uri);
  if (!target) throw new Error(`Not a Personal page URI: ${uri}`);
  if (target.kind === 'typed-page') {
    const live = io.liveTypedPage(target.itemId);
    if (live) return live.getContent();
    return markdownOf((await io.getTypedPageBody(target.itemId)).content, `The typed page ${target.itemId}`);
  }
  const wikiPage = workspacePath && io.getWikiPage ? await io.getWikiPage(workspacePath, target.documentId) : null;
  if (wikiPage) {
    // An open file tab may hold edits not saved yet; its editor has the text the person sees.
    return io.mountedEditor.has(wikiPage.filePath) ? io.mountedEditor.getContent(wikiPage.filePath) : wikiPage.content;
  }
  const editorPath = personalDocEditorPath(target.documentId);
  if (io.mountedEditor.has(editorPath)) return io.mountedEditor.getContent(editorPath);
  if (!workspacePath) throw new Error(`No workspace is open to read ${uri}.`);
  const body = await io.getBody(workspacePath, target.documentId);
  if (!body) throw new Error(`Unknown Personal page '${target.documentId}'.`);
  return body.content;
}

/**
 * A Local page's stored body: the wiki file's body, or a database page's body
 * with its version. Mounted editors are not consulted.
 */
export async function readLocalPageBody(
  workspacePath: string,
  documentId: string,
  io: PersonalPageIo = rendererIo,
): Promise<{ markdown: string; version?: number }> {
  const wikiPage = io.getWikiPage ? await io.getWikiPage(workspacePath, documentId) : null;
  if (wikiPage) return { markdown: wikiPage.content };
  const body = await io.getBody(workspacePath, documentId);
  return { markdown: body?.content ?? '', ...(body ? { version: body.version } : {}) };
}

/** The edit lands as final text in the mounted editor; its autosave stores it. */
function editLiveTypedPage(live: LiveTypedPageEditor, replacements: TextReplacement[]): PersonalEditResult {
  let outcome: ApplyMarkdownReplaceResult | undefined;
  const handled = live.editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, {
    replacements,
    acceptChanges: true,
    onResult: (result) => { outcome = result; },
  });
  if (!handled || !outcome) return failure('The open typed page did not take the edit.');
  return outcome.ok ? { success: true } : failure(outcome.message, outcome.errorType);
}

async function editStoredTypedPage(itemId: string, replacements: TextReplacement[], io: PersonalPageIo): Promise<void> {
  let knownVersion: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await io.getTypedPageBody(itemId);
    // A version learned before this read is safe to pair with its text: a
    // save in between only moves the stored version past it.
    const version = body.version ?? knownVersion ?? 0;
    const current = markdownOf(body.content, `The typed page ${itemId}`);
    const next = applyTextReplacementsToString(current, replacements);
    if (next === current) return;
    if (attempt === 0) await io.keepInHistory(personalTypedPageHistoryKey(itemId), current, 'Before agent edit');
    const written = await io.setTypedPageBody(itemId, next, version);
    if (!('conflict' in written)) return;
    knownVersion = written.version;
  }
  throw new Error(`The typed page '${itemId}' kept changing while the edit was applied. Read it again and retry.`);
}

async function editStoredWikiPage(
  workspacePath: string,
  documentId: string,
  first: WikiPageBody,
  replacements: TextReplacement[],
  io: PersonalPageIo,
): Promise<void> {
  let body: WikiPageBody | null = first;
  for (let attempt = 0; attempt < 2 && body; attempt++) {
    const next = applyTextReplacementsToString(body.content, replacements);
    if (next === body.content) return;
    if (attempt === 0) await io.keepInHistory(body.filePath, body.content, 'Before agent edit');
    if ((await io.writeWikiPage!(workspacePath, documentId, next, body.version)).ok) return;
    body = await io.getWikiPage!(workspacePath, documentId);
  }
  throw new Error(`The Local page '${documentId}' kept changing while the edit was applied. Read it again and retry.`);
}

async function editStoredPersonalPage(
  workspacePath: string,
  documentId: string,
  replacements: TextReplacement[],
  io: PersonalPageIo,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await io.getBody(workspacePath, documentId);
    if (!body) throw new Error(`Unknown Personal page '${documentId}'.`);
    const next = applyTextReplacementsToString(body.content, replacements);
    if (next === body.content) return;
    if (attempt === 0) {
      await io.keepInHistory(personalDocEditorPath(documentId), body.content, 'Before agent edit');
    }
    const written = await io.updateBody(workspacePath, documentId, next, body.version);
    if (!('conflict' in written)) return;
  }
  throw new Error(`The Personal page '${documentId}' kept changing while the edit was applied. Read it again and retry.`);
}

export async function applyPersonalPageAgentEdit(
  uri: string,
  replacements: TextReplacement[],
  options: { workspacePath?: string | null; requestId?: string },
  io: PersonalPageIo = rendererIo,
): Promise<PersonalEditResult> {
  const target = parsePersonalPageUri(uri);
  if (!target) return failure(`Not a Personal page URI: ${uri}`, 'INVALID_URI');
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return failure('An edit needs at least one replacement.', 'INVALID_INPUT');
  }
  try {
    if (target.kind === 'typed-page') {
      const live = io.liveTypedPage(target.itemId);
      if (live) {
        await io.keepInHistory(personalTypedPageHistoryKey(target.itemId), live.getContent(), 'Before agent edit');
        return editLiveTypedPage(live, replacements);
      }
      await editStoredTypedPage(target.itemId, replacements, io);
      return { success: true };
    }

    const wikiPage = options.workspacePath && io.getWikiPage ? await io.getWikiPage(options.workspacePath, target.documentId) : null;
    if (wikiPage) {
      if (io.mountedEditor.has(wikiPage.filePath)) {
        const result = await io.mountedEditor.applyReplacements(wikiPage.filePath, replacements, options.requestId);
        return result ?? { success: false, error: 'No result returned from the open Local page.' };
      }
      await editStoredWikiPage(options.workspacePath!, target.documentId, wikiPage, replacements, io);
      return { success: true };
    }
    const editorPath = personalDocEditorPath(target.documentId);
    if (io.mountedEditor.has(editorPath)) {
      const result = await io.mountedEditor.applyReplacements(editorPath, replacements, options.requestId);
      return result ?? { success: false, error: 'No result returned from the open Personal page.' };
    }
    if (!options.workspacePath) {
      return failure(`No workspace is open to edit ${uri}.`, 'DOCUMENT_NOT_AVAILABLE');
    }
    await editStoredPersonalPage(options.workspacePath, target.documentId, replacements, io);
    return { success: true };
  } catch (error) {
    return failure(error);
  }
}

const RESTORE_CONFLICT = 'This page changed while restoring. Its current text was kept; try again.';

/**
 * Restore a Personal typed page's body from its local history. An open body
 * editor takes the restored text itself, so its pending autosave cannot write
 * the replaced text back over it; otherwise the stored body is written at the
 * version it was read at.
 *
 * A restore replaces the whole body, so a refused write means someone saved
 * after the read, and it rejects rather than overwrite that save. A body read
 * without its version is written at the version a refused write reports, and
 * only while the text is still what was read.
 */
export async function restorePersonalTypedPageBody(
  itemId: string,
  markdown: string,
  io: PersonalPageIo = rendererIo,
): Promise<void> {
  const live = io.liveTypedPage(itemId);
  if (live) {
    live.replaceContent(markdown);
    return;
  }
  const read = await io.getTypedPageBody(itemId);
  const written = await io.setTypedPageBody(itemId, markdown, read.version ?? 0);
  if (!('conflict' in written)) return;
  if (read.version !== null) throw new Error(RESTORE_CONFLICT);
  const reread = await io.getTypedPageBody(itemId);
  const moved = JSON.stringify(reread.content) !== JSON.stringify(read.content)
    || (reread.version !== null && reread.version !== written.version);
  if (moved) throw new Error(RESTORE_CONFLICT);
  const retried = await io.setTypedPageBody(itemId, markdown, written.version);
  if ('conflict' in retried) throw new Error(RESTORE_CONFLICT);
}
