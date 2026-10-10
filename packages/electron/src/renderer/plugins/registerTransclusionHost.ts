/**
 * Desktop host for transclusion blocks: reads a linked page's markdown live
 * and opens the page on click. Every read goes through a path that already
 * exists, and one read per page is shared by every block showing it:
 *
 *   team page    the shared-document embed provider cache (one room
 *                connection per document, ref-counted with embeds and
 *                headless agent reads); re-projected on every Y.Doc update
 *   Personal     `readPersonalPageForAgent` (mounted editor, local wiki file,
 *   page         or the stored body); re-read when the page's index row
 *                changes
 *   typed page   the same reader over the item's body (live editor, then the
 *                body cache); re-read when the item record changes
 *
 * A team page open in a tab is held by the tab's own replica cache, so a
 * transclusion of it joins the room a second time through the embed cache.
 */

import { buildCollabUri } from '@nimbalyst/collab-protocol';
import {
  createReadSequencer,
  setTransclusionHost,
  type TransclusionSourceState,
} from '@nimbalyst/runtime/editor/plugins/TransclusionPlugin/transclusionHost';
import {
  transclusionTargetKey,
  type ParsedTransclusionHref,
} from '@nimbalyst/runtime/editor/plugins/TransclusionPlugin/transclusionLink';
import { trackerItemByReferenceKeyAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';

import { store } from '../store';
import {
  activeCollabScopeAtom,
  getSharedDocumentsForScopeKey,
  personalPagesDocumentsAtomFamily,
  sharedDocumentsAtom,
} from '../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import {
  acquireHeadlessCollabDocument,
  HeadlessCollabDocumentError,
  projectCollabDocContent,
  requireCollabCodec,
} from '../services/HeadlessCollabDocument';
import { readPersonalPageForAgent } from '../services/personalAgentEdit';
import { PERSONAL_PAGE_URI_PREFIX, personalTypedPageUri } from '../../shared/personalPageUri';
import { openConsoleLinkInWindow } from '../utils/openConsoleLink';
import { openTeamPage } from './registerDocumentLinkPlugin';

type Emit = (state: TransclusionSourceState) => void;

/** Starts reading one page; returns the stop. */
type PageReader = (emit: Emit) => () => void;

const UPDATE_DEBOUNCE_MS = 150;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function teamPageReader(orgId: string | null, documentId: string): PageReader {
  return (emit) => {
    let stopped = false;
    let started = false;
    let release: (() => void) | null = null;
    let detach: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The shared-document index hydrates after the window opens; until this
    // page is in it, re-check on every index change instead of reporting it
    // missing for good.
    const tryStart = () => {
      if (started || stopped) return;
      const scope = store.get(activeCollabScopeAtom);
      const workspacePath = store.get(activeWorkspacePathAtom);
      if (!scope || !workspacePath) {
        emit({ status: 'no-access', message: 'Open a team project to see this page.' });
        return;
      }
      if (orgId && orgId !== scope.orgId) {
        emit({ status: 'no-access', message: 'This page belongs to a different team.' });
        return;
      }
      const document = getSharedDocumentsForScopeKey(scope.scopeKey).find((doc) => doc.documentId === documentId);
      if (!document || document.trashedAt) {
        emit({ status: 'missing', message: document ? 'This page is in Trash.' : undefined });
        return;
      }
      if (document.documentType !== 'markdown') {
        emit({ status: 'error', message: 'Only text pages can be transcluded; open this one instead.' });
        return;
      }
      started = true;
      start(scope.orgId, workspacePath, document.title);
    };

    const start = (scopeOrgId: string, workspacePath: string, title: string) => {
      void acquireHeadlessCollabDocument(buildCollabUri(scopeOrgId, documentId), workspacePath)
        .then((acquisition) => {
          if (stopped) {
            acquisition.release();
            return;
          }
          release = acquisition.release;
          const codec = requireCollabCodec(acquisition.documentType);
          const project = () => emit({ status: 'ready', markdown: projectCollabDocContent(codec, acquisition.yDoc), title });
          project();
          const onUpdate = () => {
            if (timer !== null) return;
            timer = setTimeout(() => {
              timer = null;
              if (!stopped) project();
            }, UPDATE_DEBOUNCE_MS);
          };
          acquisition.yDoc.on('update', onUpdate);
          detach = () => acquisition.yDoc.off('update', onUpdate);
        })
        .catch((error) => {
          if (stopped) return;
          if (error instanceof HeadlessCollabDocumentError && error.code === 'DOCUMENT_NOT_AVAILABLE') {
            emit({ status: 'missing' });
          } else {
            emit({ status: 'error', message: `Could not load this page: ${errorMessage(error)}` });
          }
        });
    };

    tryStart();
    const unsubscribe = started ? () => {} : store.sub(sharedDocumentsAtom, tryStart);
    return () => {
      stopped = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      detach?.();
      release?.();
    };
  };
}

