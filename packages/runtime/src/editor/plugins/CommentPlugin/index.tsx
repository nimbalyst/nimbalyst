/**
 * CommentsPlugin
 *
 * Text-selection comments for collaborative Lexical documents. Selecting text
 * surfaces a floating "Add comment" affordance; submitting opens a composer
 * with an `@`-mention picker (team members). Comments anchor to the text via
 * `@lexical/mark` `MarkNode`s and persist in the document's shared Y.Doc
 * (top-level `comments` YArray) through the orphaned-upstream `CommentStore`.
 * A side panel lists threads, supports reply / resolve / delete, and clicking
 * a mark focuses its thread.
 *
 * When a comment `@`-mentions members, the host's `onMention` callback is
 * invoked (wired to `TeamSyncProvider.fanoutInboxEvent`) so each mentioned
 * member receives a polymorphic inbox event.
 *
 * Positioning uses `@floating-ui/react` (project rule — never manual
 * `position: fixed`). The MarkNode + `INSERT_INLINE_COMMENT_COMMAND` live in
 * `CommentsExtension`; this component owns the React UI and store wiring.
 */

import type { JSX } from 'react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { $isMarkNode, $unwrapMarkNode, $getMarkIDs, MarkNode } from '@lexical/mark';
import { mergeRegister } from '@lexical/utils';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  getDOMSelection,
  KEY_ENTER_COMMAND,
  type NodeKey,
} from 'lexical';

import { getDOMRangeRect } from '../../utils/getDOMRangeRect';
import {
  CommentStore,
  createComment,
  createThread,
  useCommentStore,
  type Comment,
  type Thread,
} from '../../commenting';
import { CommentCollabProvider } from '../../commenting/CommentCollabProvider';
import type {
  CommentMember,
  CommentsConfig,
  CommentMentionPayload,
} from '../../commenting/types';
import { INSERT_INLINE_COMMENT_COMMAND } from '../../extensions/builtin/CommentsExtension';
import {
  TypeaheadMenuPlugin,
  type TypeaheadMenuOption,
} from '../TypeaheadPlugin/TypeaheadMenuPlugin';
import { createBasicTriggerFunction } from '../TypeaheadPlugin/TypeaheadMenu';

import './CommentPlugin.css';

type MarkNodeMap = Map<string, Set<NodeKey>>;

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Composer (nested plain-text Lexical editor + @-mention typeahead)
// ---------------------------------------------------------------------------

interface ComposerSubmit {
  (text: string, mentionedUserIds: string[]): void;
}

