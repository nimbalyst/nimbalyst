/**
 * CommentsPlugin
 *
 * Text-selection comments for collaborative Lexical documents. The floating
 * text toolbar contributes an "Add comment" action; selecting it opens the
 * comments panel with an `@`-mention composer. Comments anchor to the text via
 * `@lexical/mark` `MarkNode`s and persist in the document's shared Y.Doc
 * (top-level `comments` YArray) through the orphaned-upstream `CommentStore`.
 *
 * What is left here is only the Lexical half: mark tracking, selection, mark
 * highlighting, re-anchoring, and the store wiring. Everything that draws a
 * thread, a comment, or the composer is the shared editor-neutral UI in
 * `commenting/ui`, which extension editors mount over their own entities.
 * This file is the Markdown *adapter* for those primitives — it translates
 * MarkNode presence into an anchor state and a selection into a thread.
 *
 * The MarkNode + `INSERT_INLINE_COMMENT_COMMAND` live in `CommentsExtension`.
 *
 * Commenter mode (`comment: true, editBody: false`) writes nothing to the
 * Lexical `root`: the editor is read-only, every Lexical-to-Yjs sync is
 * skipped (`registerBodyWriteGuard`), new threads carry only a text-quote
 * anchor, and re-anchoring and mark removal are off. Threads without a
 * MarkNode are highlighted for every viewer by decoration
 * (`quoteHighlightPainter`) wherever their quote occurs exactly once.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $isMarkNode,
  $unwrapMarkNode,
  $getMarkIDs,
  MarkNode,
} from '@lexical/mark';
import { mergeRegister } from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  type NodeKey,
} from 'lexical';

import {
  CommentStore,
  createComment,
  createThread,
  useCommentStore,
  type Comment,
  type CommentActor,
  type Thread,
} from '../../commenting';
import {
  collabCommentControllerRegistry,
  createCollabCommentController,
} from '../../commenting/CollabCommentControllerRegistry';
import { CommentCollabProvider } from '../../commenting/CommentCollabProvider';
import { registerBodyWriteGuard } from '../../commenting/bodyWriteGuard';
import {
  canAuthorComments,
  canDeleteCommentThread,
  canDeleteThreadComment,
  canEditBody,
  canEditCommentedBody,
  canManageCommentThread,
  isCommentOnly,
  resolveCommentCapabilities,
} from '../../commenting/capabilities';
import {
  assertCommentMutationAllowed,
  validateCommentBody,
  validateCommentMentions,
  validateTextQuoteSelector,
} from '../../commenting/commentValidation';
import {
  $quoteAnchorFromSelection,
  resolveQuoteHighlights,
} from '../../commenting/quoteAnchors';
import { reanchorOrphanedThreads } from '../../commenting/reanchorOrphanedThreads';
import type { ResolvedCommentAnchor } from '../../commenting/CollabCommentControllerRegistry';
import type {
  CommentsConfig,
  CommentMentionPayload,
} from '../../commenting/types';
import {
  CollaborativeCommentsPanel,
  CommentCountBadge,
  type CommentThreadView,
} from '../../commenting/ui';
import { INSERT_INLINE_COMMENT_COMMAND } from '../../extensions/builtin/CommentsExtension';
import { OPEN_COMMENT_COMPOSER_COMMAND } from './commands';
import {
  QUOTE_HIGHLIGHT,
  QUOTE_HIGHLIGHT_RESOLVED,
  QUOTE_HIGHLIGHT_SELECTED,
  QuoteHighlightPainter,
  createQuoteDomRange,
  hitTestQuoteRanges,
  type QuoteHighlightName,
} from './quoteHighlightPainter';
import { scrollToCommentAnchor } from './scrollToCommentAnchor';

import './CommentPlugin.css';

type MarkNodeMap = Map<string, Set<NodeKey>>;

/** Coalesce the mark mutations a document rebuild fires before healing. */
const REANCHOR_DEBOUNCE_MS = 250;

/** Coalesce text edits before re-resolving quote-anchored highlights. */
const QUOTE_REFRESH_DEBOUNCE_MS = 120;

/**
 * How long a MarkNode must have no thread before an editor-capable client
 * removes it. A remote thread's mark and its `comments` entry are separate
 * writes and can arrive apart; one sweep alone would unwrap a mark whose
 * thread is still on its way.
 */
