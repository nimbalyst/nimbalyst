/**
 * The collaboration host for `nim wiki serve`: the desktop's Local section
 * host (`PersonalCollabHost`) without IPC. The scope is fixed and local, there
 * is no team JWT and no member directory, and an open is a route change in
 * this tab. View preferences and tree expansion live in this tab's memory;
 * the wiki folder is the only state that persists.
 */
import {
  getCollabDocsSession,
  getSharedDocumentDisplayName,
  getSharedDocumentsForScopeKey,
  type CollabDocsDataSource,
  type createCollabDocsScopeLifecycle,
} from '@nimbalyst/collab-bundle/docs-ui';
import { builtInManifests, editorForFile, editorPageDescriptors } from '../editors/wikiEditors';
import { ulidLike } from './ids';
import type { PageLinkSource } from '@nimbalyst/collab-bundle/editor';
import { wikiApi } from '../api/client';
import { isStaticSite, staticRoutePath } from '../api/staticSite';
import { resolveWikiLink, type LinkTarget } from './links';
import { pageLinkOption, pageLinkOptions } from './pageLinks';
import { LocalPagesDataSource } from './LocalPagesDataSource';

type DocsHost = Parameters<typeof createCollabDocsScopeLifecycle>[0];
type Documents = NonNullable<DocsHost['documents']>;
type CollabScope = Awaited<ReturnType<DocsHost['resolveScope']>>;
type ArtifactRef = Parameters<DocsHost['openArtifact']>[0];
type OpenOptions = Parameters<DocsHost['openArtifact']>[2];
type DocumentTypeDescriptor = ReturnType<Documents['documentTypes']>[number];
type ViewPreferences = NonNullable<Awaited<ReturnType<Documents['loadViewPreferences']>>>;
type TreeState = NonNullable<Awaited<ReturnType<NonNullable<Documents['loadTreeState']>>>>;

/** The scope `createPersonalCollabScope` builds: org `local`, no server. */
function localScope(root: string): CollabScope {
  return {
    scopeKey: `personal:${root}`,
    orgId: 'local',
    indexConfig: { serverUrl: '', teamMemberId: 'local', teamProjectId: null },
  } as unknown as CollabScope;
}

const MARKDOWN_TYPE: DocumentTypeDescriptor = {
    documentType: 'markdown',
    displayName: 'Page',
    fileExtensions: ['.md'],
    defaultExtension: '.md',
    icon: 'description',
    editor: { kind: 'lexical' as const },
    content: { strategy: 'lexical' as const, codecId: 'markdown' },
    creation: { defaultContent: '', source: 'builtin' as const },
    capabilities: { localCreate: true, shareToTeam: false, sharedCreate: true, history: false, export: false },
};

let documentTypes: readonly DocumentTypeDescriptor[] | null = null;

/**
 * Markdown pages, then a page per built-in editor (drawing, mind map...). The
 * manifests are fixed at build time, so the list is built once: the sidebar
 * needs a stable identity.
 */
function wikiDocumentTypes(): readonly DocumentTypeDescriptor[] {
  return (documentTypes ??= Object.freeze([MARKDOWN_TYPE, ...editorPageDescriptors(builtInManifests())]));
}

export type WikiRoute =
  | { kind: 'home' }
  | { kind: 'page'; id: string }
  | { kind: 'item'; id: string }
  | { kind: 'type'; typeId: string };

export function routePath(route: WikiRoute): string {
  if (isStaticSite()) return staticRoutePath(route);
  switch (route.kind) {
    case 'home':
      return '/';
    case 'page':
      return `/page/${encodeURIComponent(route.id)}`;
    case 'item':
      return `/item/${encodeURIComponent(route.id)}`;
    case 'type':
      return `/type/${encodeURIComponent(route.typeId)}`;
  }
}

export class LocalCollabHost implements DocsHost {
  // `web_console` makes rows real links (`artifactUrl`), so a middle click opens a tab.
  readonly surface = 'web_console' as const;
  readonly scope: CollabScope;
  readonly personalState = { status: 'unavailable' as const };
  readonly documents: Documents;
  private currentSource: LocalPagesDataSource | null = null;
  private viewPreferences: ViewPreferences = { treeFilter: 'all', showUnreadBubbles: false };
  private treeState: TreeState | null = null;

  /** A relative link in page `fromId`'s body, resolved to a page in the wiki or a file outside it. */
  resolveLink(fromId: string, href: string): LinkTarget {
    return resolveWikiLink(this.currentSource?.allPages() ?? [], this.pagePath(fromId), href);
  }

  /**
   * The `@` picker's pages for page `fromId`. A page created from it goes next
   * to the linking page, as a sibling, and is linked once it exists on disk.
   */
  pageLinkSource(fromId: string): PageLinkSource {
    return {
      list: () => pageLinkOptions(this.currentSource?.allPages() ?? [], fromId),
      createPage: async (title) => {
        const from = this.currentSource?.page(fromId) ?? null;
        const { id } = await wikiApi.command({
          type: 'register-document',
          title,
          parentFolderId: from?.parentId ?? null,
          ...(from?.parentKind ? { parentKind: from.parentKind } : {}),
        });
        const created = (await wikiApi.snapshot()).pages.find((page) => page.id === id);
        if (!created) throw new Error(`The page "${title}" was not created`);
        return pageLinkOption(from, created);
      },
      onError: (error) => this.onError(`Could not create the page: ${error instanceof Error ? error.message : String(error)}`),
    };
  }