function CommentComposerInner({
  getMembers,
  onSubmit,
  onCancel,
  submitLabel,
  placeholder,
  autoFocus,
}: {
  getMembers: () => CommentMember[];
  onSubmit: ComposerSubmit;
  onCancel: () => void;
  submitLabel: string;
  placeholder: string;
  autoFocus: boolean;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  // Snapshot the roster once so the typeahead options stay referentially
  // stable while the user is composing.
  const [members] = useState<CommentMember[]>(() => getMembers());
  // displayName -> userId for mentions the user actually picked.
  const mentionsRef = useRef<Map<string, string>>(new Map());
  const [canSubmit, setCanSubmit] = useState(false);
  const [queryString, setQueryString] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus) {
      editor.focus();
    }
  }, [editor, autoFocus]);

  const readTextAndMentions = useCallback((): {
    text: string;
    mentionedUserIds: string[];
  } => {
    let text = '';
    editor.getEditorState().read(() => {
      text = $getRoot().getTextContent();
    });
    const trimmed = text.trim();
    const mentionedUserIds: string[] = [];
    for (const [name, userId] of mentionsRef.current) {
      if (text.includes('@' + name)) {
        mentionedUserIds.push(userId);
      }
    }
    return { text: trimmed, mentionedUserIds: [...new Set(mentionedUserIds)] };
  }, [editor]);

  const submit = useCallback(() => {
    const { text, mentionedUserIds } = readTextAndMentions();
    if (!text) {
      onCancel();
      return;
    }
    onSubmit(text, mentionedUserIds);
    editor.update(() => {
      $getRoot().clear();
    });
    mentionsRef.current.clear();
    setCanSubmit(false);
  }, [readTextAndMentions, onSubmit, onCancel, editor]);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      editor.getEditorState().read(() => {
        setCanSubmit($getRoot().getTextContent().trim().length > 0);
      });
    });
  }, [editor]);

  // Cmd/Ctrl+Enter submits; plain Enter inserts a newline.
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (event && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, submit]);

  const triggerFn = useMemo(
    () => createBasicTriggerFunction('@', { minLength: 0 }),
    [],
  );

  const options = useMemo<TypeaheadMenuOption[]>(() => {
    const q = (queryString ?? '').toLowerCase();
    return members
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .slice(0, 10)
      .map((m) => ({
        id: 'mention-' + m.userId,
        label: m.name,
        onSelect: () => {
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertText('@' + m.name + ' ');
            }
          });
          mentionsRef.current.set(m.name, m.userId);
        },
      }));
  }, [members, queryString, editor]);

  const handleSelectOption = useCallback(
    (option: TypeaheadMenuOption, _node: unknown, closeMenu: () => void) => {
      option.onSelect();
      closeMenu();
    },
    [],
  );

  return (
    <div className="nim-comment-composer" data-testid="comment-composer">
      {/* Wrapper gives the placeholder a positioning context. Lexical renders
          the placeholder as a sibling of the contenteditable, so without a
          positioned wrapper its `position: absolute` resolves against
          `.nim-comments-panel` and pins "Reply..." to the panel's top-left
          corner, behind the header icon. */}
      <div className="nim-comment-composer-editor">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="nim-comment-composer-input"
              aria-placeholder={placeholder}
              placeholder={
                <div className="nim-comment-composer-placeholder">
                  {placeholder}
                </div>
              }
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <TypeaheadMenuPlugin
        options={options}
        triggerFn={triggerFn}
        onQueryChange={setQueryString}
        onSelectOption={handleSelectOption}
        maxHeight={240}
        minWidth={200}
        maxWidth={280}
      />
      <div className="nim-comment-composer-actions">
        <button
          type="button"
          className="nim-comment-btn nim-comment-btn-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="nim-comment-btn nim-comment-btn-submit"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function CommentComposer(props: {
  getMembers: () => CommentMember[];
  onSubmit: ComposerSubmit;
  onCancel: () => void;
  submitLabel: string;
  placeholder: string;
  autoFocus: boolean;
}): JSX.Element {
  const initialConfig = useMemo(
    () => ({
      namespace: 'NimbalystCommentComposer',
      theme: {},
      onError: (error: Error) => {
        throw error;
      },
      nodes: [],
    }),
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <CommentComposerInner {...props} />
    </LexicalComposer>
  );
}

// ---------------------------------------------------------------------------
// Thread side-panel
// ---------------------------------------------------------------------------

