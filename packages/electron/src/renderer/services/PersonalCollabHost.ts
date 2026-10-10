/**
 * Collaboration host for a workspace's Local section (formerly Personal pages).
 *
 * Same seam as `ElectronCollabHost` so `CollabSidebar` and the docs session
 * run unchanged, but nothing here touches an account: the scope is fixed and
 * local, there is no team JWT and no member directory. A page is a markdown
 * file in the project's wiki folder and opens as an ordinary file tab, with
 * the regular editor, file watcher and local history. A database Personal
 * page the user has not exported yet still opens as a `personal://` tab.
 */

import {
  createPersonalCollabScope,
  type CollabArtifactRef,
  type CollabDocsCapability,
  type CollabDocsTreeState,
  type CollabDocsViewPreferences,
  type CollabDocumentTypeDescriptor,
  type CollabHost,
  type CollabOpenOptions,
  type CollabOpenSource,
  type CollabScope,
  type TeamMemberSummary,
} from '@nimbalyst/collab-client/core';
import {
  getSharedDocumentDisplayName,
  getSharedDocumentsForScopeKey,
  type CollabDocsCommand,
  type CollabDocsCommandResult,
  type SharedDocument,
  type SharedFolder,
} from '@nimbalyst/collab-client/docs';
import { store } from '@nimbalyst/runtime/store';
import { TYPE_PAGE_DOCUMENT_PREFIX } from '@nimbalyst/collab-client/docs';
import { PERSONAL_PAGE_TAB_PREFIX } from '../contexts/TabsContext';
import { historyDialogFileAtom } from '../store/atoms/historyDialog';
import { personalPageHistoryKey, personalTypedPageHistoryKey } from '../../shared/personalPageUri';
import { electronCollabDocumentAdapters } from './ElectronCollabHost';
import { errorNotificationService } from './ErrorNotificationService';
import { PersonalPagesDataSource } from './PersonalPagesDataSource';
import { localWikiEditorTypes, personalPageSupportsType } from './personalPageTypes';

type PersonalDocsCapability = CollabDocsCapability<
  SharedDocument,
  SharedFolder,
  CollabDocsCommand,
  CollabDocsCommandResult
>;

/** What a Local artifact opens as: a page's file, a database page tab, or an item/type page. */
export type PersonalOpenTarget =
  | { kind: 'local-file'; documentId: string; path: string; title: string }
  | { kind: 'personal-page'; documentId: string; path: string; title: string }
  | Extract<CollabArtifactRef, { kind: 'tracker' } | { kind: 'type' }>;

export type PersonalOpenAdapter = (target: PersonalOpenTarget, source: CollabOpenSource, options?: CollabOpenOptions) => void;

/** Tab path of a personal page. */
export function personalPageTabPath(documentId: string): string {
  return `${PERSONAL_PAGE_TAB_PREFIX}${documentId}`;
}

interface PersonalPagesWorkspaceState {
  personalPagesDiscovery?: Partial<CollabDocsViewPreferences>;
  personalPagesTree?: Partial<CollabDocsTreeState>;
}

/**
 * A Local page is a markdown file or an editor file with a sidecar, so every
 * type but code is offered.
 */
// The sidebar reads this through `useSyncExternalStore`, which treats a new
// array identity as a changed snapshot on every render. Cache per source list
// so the identity only changes when the catalog does.
let personalTypesSource: readonly CollabDocumentTypeDescriptor[] | null = null;
let personalTypesCached: readonly CollabDocumentTypeDescriptor[] = [];
let sentEditorTypes = '{}';
function personalDocumentTypes(): readonly CollabDocumentTypeDescriptor[] {
  const source = electronCollabDocumentAdapters.documentTypes();
  if (source !== personalTypesSource) {
    personalTypesSource = source;
    personalTypesCached = source.filter((descriptor) => personalPageSupportsType(descriptor.documentType));
    sendEditorTypes(source);
  }
  return personalTypesCached;
}

/**
 * Main reads the wiki folder with the library's built-in editor suffixes; the
 * catalog knows the installed extensions' ones too. Sent when the catalog
 * changes, so a dropped-in file of any shareable type shows as a page.
 */
function sendEditorTypes(descriptors: readonly CollabDocumentTypeDescriptor[]): void {
  const table = localWikiEditorTypes(descriptors);
  const key = JSON.stringify(Object.entries(table).sort());
  if (key === sentEditorTypes || Object.keys(table).length === 0) return;
  sentEditorTypes = key;
  void window.electronAPI?.invoke?.('local-wiki:set-editor-types', table)?.catch((error: unknown) => {
    sentEditorTypes = '{}';
    console.warn('[PersonalCollabHost] Could not send the editor types to main:', error);
  });
}

async function readWorkspaceState(workspacePath: string): Promise<PersonalPagesWorkspaceState | null> {
  return (await window.electronAPI?.invoke?.('workspace:get-state', workspacePath)) ?? null;
}

export class PersonalCollabHost implements CollabHost<PersonalDocsCapability> {
  readonly surface = 'desktop' as const;
  readonly scope: CollabScope;
  readonly personalState = { status: 'unavailable' as const };
  readonly documents: PersonalDocsCapability;
  private openAdapter: PersonalOpenAdapter | null = null;
  private currentSource: PersonalPagesDataSource | null = null;

