/**
 * Wire up the runtime's DocumentLinkPlugin against the electron document
 * service and publish it as a renderer-contributed Lexical UI plugin.
 *
 * The plugin's headless concerns (markdown transformers, the
 * `DocumentReferenceNode` registration) come from
 * `registerDocumentReferenceContributions`, shared with every other host that
 * opens a document — a host missing the node class cannot decode a Y.Doc that
 * contains one.
 */

import React, { useMemo } from 'react';
import { isAbsolute, join } from 'pathe';
import {
  TypeaheadMenuPlugin,
  registerExtensionEditorComponent,
  setWorkspaceFileLinkOpener,
  useAnchorElem,
  useDocumentPath,
} from '@nimbalyst/runtime';
import {
  DOCUMENT_LINK_SOURCE,
  registerDocumentReferenceContributions,
} from '@nimbalyst/runtime/plugins/referenceNodeContributions';
import {
  DocumentLinkPlugin,
  type CollabReferenceOption,
  type CollabReferenceSource,
} from '@nimbalyst/runtime/plugins/DocumentLinkPlugin';
import {
  resolveDocumentLinkLookupPaths,
  parseCollabReferenceDocumentId,
} from '@nimbalyst/runtime/plugins/DocumentLinkPlugin/documentLinkPaths';
import { ElectronRendererDocumentService } from '../services/ElectronDocumentService';
import { parseCollabUri } from '@nimbalyst/collab-protocol';
import {
  sharedDocumentsAtom,
  sharedFoldersAtom,
  activeCollabScopeAtom,
  buildSharedDocumentDeepLink,
  pendingCollabDocumentAtom,
  personalPagesDocumentsAtomFamily,
  getTeamSyncProvider,
  getPersonalCollabHost,
} from '../store/atoms/collabDocuments';
import type { MentionMember } from '@nimbalyst/runtime/editor/plugins/MentionPlugin/mentionTypeahead';
import { teamMemberDisplayName } from '../utils/teamMemberDisplayName';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { setWindowModeAtom, windowModeAtom } from '../store/atoms/windowMode';
import { openConsoleLinkInWindow } from '../utils/openConsoleLink';
import {
  isPersonalPageLink,
  localFileReferenceSource,
  personalPageIdOf,
  personalPageReferenceOptions,
  referenceContextOf,
  teamPageReferenceOptions,
} from './pageReferenceSources';
import { store } from '../store';

const SOURCE = DOCUMENT_LINK_SOURCE;
const documentService = new ElectronRendererDocumentService();

// Custom trigger function that allows dots and hyphens in filenames so
// `@README.md` and `@settings-atomwithstorage-rewrite.excalidraw` both
// keep the typeahead open as the user types. Punctuation that would end a
// reasonable filename token (parens, brackets, quotes, etc.) still ends
// the match so the menu closes when the user moves on to other prose.
function createDocumentLinkTrigger(trigger: string, { minLength = 0, maxLength = 75 }) {
  const FILENAME_TERMINATORS = String.raw`\,\+\*\?\$\|#{}\(\)\^\[\]\\\/!%'"~=<>:;`;
  return (text: string) => {
    const validChars = '[^' + trigger + FILENAME_TERMINATORS + '\\s]';
    const regex = new RegExp(
      '(^|\\s|\\()(' +
        '[' +
        trigger +
        ']' +
        '((?:' +
        validChars +
        '){0,' +
        maxLength +
        '})' +
        ')$',
    );
    const match = regex.exec(text);
    if (match !== null) {
      const maybeLeadingWhitespace = match[1];
      const matchingString = match[3];
      if (matchingString.length >= minLength) {
        return {
          leadOffset: match.index + maybeLeadingWhitespace.length,
          matchingString,
          replaceableString: match[2],
        };
      }
    }
    return null;
  };
}

function listTeamPages(options: { currentDocumentId?: string; pathPrefix?: string } = {}): CollabReferenceOption[] {
  const scope = store.get(activeCollabScopeAtom);
  if (!scope) return [];
  return teamPageReferenceOptions({
    documents: store.get(sharedDocumentsAtom),
    folders: store.get(sharedFoldersAtom),
    deepLink: (documentId) => buildSharedDocumentDeepLink(documentId, scope.orgId),
    ...options,
  });
}

function listPersonalPages(options: { currentDocumentId?: string | null; pathPrefix?: string } = {}): CollabReferenceOption[] {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath) return [];
  return personalPageReferenceOptions({ documents: store.get(personalPagesDocumentsAtomFamily(workspacePath)), ...options });
}

export function openTeamPage(target: string, options?: { newTab: boolean }): void {
  const scope = store.get(activeCollabScopeAtom);
  const targetDocumentId = parseCollabReferenceDocumentId(target);
  if (!scope || !targetDocumentId) return;

  // The Lexical plugin renders outside any TabsProvider, so it can't add
  // a tab directly. Route through the same shared-document open flow the
  // deep-link handler uses: switch to collab mode and hand the doc id to
  // the pending atom. CollabMode consumes it, opening (or focusing) the
  // shared doc with its own tab context + dedup.
  store.set(setWindowModeAtom, 'collab');
  store.set(pendingCollabDocumentAtom, {
    documentId: targetDocumentId,
    scopeKey: scope.scopeKey,
    orgId: scope.orgId,
    analyticsSource: 'deep_link',
    // A reference in a page navigates like any page link in Pages.
    openOptions: options ?? { newTab: false },
  });
}