export const ORPHAN_MARK_GRACE_MS = 2000;

const NO_ORPHANS: ReadonlySet<string> = new Set();

export { OPEN_COMMENT_COMPOSER_COMMAND } from './commands';

function createClientMutationId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function allowsMountedCommentMutation(config: CommentsConfig): boolean {
  try {
    assertCommentMutationAllowed(
      resolveCommentCapabilities(config),
      config.isHydrated?.() ?? config.getYDoc() !== null,
    );
    return true;
  } catch {
    return false;
  }
}

export default function CommentsPlugin({
  config,
  anchorElem,
}: {
  config: CommentsConfig;
  anchorElem: HTMLElement;
}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  // The comments toggle + side panel dock to the right of the editor pane
  // (the `.editor-container`, the anchor's positioned parent) rather than
  // portaling to <body>. This keeps them inside the tab DOM so they hide with
  // the tab when another document/mode is shown, instead of floating globally.
  const paneElem = anchorElem.parentElement ?? anchorElem;
  const commentStore = useMemo(() => new CommentStore(editor), [editor]);
  const comments = useCommentStore(commentStore);
  const markNodeMapRef = useRef<MarkNodeMap>(new Map());
  const controllerInstanceIdRef = useRef(
    `comments-${Math.random().toString(36).slice(2, 12)}`,
  );
  const [markVersion, setMarkVersion] = useState(0);
  // Threads whose quoted text is gone for good: no MarkNode, and the healing
  // pass below could not find the quote either. Derived from a completed pass
  // rather than from "no mark right now", because a document rebuild drops
  // every mark for a beat and every thread would flash as detached.
  const [orphanedThreadIds, setOrphanedThreadIds] =
    useState<ReadonlySet<string>>(NO_ORPHANS);

  const [panelOpen, setPanelOpen] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // A commenter's new thread before its first comment is submitted. It lives
  // only here: the server owns a commenter's thread by its first comment, so
  // an empty thread written to the room is refused (terminally), and so is
  // deleting one. Submit writes the thread with that comment in one
  // transaction; cancel just drops the draft.
  const [draftThread, setDraftThread] = useState<Thread | null>(null);

  const threads = useMemo(() => {
    const stored = comments.filter((c): c is Thread => c.type === 'thread');
    if (!draftThread || stored.some((thread) => thread.id === draftThread.id)) {
      return stored;
    }
    return [...stored, draftThread];
  }, [comments, draftThread]);
  // Read by the editor update listener, which is registered once.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  // Read on every render and deliberately not memoized on `config`: hosts keep
  // the same config object across an access change, so a memo keyed on its
  // identity would leave the gate showing stale affordances after revocation.
  const capabilities = resolveCommentCapabilities(config);
  const bodyLocked = !canEditBody(capabilities);
  const bodyAccessConfigRef = useRef(config);
  bodyAccessConfigRef.current = config;

  // -- Commenter mode: no write may reach the body ---------------------------
  useEffect(() => {
    if (!bodyLocked) return;
    // Desktop replaces the config on access changes. Keep the guard installed
    // across locked configs, and let cleanup see the promoted capabilities so
    // it restores the editability this guard disabled.
    return registerBodyWriteGuard(editor, () => !canEditCommentedBody(bodyAccessConfigRef.current));
  }, [editor, bodyLocked]);

  // -- Attach the CommentStore to the shared document Y.Doc ------------------
  useEffect(() => {
    const doc = config.getYDoc();
    if (!doc) return;
    const provider = new CommentCollabProvider(doc);
    const unregister = commentStore.registerCollaboration(provider);
    return () => {
      unregister();
    };
  }, [commentStore, config]);

  // -- Expose the mounted collaborative comment surface to renderer IPC -----
  useEffect(() => {
    const controller = createCollabCommentController({
      commentStore,
      currentUser: config.currentUser,
      documentTitle: config.documentTitle,
      documentUri: config.documentUri,
      editor,
      getCapabilities: () => resolveCommentCapabilities(config),
      getMembers: config.getMembers,
      isHydrated: () => config.isHydrated?.() ?? config.getYDoc() !== null,
      isVisible: () => {
        const root = editor.getRootElement();
        return Boolean(root?.isConnected && root.getClientRects().length > 0);
      },
      onCommitted: ({
        actor,
        comment,
        mentionedUserIds,
        replyRecipientUserIds,
        thread,
      }) => {
        const actorName =
          actor.kind === 'agent' ? actor.sessionName : actor.displayName;
        const mentionRecipients = mentionedUserIds.filter(
          (id) => id !== config.currentUser.id,
        );
        const payload: CommentMentionPayload = {
          actorName,
          sourceTitle: config.documentTitle,
          snippet: comment.content.slice(0, 200),
          commentId: comment.id,
          threadId: thread.id,
          markId: thread.id,
          url: config.documentUri,
        };
        if (mentionRecipients.length > 0) {
          config.onMention?.(mentionRecipients, payload);
        }
        const replyRecipients = replyRecipientUserIds.filter(
          (id) =>
            id !== config.currentUser.id && !mentionRecipients.includes(id),
        );
        if (replyRecipients.length > 0 && comment.clientMutationId) {
          config.onReply?.(replyRecipients, {
            ...payload,
            commentId: comment.id,
            clientMutationId: comment.clientMutationId,
            replyToCommentId: comment.replyToCommentId,
          });
        }
      },
    });
    return collabCommentControllerRegistry.register(
      config.documentUri,
      controllerInstanceIdRef.current,
      controller,
    );
  }, [commentStore, config, editor]);

  // -- Track MarkNode keys per comment id ------------------------------------
  useEffect(() => {
    const markMap = markNodeMapRef.current;
    return editor.registerMutationListener(
      MarkNode,
      (mutations) => {
        editor.getEditorState().read(() => {
          for (const [key, mutation] of mutations) {
            if (mutation === 'destroyed') {
              for (const [id, keys] of markMap) {
                keys.delete(key);
                if (keys.size === 0) markMap.delete(id);
              }
              continue;
            }
            const node = $getNodeByKey(key);
            if ($isMarkNode(node)) {
              for (const id of node.getIDs()) {
                let keys = markMap.get(id);
                if (!keys) {
                  keys = new Set();
                  markMap.set(id, keys);
                }
                keys.add(key);
              }
            }
          }
        });
        setMarkVersion((v) => v + 1);
      },
      { skipInitialization: false },
    );
  }, [editor]);

  // -- Quote-anchored threads (no MarkNode) ----------------------------------
  const quoteAnchorsRef = useRef<Map<string, ResolvedCommentAnchor>>(new Map());
  const quoteDomRangesRef = useRef<Map<string, Range>>(new Map());
  const quotePainterRef = useRef(new QuoteHighlightPainter());
  const removeRootClickRef = useRef<(() => void) | null>(null);

  const repaintQuoteHighlights = useCallback(() => {
    const resolvedIds = new Set(
      threadsRef.current.filter((t) => t.resolved).map((t) => t.id),
    );
    const domRanges = new Map<string, Range>();
    const entries: Array<{ name: QuoteHighlightName; range: Range }> = [];
    for (const [threadId, anchor] of quoteAnchorsRef.current) {
      const range = createQuoteDomRange(editor, anchor);
      if (!range) continue;
      domRanges.set(threadId, range);
      entries.push({
        name:
          threadId === activeThreadIdRef.current
            ? QUOTE_HIGHLIGHT_SELECTED
            : resolvedIds.has(threadId)
            ? QUOTE_HIGHLIGHT_RESOLVED
            : QUOTE_HIGHLIGHT,
        range,
      });
    }
    quoteDomRangesRef.current = domRanges;
    quotePainterRef.current.paint(entries);
  }, [editor]);

  /**
   * Re-resolve every thread that has no MarkNode against the current text:
   * found exactly once is drawn as a decoration, otherwise it is orphaned. A
   * MarkNode thread is attached. Waits for hydration, since a partially synced
   * document would report threads orphaned that are not.
   */
  const refreshQuoteAnchors = useCallback(() => {
    if (!(config.isHydrated?.() ?? config.getYDoc() !== null)) return;
    const { ranges, unanchored } = resolveQuoteHighlights(
      editor,
      threadsRef.current,
    );
    quoteAnchorsRef.current = ranges;
    repaintQuoteHighlights();
    setOrphanedThreadIds((previous) =>
      sameIds(previous, unanchored) ? previous : unanchored,
    );
  }, [editor, config, repaintQuoteHighlights]);

  // -- Re-attach orphaned thread anchors -------------------------------------
  // Rebuilding the document from markdown -- the path agent edits take through
  // applyCollabDocEdit -- drops every MarkNode while leaving the threads and
  // the quoted text intact, silently unhighlighting the whole document (#2644).
  // Heal by exact quote match once the doc is hydrated. This runs on every
  // client rather than a single elected writer: a concurrent heal can nest two
  // MarkNodes carrying the same id, which still renders and still unwraps
  // through the mutation-tracked key map.
  useEffect(() => {
    if (threads.length === 0) {
      setOrphanedThreadIds((previous) =>
        previous.size === 0 ? previous : NO_ORPHANS,
      );
      return;
    }
    // A partially-synced document would resolve quotes against incomplete text
    // and anchor them in the wrong place -- permanently, for everyone.
    if (!(config.isHydrated?.() ?? config.getYDoc() !== null)) return;

    const timer = setTimeout(() => {
      // Read-only viewers and commenters skip the write (a MarkNode is a
      // change to `root`) but still get an honest answer about which threads
      // no longer point at anything.
      if (canAuthorComments(config) && canEditCommentedBody(config)) {
        reanchorOrphanedThreads(editor, threads);
      }
      refreshQuoteAnchors();
    }, REANCHOR_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editor, threads, config, markVersion, refreshQuoteAnchors]);

  // Text edits (local or remote) move or remove quotes without touching any
  // MarkNode, so quote-anchored highlights are re-resolved after updates too.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const removeListener = editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          refreshQuoteAnchors();
        }, QUOTE_REFRESH_DEBOUNCE_MS);
      },
    );
    return () => {
      removeListener();
      if (timer) clearTimeout(timer);
    };
  }, [editor, refreshQuoteAnchors]);

  // -- Paint quote-anchored highlights; repaint on selection/resolve ---------
  useEffect(() => {
    repaintQuoteHighlights();
  }, [activeThreadId, threads, repaintQuoteHighlights]);

  useEffect(() => {
    const painter = quotePainterRef.current;
    return () => painter.clear();
  }, []);

  // A decoration has no DOM element of its own to click, so clicks inside the
  // editor are hit-tested against the painted ranges.
  useEffect(
    () =>
      editor.registerRootListener((rootElement) => {
        removeRootClickRef.current?.();
        removeRootClickRef.current = null;
        if (!rootElement) return;
        const onClick = (event: MouseEvent) => {
          const threadId = hitTestQuoteRanges(
            quoteDomRangesRef.current,
            event.clientX,
            event.clientY,
          );
          if (threadId) {
            setActiveThreadId(threadId);
            setPanelOpen(true);
          }
        };
        rootElement.addEventListener('click', onClick);
        removeRootClickRef.current = () =>
          rootElement.removeEventListener('click', onClick);
      }),
    [editor],
  );
  useEffect(() => () => removeRootClickRef.current?.(), []);

  // -- Track which thread the caret is inside (active mark) ------------------
  useEffect(() => {
    const update = () => {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        let ids: string[] | null = null;
        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();
          if ($isTextNode(anchorNode)) {
            ids = $getMarkIDs(anchorNode, selection.anchor.offset);
          }
        }
        if (ids && ids.length > 0) {
          setActiveThreadId(ids[ids.length - 1]);
          setPanelOpen(true);
        }
      });
    };
    return mergeRegister(editor.registerUpdateListener(update));
  }, [editor]);

  // -- Highlight the active thread's mark in the document --------------------
  useEffect(() => {
    const markMap = markNodeMapRef.current;
    for (const [id, keys] of markMap) {
      for (const key of keys) {
        const el = editor.getElementByKey(key);
        if (el) {
          el.classList.toggle('selected', id === activeThreadId);
        }
      }
    }
  }, [editor, activeThreadId, markVersion]);

  // -- Dim the marks of resolved threads in the document ---------------------
  useEffect(() => {
    const markMap = markNodeMapRef.current;
    const resolvedIds = new Set(
      threads.filter((t) => t.resolved).map((t) => t.id),
    );
    for (const [id, keys] of markMap) {
      for (const key of keys) {
        const el = editor.getElementByKey(key);
        if (el) {
          el.classList.toggle('resolved', resolvedIds.has(id));
        }
      }
    }
  }, [editor, threads, markVersion]);

  // -- Helpers ---------------------------------------------------------------
  const removeMark = useCallback(
    (id: string) => {
      // Unwrapping a mark is a write to `root`; a body-locked user leaves the
      // mark in place (harmless without its thread) rather than have the
      // server refuse the update.
      if (!canEditCommentedBody(config)) return;
      if (!markNodeMapRef.current.has(id)) return;
      editor.update(() => {
        const keys = markNodeMapRef.current.get(id);
        if (!keys) return;
        for (const key of Array.from(keys)) {
          const node = $getNodeByKey(key);
          if ($isMarkNode(node)) {
            node.deleteID(id);
            if (node.getIDs().length === 0) {
              $unwrapMarkNode(node);
            }
          }
        }
      });
    },
    [editor, config],
  );

  // -- Remove marks whose thread was deleted elsewhere -----------------------
  // Deleting a thread here unwraps its mark. Deleted on another client -- a
  // commenter, who never writes `root` -- the mark stays in the body with no
  // thread behind it and keeps highlighting. Clients that may edit the body
  // unwrap it the same way, once the thread has been gone for the grace
  // period; thread ids are read from the Y.Doc itself so a store that has not
  // caught up yet cannot make a live thread look deleted.
  const markMissingSinceRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!(config.isHydrated?.() ?? config.getYDoc() !== null)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sweep = () => {
      timer = null;
      if (!canAuthorComments(config) || !canEditCommentedBody(config)) return;
      const doc = config.getYDoc();
      if (!doc) return;
      const threadIds = new Set<string>();
      for (const entry of doc.getArray<unknown>('comments').toArray()) {
        const id = (entry as { get?: (key: string) => unknown })?.get?.('id');
        if (typeof id === 'string') threadIds.add(id);
      }
      const missingSince = markMissingSinceRef.current;
      const now = Date.now();
      let waiting = false;
      for (const id of Array.from(markNodeMapRef.current.keys())) {
        if (threadIds.has(id)) {
          missingSince.delete(id);
          continue;
        }
        const since = missingSince.get(id);
        if (since !== undefined && now - since >= ORPHAN_MARK_GRACE_MS) {
          missingSince.delete(id);
          removeMark(id);
          continue;
        }
        if (since === undefined) missingSince.set(id, now);
        waiting = true;
      }
      for (const id of Array.from(missingSince.keys())) {
        if (!markNodeMapRef.current.has(id)) missingSince.delete(id);
      }
      if (waiting) timer = setTimeout(sweep, ORPHAN_MARK_GRACE_MS);
    };
    timer = setTimeout(sweep, REANCHOR_DEBOUNCE_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [config, threads, markVersion, removeMark]);

  const scrollToThread = useCallback(
    (id: string) => {
      const thread = threads.find((candidate) => candidate.id === id);
      if (!thread) return;
      const quoteRange = quoteDomRangesRef.current.get(id);
      const quoteElement = quoteRange?.startContainer.parentElement;
      if (quoteElement) {
        quoteElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      scrollToCommentAnchor(
        editor,
        markNodeMapRef.current,
        thread.id,
        thread.quote,
      );
    },
    [editor, threads],
  );

  const fanoutMention = useCallback(
    (
      mentionedUserIds: string[],
      snippet: string,
      threadId: string,
      commentId: string,
      actor: CommentActor,
    ) => {
      if (!config.onMention || mentionedUserIds.length === 0) return;
      const recipients = mentionedUserIds.filter(
        (id) => id !== config.currentUser.id,
      );
      if (recipients.length === 0) return;
      const payload: CommentMentionPayload = {
        actorName:
          actor.kind === 'agent' ? actor.sessionName : actor.displayName,
        sourceTitle: config.documentTitle,
        snippet: snippet.slice(0, 200),
        commentId,
        threadId,
        markId: threadId,
        url: config.documentUri,
      };
      config.onMention(recipients, payload);
    },
    [config],
  );

  // -- Actions ---------------------------------------------------------------
  const handleAddComment = useCallback(() => {
    // Re-read rather than trusting the rendered affordance: access can be
    // revoked between the frame that drew the toolbar and this dispatch, and
    // `getCommentToolbarActions` is memoized on the config object's identity,
    // which does not change when the capability behind it flips.
    if (!allowsMountedCommentMutation(config)) return;
    if (isCommentOnly(config)) {
      // No MarkNode: the thread is found by its quote (with enough context to
      // be unique) and drawn as a decoration.
      const anchor = editor
        .getEditorState()
        .read(() => $quoteAnchorFromSelection());
      if (!anchor) return;
      const thread = createThread(anchor.exact, [], undefined, undefined, anchor);
      setDraftThread(thread);
      setPanelOpen(true);
      setActiveThreadId(thread.id);
      refreshQuoteAnchors();
      return;
    }
    let quote = '';
    let isBackward = false;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        quote = selection.getTextContent();
        isBackward = selection.isBackward();
      }
    });
    if (!quote.trim()) return;
    try {
      validateTextQuoteSelector({ exact: quote });
    } catch {
      return;
    }

    const thread = createThread(quote, [], undefined, undefined, {
      kind: 'text-quote',
      exact: quote,
    });
    commentStore.addComment(thread);
    editor.dispatchCommand(INSERT_INLINE_COMMENT_COMMAND, {
      id: thread.id,
      isBackward,
    });

    setPanelOpen(true);
    setActiveThreadId(thread.id);
  }, [editor, commentStore, config, refreshQuoteAnchors]);

  useEffect(
    () =>
      editor.registerCommand(
        OPEN_COMMENT_COMPOSER_COMMAND,
        () => {
          handleAddComment();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, handleAddComment],
  );

  const handleReply = useCallback(
    (thread: Thread, text: string, mentionedUserIds: string[]) => {
      if (!allowsMountedCommentMutation(config)) return;
      let body: string;
      let mentions: string[];
      try {
        body = validateCommentBody(text);
        mentions = validateCommentMentions(
          mentionedUserIds,
          config.getMembers(),
        );
      } catch {
        return;
      }
      const actor: CommentActor = {
        kind: 'user',
        userId: config.currentUser.id,
        displayName: config.currentUser.name,
      };
      const replyTarget = thread.comments.at(-1);
      const clientMutationId = createClientMutationId();
      const comment = createComment(body, config.currentUser.name, {
        actor,
        clientMutationId,
        replyToCommentId: replyTarget?.id,
      });
      if (draftThread?.id === thread.id) {
        // First comment of a commenter's draft: thread and comment land in
        // the room as one `comments` insert.
        commentStore.addComment({ ...draftThread, comments: [comment] });
        setDraftThread(null);
      } else {
        commentStore.addComment(comment, thread);
      }
      fanoutMention(mentions, body, thread.id, comment.id, actor);
      const replyRecipient =
        replyTarget?.actor?.kind === 'user'
          ? replyTarget.actor.userId
          : undefined;
      if (
        replyRecipient &&
        replyRecipient !== config.currentUser.id &&
        !mentions.includes(replyRecipient)
      ) {
        config.onReply?.([replyRecipient], {
          actorName: config.currentUser.name,
          sourceTitle: config.documentTitle,
          snippet: body.slice(0, 200),
          threadId: thread.id,
          markId: thread.id,
          url: config.documentUri,
          commentId: comment.id,
          clientMutationId,
          replyToCommentId: replyTarget?.id,
        });
      }
      setActiveThreadId(thread.id);
    },
    [commentStore, config, fanoutMention, draftThread],
  );

  const handleSetThreadResolved = useCallback(
    (thread: Thread, resolved: boolean) => {
      if (!allowsMountedCommentMutation(config)) return;
      // A draft is not in the room yet; there is nothing to resolve.
      if (draftThread?.id === thread.id) return;
      if (
        !canManageCommentThread(
          resolveCommentCapabilities(config),
          config.currentUser.id,
          thread,
        )
      ) {
        return;
      }
      // Resolving is a non-destructive state change: the thread, its comments,
      // and the document MarkNode are all kept (the mark just renders dimmed).
      commentStore.setThreadResolved(thread, resolved);
      if (resolved && activeThreadId === thread.id) {
        setActiveThreadId(null);
      }
    },
    [commentStore, activeThreadId, config, draftThread],
  );

  const handleDeleteThread = useCallback(
    (thread: Thread) => {
      // Cancelling a draft discards local state and writes nothing.
      if (draftThread?.id === thread.id) {
        setDraftThread(null);
        if (activeThreadId === thread.id) setActiveThreadId(null);
        return;
      }
      if (!allowsMountedCommentMutation(config)) return;
      if (
        !canDeleteCommentThread(
          resolveCommentCapabilities(config),
          config.currentUser.id,
          thread,
        )
      ) {
        return;
      }
      // Destructive: removes the thread entirely and unwraps its mark.
      commentStore.deleteCommentOrThread(thread);
      removeMark(thread.id);
      if (activeThreadId === thread.id) {
        setActiveThreadId(null);
      }
    },
    [commentStore, removeMark, activeThreadId, config, draftThread],
  );

  const handleDeleteComment = useCallback(
    (comment: Comment, thread: Thread) => {
      if (!allowsMountedCommentMutation(config)) return;
      if (
        !canDeleteThreadComment(
          resolveCommentCapabilities(config),
          config.currentUser.id,
          comment,
        )
      ) {
        return;
      }
      // The last comment takes the thread with it, as one removal. Removing
      // the comment first would leave an empty thread for a beat, and a
      // commenter's removal of an empty (ownerless) thread is refused.
      if (thread.comments.length <= 1) {
        commentStore.deleteCommentOrThread(thread);
        removeMark(thread.id);
        return;
      }
      commentStore.deleteCommentOrThread(comment, thread);
    },
    [commentStore, removeMark, config],
  );

  const handleSelectThread = useCallback(
    (id: string) => {
      setActiveThreadId(id);
      scrollToThread(id);
    },
    [scrollToThread],
  );

  const openAgentSession = useCallback((sessionId: string) => {
    window.dispatchEvent(
      new CustomEvent('open-ai-session', { detail: { sessionId } }),
    );
  }, []);

  const getMembers = useCallback(() => config.getMembers(), [config]);

  // A MarkNode is Markdown's anchor, and a quote found exactly once is the
  // anchor of a thread that has none, so "no mark and no unique quote" is what
  // orphaned means here. The thread and its history stay in the panel either
  // way.
  const threadViews = useMemo<CommentThreadView[]>(
    () =>
      threads.map((thread) => ({
        thread,
        anchorState: orphanedThreadIds.has(thread.id) ? 'orphaned' : 'attached',
      })),
    [threads, orphanedThreadIds],
  );

  // Reserve room on the right of the editor pane while the panel is docked
  // open, so document text isn't hidden underneath it.
  useEffect(() => {
    paneElem.classList.toggle('comments-panel-open', panelOpen);
    return () => {
      paneElem.classList.remove('comments-panel-open');
    };
  }, [paneElem, panelOpen]);

  return (
    <>
      {/* Toggle + panel dock into the editor pane (not <body>) so they stay
          scoped to this tab. */}
      {!panelOpen &&
        createPortal(
          <button
            type="button"
            className="nim-comments-toggle"
            data-testid="comments-toggle"
            title="Comments"
            aria-label="Toggle comments"
            onClick={() => setPanelOpen(true)}
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              chat_bubble
            </span>
            <CommentCountBadge
              count={threads.length}
              className="nim-comments-toggle-count"
            />
          </button>,
          paneElem,
        )}

      {panelOpen &&
        createPortal(
          <CollaborativeCommentsPanel
            className="nim-comments-panel--docked"
            threads={threadViews}
            activeThreadId={activeThreadId}
            autoFocusThreadId={activeThreadId}
            capabilities={capabilities}
            currentUserId={config.currentUser.id}
            getMembers={getMembers}
            onSelectThread={handleSelectThread}
            onSetThreadResolved={handleSetThreadResolved}
            onDeleteThread={handleDeleteThread}
            onDeleteComment={handleDeleteComment}
            onReply={handleReply}
            onOpenAgentSession={openAgentSession}
            onClose={() => setPanelOpen(false)}
          />,
          paneElem,
        )}
    </>
  );
}
