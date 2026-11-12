/**
 * Public configuration types for the Lexical document-comments feature.
 *
 * The runtime editor is platform-agnostic, so everything it needs to power
 * comments (the shared Y.Doc, the current user, team members for @-mentions,
 * document metadata, and the notification callbacks) is supplied by the host
 * through `EditorConfig.comments`. The electron `CollaborativeTabEditor`
 * populates this from the DocumentSyncProvider + TeamSyncProvider.
 */
import type { Doc } from 'yjs';
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
export type UserCommentActor = {
    kind: 'user';
    userId?: string;
    displayName: string;
};
export type AgentCommentActor = {
    kind: 'agent';
    sessionId: string;
    sessionName: string;
    onBehalfOfUserId: string;
    onBehalfOfDisplayName?: string;
};
export type CommentActor = UserCommentActor | AgentCommentActor;
export type Comment = {
    actor?: CommentActor;
    author: string;
    clientMutationId?: string;
    content: string;
    deleted: boolean;
    id: string;
    replyToCommentId?: string;
    timeStamp: number;
    type: 'comment';
};
export type Thread = {
    comments: Array<Comment>;
    id: string;
    quote: string;
    anchor?: CommentAnchor;
    resolved: boolean;
    type: 'thread';
};
export type Comments = Array<Thread | Comment>;
/** A team member that can be @-mentioned in a comment. */
export interface CommentMember {
    userId: string;
    /** Display name shown in the mention picker. */
    name: string;
    /**
     * Address shown beneath the display name and also matched against while
     * typing. `name` collapses to the email only when a member has no display
     * name, so without this a roster of real names cannot be searched by the
     * address people actually know each other by.
     */
    email?: string | null;
    /** The member's personal org id, when the roster carries one. */
    personalOrgId?: string | null;
}
/**
 * Notification payload for a comment `@`-mention, handed to the host's
 * `onMention` callback. Declared here so the runtime editor's public config has
 * no protocol dependency.
 */
export interface CommentMentionPayload {
    /** Display name of the comment author. */
    actorName?: string;
    /** Title of the document the comment is on. */
    sourceTitle?: string;
    /** Short excerpt of the comment text. */
    snippet?: string;
    /** Id of the comment that triggered the notification. */
    commentId?: string;
    /** Comment thread id. */
    threadId?: string;
    /** MarkNode id anchoring the comment in the document. */
    markId?: string;
    /** Deep-link target (e.g. `collab://org:..:doc:..`). */
    url?: string;
}
export interface CommentCapabilities {
    read: boolean;
    comment: boolean;
    /**
     * Whether this user may change the document body (the Lexical `root` in the
     * shared Y.Doc). Absent means true, so hosts that predate the field keep
     * their behavior. `false` with `comment: true` is commenter mode: the editor
     * is read-only, new threads carry only a `text-quote` anchor (no MarkNode),
     * and the client writes nothing to `root`. The server refuses any commenter
     * update that changes anything but the `comments` array.
     */
    editBody?: boolean;
}
export interface CommentReplyPayload extends CommentMentionPayload {
    commentId: string;
    clientMutationId: string;
    replyToCommentId?: string;
}
/** Host-supplied configuration enabling document comments in the editor. */
export interface CommentsConfig {
    /**
     * Returns the shared Y.Doc the comments live in (the same Y.Doc as the
     * document content; comments are stored under a top-level `comments`
     * YArray). Returns null until the collaboration provider is ready.
     */
    getYDoc: () => Doc | null;
    /** The signed-in user, used as the comment author and mention actor. */
    currentUser: {
        id: string;
        name: string;
    };
    /**
     * Current effective source capabilities. Read at operation time so an access
     * change takes effect without remounting the editor.
     */
    getCapabilities?: () => CommentCapabilities;
    /** True once the collaborative document has hydrated enough for mutations. */
    isHydrated?: () => boolean;
    /** Team members available to @-mention. Read lazily so the roster stays fresh. */
    getMembers: () => CommentMember[];
    /** Title of the document (used in notification payloads). */
    documentTitle: string;
    /** Document id within the source org. */
    documentId: string;
    /** `collab://` deep-link URI for the document. */
    documentUri: string;
    /**
     * Called when a submitted comment `@`-mentions one or more members.
     * `recipientUserIds` excludes the author. The host owns delivery (the
     * electron hosts route it to the org-scoped TeamInboxRoom); failures do not
     * roll back the Y.Doc mutation. No-op safe when undefined.
     */
    onMention?: (recipientUserIds: string[], payload: CommentMentionPayload) => void;
    /**
     * Called after a canonical reply is appended. The host owns delivery;
     * failures do not roll back the Y.Doc mutation.
     */
    onReply?: (recipientUserIds: string[], payload: CommentReplyPayload) => void;
}