/** Reads `uri` now and again whenever `revisionOf()` changes. */
function storedPageReader(uri: string, revisionOf: () => unknown, titleOf: () => string | null, subscribe: (cb: () => void) => () => void): PageReader {
  return (emit) => {
    const workspacePath = store.get(activeWorkspacePathAtom);
    let stopped = false;
    let lastRevision: unknown = Symbol('unread');
    // Reads overlap when the page changes mid-read; only the newest may land,
    // and a deletion supersedes every read still in flight.
    const sequence = createReadSequencer();
    const read = () => {
      const revision = revisionOf();
      if (revision === lastRevision) return;
      lastRevision = revision;
      const isCurrent = sequence.next();
      if (revision === undefined) {
        emit({ status: 'missing' });
        return;
      }
      readPersonalPageForAgent(uri, workspacePath)
        .then((markdown) => {
          if (!stopped && isCurrent()) emit({ status: 'ready', markdown, title: titleOf() });
        })
        .catch((error) => {
          if (!stopped && isCurrent()) emit({ status: 'error', message: `Could not load this page: ${errorMessage(error)}` });
        });
    };
    read();
    const unsubscribe = subscribe(read);
    return () => {
      stopped = true;
      unsubscribe();
    };
  };
}

function personalPageReader(pageId: string): PageReader {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath) return (emit) => { emit({ status: 'missing' }); return () => {}; };
  const pagesAtom = personalPagesDocumentsAtomFamily(workspacePath);
  const page = () => store.get(pagesAtom).find((doc) => doc.documentId === pageId && !doc.trashedAt);
  return storedPageReader(
    `${PERSONAL_PAGE_URI_PREFIX}${pageId}`,
    () => page()?.updatedAt,
    () => page()?.title ?? null,
    (cb) => store.sub(pagesAtom, cb),
  );
}

function typedPageReader(itemRef: string): PageReader {
  const itemAtom = trackerItemByReferenceKeyAtom(itemRef);
  const item = () => store.get(itemAtom);
  return (emit) => {
    const record = item();
    if (!record) {
      emit({ status: 'missing', message: 'This typed page is not in this project, or it was deleted.' });
      return () => {};
    }
    return storedPageReader(
      personalTypedPageUri(record.id),
      () => item()?.system.updatedAt,
      () => {
        const title = item()?.fields.title;
        return typeof title === 'string' ? title : null;
      },
      (cb) => store.sub(itemAtom, cb),
    )(emit);
  };
}

function readerFor(link: ParsedTransclusionHref): PageReader {
  const { target } = link;
  switch (target.kind) {
    case 'collabDoc':
      return teamPageReader(target.orgId, target.documentId);
    case 'page':
      return target.scope === 'local' ? personalPageReader(target.pageId) : teamPageReader(target.scope.orgId, target.pageId);
    case 'item':
      return typedPageReader(target.itemRef);
  }
}

interface SharedRead {
  listeners: Set<Emit>;
  last: TransclusionSourceState;
  stop: () => void;
}

const reads = new Map<string, SharedRead>();

function subscribe(link: ParsedTransclusionHref, onChange: Emit): () => void {
  const key = transclusionTargetKey(link.target);
  let read = reads.get(key);
  if (!read) {
    const created: SharedRead = { listeners: new Set(), last: { status: 'loading' }, stop: () => {} };
    reads.set(key, created);
    created.stop = readerFor(link)((state) => {
      created.last = state;
      for (const listener of created.listeners) listener(state);
    });
    read = created;
  }
  read.listeners.add(onChange);
  onChange(read.last);
  const current = read;
  return () => {
    current.listeners.delete(onChange);
    if (current.listeners.size > 0) return;
    reads.delete(key);
    current.stop();
  };
}

function open(link: ParsedTransclusionHref, options: { href: string; newTab: boolean }): void {
  if (link.target.kind === 'collabDoc') {
    openTeamPage(link.pageHref, { newTab: options.newTab });
    return;
  }
  openConsoleLinkInWindow(link.pageHref, { newTab: options.newTab });
}

export function registerTransclusionHost(): void {
  setTransclusionHost({ subscribe, open });
}