  constructor(readonly workspacePath: string) {
    this.scope = createPersonalCollabScope(workspacePath);
    this.documents = {
      dataSource: this.createDataSource(),
      // Kept beside the team's settings in the same workspace state, under
      // their own keys, so the two sections never overwrite each other.
      loadViewPreferences: async () => {
        const discovery = (await readWorkspaceState(workspacePath))?.personalPagesDiscovery;
        return {
          treeFilter: 'all',
          showUnreadBubbles: discovery?.showUnreadBubbles !== false,
        };
      },
      saveViewPreferences: async (_scopeKey, preferences) => {
        await window.electronAPI?.invoke?.('workspace:update-state', workspacePath, {
          personalPagesDiscovery: preferences,
        });
      },
      loadTreeState: async () => {
        const tree = (await readWorkspaceState(workspacePath))?.personalPagesTree;
        return {
          expandedFolders: Array.isArray(tree?.expandedFolders) ? tree.expandedFolders : [],
          userTouched: tree?.userTouched === true,
        };
      },
      saveTreeState: async (_scopeKey, treeState) => {
        await window.electronAPI?.invoke?.('workspace:update-state', workspacePath, {
          personalPagesTree: treeState,
        });
      },
      documentTypes: personalDocumentTypes,
      onDocumentTypesChanged: electronCollabDocumentAdapters.onDocumentTypesChanged,
      // The creation pipeline branches on the personal scope: it registers
      // the page locally and never seeds a room.
      createDocument: electronCollabDocumentAdapters.createDocument,
      readReceipts: { status: 'unavailable' },
    };
  }

  /**
   * The host outlives any one docs session, but a session disposes its source
   * on unmount and a disposed `PersonalPagesDataSource` never watches again.
   * Each dispose drops the instance so the next session gets a fresh one.
   */
  private createDataSource(): PersonalDocsCapability['dataSource'] {
    return {
      snapshot: () => this.source().snapshot(),
      subscribe: (cb) => this.source().subscribe(cb),
      command: (command) => this.source().command(command),
      status: () => 'connected',
      dispose: () => {
        this.currentSource?.dispose();
        this.currentSource = null;
      },
    };
  }

  /** The live data source; a new one after the last session disposed it. */
  source(): PersonalPagesDataSource {
    return (this.currentSource ??= new PersonalPagesDataSource(this.workspacePath));
  }

  async resolveScope(): Promise<CollabScope> {
    return this.scope;
  }

  onScopeChanged(): () => void {
    return () => undefined;
  }

  async getTeamJwt(): Promise<never> {
    throw new Error('Personal pages have no team');
  }

  async getMembers(): Promise<TeamMemberSummary[]> {
    return [];
  }

  openArtifact(ref: CollabArtifactRef, source: CollabOpenSource, options?: CollabOpenOptions): void {
    if (!this.openAdapter) {
      throw new Error('Personal pages were opened without a navigation adapter');
    }
    if (ref.kind === 'tracker' || ref.kind === 'type') {
      this.openAdapter(ref, source, options);
    } else if (ref.kind === 'document') {
      if (this.source().isLegacyDocument(ref.documentId)) {
        this.openAdapter({
          kind: 'personal-page',
          documentId: ref.documentId,
          path: personalPageTabPath(ref.documentId),
          title: this.documentTitle(ref.documentId),
        }, source, options);
      } else {
        this.openLocalFile(ref.documentId, source, options);
        return;
      }
    } else {
      return;
    }
    // Personal pages keep local history: a page's body, a typed page's body,
    // or a type page's prose (a Personal page of its own).
    if (source !== 'history') return;
    store.set(historyDialogFileAtom, ref.kind === 'tracker'
      ? personalTypedPageHistoryKey(ref.trackerId)
      : personalPageHistoryKey(ref.kind === 'type' ? `${TYPE_PAGE_DOCUMENT_PREFIX}${ref.typeId}` : ref.documentId));
  }

  /** Opens a wiki page's markdown file; history is the file's own local history. */
  private openLocalFile(documentId: string, source: CollabOpenSource, options?: CollabOpenOptions): void {
    const adapter = this.openAdapter;
    void this.source().pageFilePath(documentId).then((path) => {
      if (!path) throw new Error(`Page ${documentId} is not in the Local wiki`);
      adapter?.({ kind: 'local-file', documentId, path, title: this.documentTitle(documentId) }, source, options);
      if (source === 'history') store.set(historyDialogFileAtom, path);
    }).catch((error) => this.reportError(error, 'Failed to open the Local page'));
  }

  artifactUrl(): string | null {
    // A personal page is on this device only; there is nothing to link to.
    return null;
  }

  setOpenArtifactAdapter(adapter: PersonalOpenAdapter): () => void {
    this.openAdapter = adapter;
    return () => {
      if (this.openAdapter === adapter) this.openAdapter = null;
    };
  }

  reportError(error: unknown, context: string): void {
    const resolved = error instanceof Error ? error : new Error(String(error));
    errorNotificationService.showFromError(resolved, context);
  }

  notify(notification: {
    level: 'info' | 'warning' | 'error';
    title: string;
    message: string;
    duration?: number;
  }): void {
    const options = notification.duration ? { duration: notification.duration } : undefined;
    if (notification.level === 'info') {
      errorNotificationService.showInfo(notification.title, notification.message, options);
    } else if (notification.level === 'warning') {
      errorNotificationService.showWarning(notification.title, notification.message, options);
    } else {
      errorNotificationService.showError(notification.title, notification.message);
    }
  }

  /** Tab title of a personal page: its leaf name, without the folder path. */
  documentTitle(documentId: string): string {
    const document = getSharedDocumentsForScopeKey(this.scope.scopeKey)
      .find((candidate) => candidate.documentId === documentId);
    return getSharedDocumentDisplayName(document?.title ?? '', documentId);
  }
}
