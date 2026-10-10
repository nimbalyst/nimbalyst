/**
 * Shared Docs shell and headless-session entry.
 *
 * This entry deliberately stays separate from `./editor`. The shell and the
 * session factory must stay together so their Jotai atoms and runtime store
 * are instantiated by one prebuilt module graph.
 */
export * from './internal/collab-client/src/docs/index';
export * from './internal/collab-client/src/docs-ui/index';
export { appendSyncClientParams, getSyncClientInfo, setSyncClientInfo, type SyncClientInfo, } from './internal/runtime/src/sync/syncClientInfo';
/**
 * Page history: the dialog, its revisions client and the restore path. Loaded
 * when someone opens a page's history; the diff it draws is in `./editor`.
 */
export declare const loadPageHistory: () => Promise<typeof import("./internal/collab-client/src/docs-ui/history/index")>;
export type { CollabHistoryController, CollabHistoryDialogProps, CollabHistoryDiffProps, } from './internal/collab-client/src/docs-ui/history/index';
/**
 * Set type: the sequence, its child moves, the type page's register step and
 * the picker dialog. Loaded when someone picks Set type, so the eager docs-ui
 * graph does not carry it.
 */
export declare const loadSetPageType: () => Promise<{
    SetPageTypeDialog({ pageTitle, resolver, running, onPick, onClose, onNewType }: import("./internal/collab-client/src/docs-ui/setPageType/index").SetPageTypeDialogProps): import("react").ReactPortal;
    NewTypeDialog({ lane, resolver, session, parent, defineType, onCreated, onClose }: import("./internal/collab-client/src/docs-ui/setPageType/index").NewTypeDialogProps): import("react").ReactPortal;
    setPageType(request: import("./internal/collab-client/src/docs/pageTypes/index").SetPageTypeRequest, dependencies: import("./internal/collab-client/src/docs/pageTypes/index").SetPageTypeDependencies): Promise<import("./internal/collab-client/src/docs/pageTypes/index").SetPageTypeOutcome>;
    READ_BACK_RETRY_DELAYS_MS: number[];
    listPageChildren(session: import("./internal/collab-client/src/docs/pageTypes/index").ChildMoveSession, typePlacements: import("./internal/collab-client/src/docs/index").SharedTypePlacement[], pageId: string): import("./internal/collab-client/src/docs/pageTypes/index").PageChild[];
    movePageChild(session: import("./internal/collab-client/src/docs/pageTypes/index").ChildMoveSession, typePlacements: import("./internal/collab-client/src/docs/index").SharedTypePlacement[], child: import("./internal/collab-client/src/docs/pageTypes/index").PageChild, itemId: string): Promise<import("./internal/collab-client/src/docs/pageTypes/index").ItemPlacementResult>;
    typePageDocumentId(typeId: string): string;
    ensureTypePageDocument(request: import("./internal/collab-client/src/docs/pageTypes/index").TypePageDocumentRequest, effects: import("./internal/collab-client/src/docs/pageTypes/index").TypePageDocumentEffects): Promise<import("./internal/collab-client/src/docs/index").SharedDocument>;
    browserPageTypeItemInput(request: import("./internal/collab-client/src/docs/pageTypes/index").BrowserPageTypeItemRequest): import("./internal/collab-client/src/trackers/index").TrackerCreateItemInput;
}>;