  /** Wiki-relative file of a page, from the last snapshot read. */
  pagePath(id: string): string | null {
    return this.currentSource?.page(id)?.path ?? null;
  }

  constructor(
    readonly root: string,
    private readonly navigate: (route: WikiRoute, options?: OpenOptions) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.scope = localScope(root);
    const dataSource: CollabDocsDataSource = {
      snapshot: () => this.source().snapshot(),
      subscribe: (cb) => this.source().subscribe(cb),
      command: (command) => this.source().command(command),
      searchPages: (request) => this.source().searchPages(request),
      status: () => 'connected',
      // A session disposes its source; the next session gets a fresh one.
      dispose: () => {
        this.currentSource?.dispose();
        this.currentSource = null;
      },
    };
    this.documents = {
      dataSource: dataSource as unknown as Documents['dataSource'],
      loadViewPreferences: async () => this.viewPreferences,
      saveViewPreferences: async (_scopeKey, preferences) => {
        this.viewPreferences = preferences;
      },
      loadTreeState: async () => this.treeState,
      saveTreeState: async (_scopeKey, state) => {
        this.treeState = state;
      },
      documentTypes: wikiDocumentTypes,
      createDocument: async (input) => {
        const session = getCollabDocsSession(input.scope.scopeKey);
        if (!session) throw new Error('The page tree is not ready yet');
        const documentId = ulidLike();
        const { descriptor } = input;
        const markdown = descriptor.documentType === 'markdown';
        const extension = descriptor.defaultExtension;
        // The tree shows an editor page with its suffix; the wiki stores the stem.
        let title = input.requestedName.trim() || 'Untitled';
        if (!markdown && title.toLowerCase().endsWith(extension) && title.length > extension.length) title = title.slice(0, -extension.length);
        if (!markdown) {
          const body = input.sourceContent;
          this.source().stageBody(documentId, typeof body === 'string' ? body : new TextDecoder().decode(body));
        }
        await session.registerDocument({
          documentId,
          title,
          documentType: descriptor.documentType,
          parentFolderId: input.parentFolderId,
          ...(input.parentKind ? { parentKind: input.parentKind } : {}),
          metadata: {
            metadataVersion: 2,
            fileExtension: markdown ? '.md' : extension,
            editorId: markdown ? 'builtin.lexical' : descriptor.editor.extensionId ?? descriptor.documentType,
          },
        });
        this.navigate({ kind: 'page', id: documentId });
      },
      readReceipts: { status: 'unavailable' },
    } as Documents;
  }

  source(): LocalPagesDataSource {
    return (this.currentSource ??= new LocalPagesDataSource((fileExtension) => editorForFile(fileExtension)?.extensionId));
  }

  async resolveScope(): Promise<CollabScope> {
    return this.scope;
  }

  onScopeChanged(): () => void {
    return () => undefined;
  }

  async getTeamJwt(): Promise<never> {
    throw new Error('A local wiki has no team');
  }

  async getMembers(): Promise<[]> {
    return [];
  }

  private route(ref: ArtifactRef): WikiRoute | null {
    switch (ref.kind) {
      case 'document':
        return { kind: 'page', id: ref.documentId };
      case 'folder':
        return { kind: 'page', id: ref.folderId };
      case 'tracker':
        return { kind: 'item', id: ref.trackerId };
      case 'type':
        return { kind: 'type', typeId: ref.typeId };
      default:
        return null;
    }
  }

  openArtifact(ref: ArtifactRef, source: Parameters<DocsHost['openArtifact']>[1], options?: OpenOptions): void {
    // History needs the Y.Doc revision log a file does not have.
    if (source === 'history') {
      this.onError('Page history is not available in the local wiki view. The wiki is a folder of files; use git or your editor for history.');
      return;
    }
    const route = this.route(ref);
    if (route) this.navigate(route, options);
  }

  artifactUrl(ref: ArtifactRef): string | null {
    const route = this.route(ref);
    return route ? routePath(route) : null;
  }

  reportError(error: unknown, context: string): void {
    console.error(`[wiki-web] ${context}`, error);
    this.onError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }

  notify(notification: { level: 'info' | 'warning' | 'error'; title: string; message: string }): void {
    if (notification.level === 'info') console.info(`[wiki-web] ${notification.title}: ${notification.message}`);
    else this.onError(`${notification.title}: ${notification.message}`);
  }

  /** Leaf name of a page, for the browser tab title. */
  documentTitle(documentId: string): string {
    const document = getSharedDocumentsForScopeKey(this.scope.scopeKey).find((candidate) => candidate.documentId === documentId);
    return getSharedDocumentDisplayName(document?.title ?? '', documentId);
  }
}
