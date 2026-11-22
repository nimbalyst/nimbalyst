/** Editor-neutral collaborative comment contracts exposed to extensions. */
export type TextQuoteCommentAnchor = {
    kind: 'text-quote';
    exact: string;
    prefix?: string;
    suffix?: string;
};
export type EntityCommentAnchor = {
    kind: 'entity';
    entityType: string;
    entityId: string;
    field?: string;
    labelSnapshot?: string;
};
export type CommentAnchor = TextQuoteCommentAnchor | EntityCommentAnchor;
export type CollaborativeUserCommentActor = {
    kind: 'user';
    userId?: string;
    displayName: string;
};
export type CollaborativeAgentCommentActor = {
    kind: 'agent';
    sessionId: string;
    sessionName: string;
    onBehalfOfUserId: string;
    onBehalfOfDisplayName?: string;
};
export type CollaborativeCommentActor = CollaborativeUserCommentActor | CollaborativeAgentCommentActor;
export interface CollaborativeComment {
    readonly actor?: CollaborativeCommentActor;
    readonly author: string;
    readonly clientMutationId?: string;
    readonly content: string;
    readonly deleted: boolean;
    readonly id: string;
    readonly replyToCommentId?: string;
    readonly timeStamp: number;
    readonly type: 'comment';
}
export interface CollaborativeCommentThread {
    readonly anchor?: CommentAnchor;
    readonly comments: ReadonlyArray<CollaborativeComment>;
    readonly id: string;
    readonly quote: string;
    readonly resolved: boolean;
    readonly type: 'thread';
}
/** The immutable canonical view of the document's top-level comments array. */
export type CollaborativeCommentsSnapshot = ReadonlyArray<CollaborativeComment | CollaborativeCommentThread>;
export interface CommentCapabilities {
    read: boolean;
    comment: boolean;
    /**
     * Whether the user may change the document body. Absent means true.
     * `editBody: false` means the server refuses any change outside the
     * comments array and ends the session on the first one. Extension editors
     * do not support that mode yet: hosts give such users a read-only editor
     * with `comment: false`, so an extension never receives `editBody: false`
     * together with `comment: true`.
     */
    editBody?: boolean;
}
export interface CommentMember {
    userId: string;
    name: string;
    email?: string | null;
    personalOrgId?: string | null;
}
export interface CreateCommentThreadInput {
    anchor: CommentAnchor;
    content: string;
    clientMutationId: string;
    mentionedUserIds?: string[];
}
export interface CreateCommentThreadResult {
    comment: CollaborativeComment;
    duplicate: boolean;
    thread: CollaborativeCommentThread;
}
export interface ReplyToCommentInput {
    threadId: string;
    content: string;
    clientMutationId: string;
    mentionedUserIds?: string[];
    replyToCommentId?: string;
}
export interface ReplyToCommentResult {
    comment: CollaborativeComment;
    duplicate: boolean;
    threadId: string;
}
export interface MountedCommentAnchorAdapter {
    handles(anchor: CommentAnchor): boolean;
    getState(anchor: CommentAnchor): 'attached' | 'orphaned';
    describe(anchor: CommentAnchor): string;
    focus(anchor: CommentAnchor): boolean | Promise<boolean>;
}
export interface CollaborationCommentsService {
    getSnapshot(): CollaborativeCommentsSnapshot;
    subscribe(listener: () => void): () => void;
    getCapabilities(): CommentCapabilities;
    getMentionableMembers(): CommentMember[];
    createThread(input: CreateCommentThreadInput): Promise<CreateCommentThreadResult>;
    reply(input: ReplyToCommentInput): Promise<ReplyToCommentResult>;
    setResolved(threadId: string, resolved: boolean): Promise<void>;
    focusThread(threadId: string): Promise<boolean>;
    openPanel(input?: {
        threadId?: string;
        anchor?: CommentAnchor;
    }): void;
    registerAnchorAdapter(adapter: MountedCommentAnchorAdapter): () => void;
}