function CommentsPanel({
  threads,
  activeThreadId,
  getMembers,
  onSelectThread,
  onSetThreadResolved,
  onDeleteThread,
  onDeleteComment,
  onReply,
  onClose,
}: {
  threads: Thread[];
  activeThreadId: string | null;
  getMembers: () => CommentMember[];
  onSelectThread: (id: string) => void;
  onSetThreadResolved: (thread: Thread, resolved: boolean) => void;
  onDeleteThread: (thread: Thread) => void;
  onDeleteComment: (comment: Comment, thread: Thread) => void;
  onReply: (thread: Thread, text: string, mentionedUserIds: string[]) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="nim-comments-panel" data-testid="comments-panel">
      <div className="nim-comments-panel-header">
          <span className="material-symbols-outlined nim-comments-panel-icon">
            chat_bubble
          </span>
          <span className="nim-comments-panel-title">Comments</span>
          <button
            type="button"
            className="nim-comments-panel-close"
            onClick={onClose}
            aria-label="Close comments"
            title="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="nim-comments-panel-list">
          {threads.length === 0 ? (
            <div className="nim-comments-empty">
              No comments yet. Select text in the document and add one.
            </div>
          ) : (
            threads.map((thread) => (
              <div
                key={thread.id}
                className={
                  'nim-comment-thread' +
                  (thread.id === activeThreadId ? ' active' : '') +
                  (thread.resolved ? ' resolved' : '')
                }
                data-testid="comment-thread"
                data-resolved={thread.resolved ? 'true' : 'false'}
                onClick={() => onSelectThread(thread.id)}
              >
                <div className="nim-comment-quote" title={thread.quote}>
                  {thread.resolved && (
                    <span
                      className="nim-comment-resolved-badge"
                      title="Resolved"
                    >
                      <span className="material-symbols-outlined">
                        check_circle
                      </span>
                    </span>
                  )}
                  {thread.quote || '(no quote)'}
                </div>
                {thread.resolved ? (
                  // Resolved threads collapse to a dimmed summary with an
                  // Unresolve affordance; comments and the reply composer are
                  // hidden until the thread is reopened.
                  <div
                    className="nim-comment-thread-footer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="nim-comment-resolved-summary">
                      {thread.comments.length}{' '}
                      {thread.comments.length === 1 ? 'comment' : 'comments'}
                      {' · Resolved'}
                    </span>
                    <button
                      type="button"
                      className="nim-comment-btn nim-comment-btn-unresolve"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSetThreadResolved(thread, false);
                      }}
                    >
                      Unresolve
                    </button>
                    <button
                      type="button"
                      className="nim-comment-btn nim-comment-btn-delete-thread"
                      title="Delete thread"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteThread(thread);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : (
                  <>
                    {thread.comments.map((comment) => (
                      <div key={comment.id} className="nim-comment">
                        <div className="nim-comment-meta">
                          <span className="nim-comment-author">
                            {comment.author}
                          </span>
                          <span className="nim-comment-time">
                            {formatTimestamp(comment.timeStamp)}
                          </span>
                          <button
                            type="button"
                            className="nim-comment-delete"
                            title="Delete comment"
                            aria-label="Delete comment"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteComment(comment, thread);
                            }}
                          >
                            <span className="material-symbols-outlined">
                              delete
                            </span>
                          </button>
                        </div>
                        <div className="nim-comment-content">
                          {comment.content}
                        </div>
                      </div>
                    ))}
                    <div
                      className="nim-comment-thread-footer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <CommentComposer
                        getMembers={getMembers}
                        submitLabel="Reply"
                        placeholder="Reply..."
                        autoFocus={false}
                        onSubmit={(text, mentioned) =>
                          onReply(thread, text, mentioned)
                        }
                        onCancel={() => {}}
                      />
                      <button
                        type="button"
                        className="nim-comment-btn nim-comment-btn-resolve"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetThreadResolved(thread, true);
                        }}
                      >
                        Resolve
                      </button>
                      <button
                        type="button"
                        className="nim-comment-btn nim-comment-btn-delete-thread"
                        title="Delete thread"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteThread(thread);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

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
  const [markVersion, setMarkVersion] = useState(0);

  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);
  const [composer, setComposer] = useState<{ thread: Thread; rect: DOMRect } | null>(
    null,
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const threads = useMemo(
    () => comments.filter((c): c is Thread => c.type === 'thread'),
    [comments],
  );

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

  // -- Track the current non-collapsed selection for the add affordance ------
  useEffect(() => {
    const update = () => {
      if (composer) {
        return;
      }
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        const nativeSelection = getDOMSelection(editor._window);
        const rootElement = editor.getRootElement();
        if (
          $isRangeSelection(selection) &&
          !selection.isCollapsed() &&
          nativeSelection !== null &&
          rootElement !== null &&
          rootElement.contains(nativeSelection.anchorNode) &&
          selection.getTextContent().trim() !== ''
        ) {
          setSelectionRect(getDOMRangeRect(nativeSelection, rootElement));
        } else {
          setSelectionRect(null);
        }
      });
    };
    document.addEventListener('selectionchange', update);
    return mergeRegister(
      editor.registerUpdateListener(update),
      () => document.removeEventListener('selectionchange', update),
    );
  }, [editor, composer]);

  // -- Helpers ---------------------------------------------------------------
  const removeMark = useCallback(
    (id: string) => {
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
    [editor],
  );

  const scrollToThread = useCallback(
    (id: string) => {
      const keys = markNodeMapRef.current.get(id);
      if (!keys) return;
      for (const key of keys) {
        const el = editor.getElementByKey(key);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          break;
        }
      }
    },
    [editor],
  );

  const fanoutMention = useCallback(
    (mentionedUserIds: string[], snippet: string, threadId: string) => {
      if (!config.onMention || mentionedUserIds.length === 0) return;
      const recipients = mentionedUserIds.filter(
        (id) => id !== config.currentUser.id,
      );
      if (recipients.length === 0) return;
      const payload: CommentMentionPayload = {
        actorName: config.currentUser.name,
        sourceTitle: config.documentTitle,
        snippet: snippet.slice(0, 200),
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

    const thread = createThread(quote, []);
    commentStore.addComment(thread);
    editor.dispatchCommand(INSERT_INLINE_COMMENT_COMMAND, {
      id: thread.id,
      isBackward,
    });

    const rect = selectionRect;
    setSelectionRect(null);
    setComposer({ thread, rect: rect ?? new DOMRect() });
    setActiveThreadId(thread.id);
  }, [editor, commentStore, selectionRect]);

  const handleComposerSubmit = useCallback(
    (text: string, mentionedUserIds: string[]) => {
      const current = composer;
      if (!current) return;
      const comment = createComment(text, config.currentUser.name);
      commentStore.addComment(comment, current.thread);
      fanoutMention(mentionedUserIds, text, current.thread.id);
      setComposer(null);
      setPanelOpen(true);
      setActiveThreadId(current.thread.id);
    },
    [composer, commentStore, config.currentUser.name, fanoutMention],
  );

  const handleComposerCancel = useCallback(() => {
    const current = composer;
    if (!current) return;
    // An empty new thread (the composer was opened but never submitted) is
    // discarded along with its mark.
    if (current.thread.comments.length === 0) {
      commentStore.deleteCommentOrThread(current.thread);
      removeMark(current.thread.id);
    }
    setComposer(null);
  }, [composer, commentStore, removeMark]);

  const handleReply = useCallback(
    (thread: Thread, text: string, mentionedUserIds: string[]) => {
      const comment = createComment(text, config.currentUser.name);
      commentStore.addComment(comment, thread);
      fanoutMention(mentionedUserIds, text, thread.id);
      setActiveThreadId(thread.id);
    },
    [commentStore, config.currentUser.name, fanoutMention],
  );

  const handleSetThreadResolved = useCallback(
    (thread: Thread, resolved: boolean) => {
      // Resolving is a non-destructive state change: the thread, its comments,
      // and the document MarkNode are all kept (the mark just renders dimmed).
      commentStore.setThreadResolved(thread, resolved);
      if (resolved && activeThreadId === thread.id) {
        setActiveThreadId(null);
      }
    },
    [commentStore, activeThreadId],
  );

  const handleDeleteThread = useCallback(
    (thread: Thread) => {
      // Destructive: removes the thread entirely and unwraps its mark.
      commentStore.deleteCommentOrThread(thread);
      removeMark(thread.id);
      if (activeThreadId === thread.id) {
        setActiveThreadId(null);
      }
    },
    [commentStore, removeMark, activeThreadId],
  );

  const handleDeleteComment = useCallback(
    (comment: Comment, thread: Thread) => {
      commentStore.deleteCommentOrThread(comment, thread);
      // If that was the last comment, also resolve (remove) the thread + mark.
      if (thread.comments.length <= 1) {
        commentStore.deleteCommentOrThread(thread);
        removeMark(thread.id);
      }
    },
    [commentStore, removeMark],
  );

  const handleSelectThread = useCallback(
    (id: string) => {
      setActiveThreadId(id);
      scrollToThread(id);
    },
    [scrollToThread],
  );

  const getMembers = useCallback(() => config.getMembers(), [config]);

  // -- Floating positioning --------------------------------------------------
  const addButtonRef = useFloating({
    placement: 'top',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const composerFloat = useFloating({
    placement: 'bottom-start',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const addReference = useMemo(
    () => ({ getBoundingClientRect: () => selectionRect ?? new DOMRect() }),
    [selectionRect],
  );
  const composerReference = useMemo(
    () => ({ getBoundingClientRect: () => composer?.rect ?? new DOMRect() }),
    [composer],
  );

  useEffect(() => {
    addButtonRef.refs.setReference(addReference);
  }, [addButtonRef.refs, addReference]);
  useEffect(() => {
    composerFloat.refs.setReference(composerReference);
  }, [composerFloat.refs, composerReference]);

  const showAddButton = selectionRect !== null && composer === null;

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
      {showAddButton && (
        <FloatingPortal>
          <button
            type="button"
            ref={addButtonRef.refs.setFloating}
            style={addButtonRef.floatingStyles}
            className="nim-add-comment-button"
            data-testid="add-comment-button"
            // Prevent the click from blurring the editor selection before the
            // command runs.
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleAddComment}
          >
            <span className="material-symbols-outlined">add_comment</span>
            <span>Comment</span>
          </button>
        </FloatingPortal>
      )}

      {composer && (
        <FloatingPortal>
          <div
            ref={composerFloat.refs.setFloating}
            style={composerFloat.floatingStyles}
            className="nim-comment-composer-popover"
          >
            <CommentComposer
              getMembers={getMembers}
              submitLabel="Comment"
              placeholder="Add a comment... use @ to mention"
              autoFocus
              onSubmit={handleComposerSubmit}
              onCancel={handleComposerCancel}
            />
          </div>
        </FloatingPortal>
      )}

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
            <span className="material-symbols-outlined">chat_bubble</span>
            {threads.length > 0 && (
              <span className="nim-comments-toggle-count">{threads.length}</span>
            )}
          </button>,
          paneElem,
        )}

      {panelOpen &&
        createPortal(
          <CommentsPanel
            threads={threads}
            activeThreadId={activeThreadId}
            getMembers={getMembers}
            onSelectThread={handleSelectThread}
            onSetThreadResolved={handleSetThreadResolved}
            onDeleteThread={handleDeleteThread}
            onDeleteComment={handleDeleteComment}
            onReply={handleReply}
            onClose={() => setPanelOpen(false)}
          />,
          paneElem,
        )}
    </>
  );
}