function openPersonalPage(target: string, options?: { newTab: boolean }): void {
  openConsoleLinkInWindow(target, options);
}

/**
 * The active team's members, for `@` person mentions. Mentions are keyed by
 * email, so any document in a team workspace can mention a teammate; outside
 * a team there is no roster and `@` offers only pages and dates.
 */
function listMentionMembers(): MentionMember[] {
  const scope = store.get(activeCollabScopeAtom);
  const members = scope ? getTeamSyncProvider(scope)?.getTeamState()?.members ?? [] : [];
  return members
    .filter((member) => !!member.email)
    .map((member) => ({ name: teamMemberDisplayName(member), email: member.email! }));
}

/**
 * The Local wiki page a link in a wiki page points at, while Pages is shown.
 * The same file open in Files keeps opening its links as files.
 */
function localWikiPageFor(target: string, documentPath: string): string | null {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath || store.get(windowModeAtom) !== 'collab') return null;
  const wiki = getPersonalCollabHost(workspacePath).source();
  if (!wiki.documentIdForFile(documentPath)) return null;
  for (const candidate of resolveDocumentLinkLookupPaths(target, documentPath, workspacePath)) {
    const absolute = isAbsolute(candidate) ? candidate : join(workspacePath, candidate);
    const pageId = wiki.documentIdForFile(absolute);
    if (pageId) return pageId;
  }
  return null;
}

function referenceSourceFor(documentPath: string | null): CollabReferenceSource | null {
  switch (referenceContextOf(documentPath)) {
    case 'team': {
      let currentDocumentId: string | undefined;
      try {
        currentDocumentId = parseCollabUri(documentPath!).documentId;
      } catch {
        currentDocumentId = undefined;
      }
      return { listOptions: () => listTeamPages({ currentDocumentId }), openReference: openTeamPage };
    }
    case 'personal': {
      const currentDocumentId = personalPageIdOf(documentPath!);
      return {
        listOptions: () => listPersonalPages({ currentDocumentId }),
        openReference: openPersonalPage,
        ownsTarget: isPersonalPageLink,
      };
    }
    case 'local':
      return localFileReferenceSource({
        listTeam: () => listTeamPages({ pathPrefix: 'Team' }),
        listPersonal: () => listPersonalPages({ pathPrefix: 'Personal' }),
        openTeam: openTeamPage,
        openPersonal: openPersonalPage,
        wikiPageFor: (target) => localWikiPageFor(target, documentPath!),
      });
    case 'other':
      return null;
  }
}

function DocumentLinkPluginWrapper() {
  const triggerFn = useMemo(
    () => createDocumentLinkTrigger('@', { minLength: 0, maxLength: 75 }),
    [],
  );
  const anchorElem = useAnchorElem();

  // A page offers pages of its own section; a local file offers its files and
  // both sections' pages (pageReferenceSources.ts). Lists are read when the
  // menu opens, so no editor re-renders as pages change.
  const { documentPath } = useDocumentPath();
  const collabReferenceSource = useMemo(() => referenceSourceFor(documentPath), [documentPath]);

  return (
    <DocumentLinkPlugin
      documentService={documentService}
      TypeaheadMenuPlugin={TypeaheadMenuPlugin as React.ComponentType<unknown>}
      triggerFn={triggerFn}
      anchorElem={anchorElem || undefined}
      collabReferenceSource={collabReferenceSource}
      getMentionMembers={listMentionMembers}
    />
  );
}

export function registerDocumentLinkPlugin(): void {
  // Route file-path links (from the floating link editor and plain LinkNodes)
  // through the document service instead of window.open, which would spawn a
  // blank Electron child window (NIM-1487).
  setWorkspaceFileLinkOpener((rawHref, currentDocumentPath) => {
    const workspacePath =
      (window as unknown as { __workspacePath?: string }).__workspacePath ?? null;
    const candidatePaths = resolveDocumentLinkLookupPaths(
      rawHref,
      currentDocumentPath,
      workspacePath,
    );
    void (async () => {
      for (const candidate of candidatePaths) {
        const resolvedDoc = await documentService.getDocumentByPath(candidate);
        if (resolvedDoc) {
          await documentService.openDocument(resolvedDoc.id, { path: resolvedDoc.path });
          return;
        }
      }
      const fallbackPath = candidatePaths[candidatePaths.length - 1];
      await documentService.openDocument('', { path: fallbackPath || rawHref });
    })().catch((error) => {
      console.error('Failed to open workspace file link', rawHref, error);
    });
  });

  registerDocumentReferenceContributions();
  registerExtensionEditorComponent({
    name: SOURCE,
    Component: DocumentLinkPluginWrapper as React.ComponentType<unknown>,
  });
}
