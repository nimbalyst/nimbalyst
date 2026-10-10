/**
 * The action button block in the editor.
 *
 * A page is written by teammates and agents, so a session button never runs
 * on a click: the click opens a review panel showing the whole prompt, the
 * model and the effort, and only "Start session" there runs it. If the block
 * changes while the panel is open (a teammate's edit arriving), the panel
 * closes and asks for a fresh review, so what runs is always what was read.
 *
 * A new-item button asks for the title first, then creates the typed page
 * under this page and opens it (Cmd/Ctrl-click opens it in a new tab).
 *
 * Without a host that can do the action, the button is disabled and says why.
 */

import React, { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $getNodeByKey, type NodeKey } from 'lexical';

import { useBlockActions } from '../DraggableBlockPlugin/useBlockActions';
import { $isActionButtonNode } from './ActionButtonNodeCore';
import {
  getActionButtonHost,
  NEW_ITEM_UNAVAILABLE_REASON,
  pagePathOf,
  SESSION_UNAVAILABLE_REASON,
  type ActionButtonHost,
  type SessionLaunch,
} from './actionButtonHost';
import { countHiddenCharacters, escapeHiddenCharacters } from './hiddenCharacters';
import {
  parseNewItemAction,
  parseSessionAction,
  type ActionButtonKind,
  type NewItemAction,
  type SessionAction,
} from './actionButtonSource';
import { resolveTemplateBody, type TemplateBody } from './templateBody';

export interface ActionButtonViewProps {
  /** Bumped by the block menu's "Edit button" to open the source editor. */
  editRequest?: number;
  kind: ActionButtonKind;
  source: string;
  editable: boolean;
  host: ActionButtonHost | null;
  onSaveSource: (source: string) => void;
  /** The page the block sits on; read at click time. */
  getPagePath: () => string | null;
  readTemplate?: (template: string | undefined) => Promise<TemplateBody>;
}

const linkButton = 'cursor-pointer border-none bg-transparent p-0 text-[11px] text-nim-link hover:underline';
const primaryButton = 'action-button-primary cursor-pointer rounded-md border-none bg-[var(--nim-primary)] px-3 py-1.5 text-sm font-medium text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'cursor-pointer rounded-md border border-nim bg-transparent px-3 py-1.5 text-sm text-nim hover:bg-nim-hover';

function SourceEditor({ source, onSave, onClose }: { source: string; onSave: (text: string) => void; onClose: () => void }): JSX.Element {
  const [text, setText] = useState(source);
  const baseline = useRef(source);
  const [conflict, setConflict] = useState(false);
  const dirty = text !== baseline.current;
  // An untouched draft follows the node, so an open editor shows a teammate's update.
  useEffect(() => {
    if (!dirty) {
      baseline.current = source;
      setText(source);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  const save = () => {
    if (!dirty) return onClose();
    if (source !== baseline.current) return setConflict(true);
    onSave(text);
    onClose();
  };
  return (
    <div className="mt-2">
      {conflict ? (
        <div role="alert" className="action-button-conflict mb-1 flex items-center gap-3 rounded border border-nim bg-nim-tertiary px-2 py-1 text-xs text-nim-warning">
          <span>This button changed while you were editing it.</span>
          <button type="button" className={`ml-auto ${linkButton}`} onMouseDown={(e) => e.preventDefault()} onClick={() => { onSave(text); onClose(); }}>Keep mine</button>
          <button type="button" className={linkButton} onMouseDown={(e) => e.preventDefault()} onClick={onClose}>Use theirs</button>
        </div>
      ) : null}
      <textarea
        className="action-button-source min-h-[120px] w-full resize-y rounded border border-nim bg-nim-tertiary p-2 font-mono text-xs text-nim focus:border-[var(--nim-border-focus)] focus:outline-none"
        value={text}
        autoFocus
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => { if (!conflict) save(); }}
        onKeyDown={(event) => event.stopPropagation()}
        data-testid="action-button-source"
      />
    </div>
  );
}

/** Lines the preview box shows before it scrolls (`max-h-64` at `text-xs`). */
const PREVIEW_LINES = 16;

type Review =
  | { status: 'hidden'; prompt: string; count: number }
  | { status: 'resolving' }
  | { status: 'ready'; launch: Readonly<SessionLaunch> }
  | { status: 'failed' };

function PromptPreview({ prompt, escaped }: { prompt: string; escaped: boolean }): JSX.Element {
  const lines = prompt.split('\n').length;
  return (
    <>
      <pre className="action-button-review-prompt mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-nim bg-nim p-2 font-mono text-xs text-nim select-text" data-testid="action-button-review-prompt">
        {escaped ? escapeHiddenCharacters(prompt) : prompt}
      </pre>
      <div className="mt-0.5 text-[11px] text-nim-faint" data-testid="action-button-review-length">
        {lines} {lines === 1 ? 'line' : 'lines'}, {prompt.length} characters
        {lines > PREVIEW_LINES ? <span className="text-nim-warning">{` -- ${lines - PREVIEW_LINES} more lines below; scroll the box to read them all`}</span> : null}
      </div>
    </>
  );
}

function SessionReview({ review, running, onStart, onCancel }: {
  review: Review;
  running: boolean;
  onStart: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="action-button-review mt-2 rounded border border-nim bg-nim-tertiary p-2 text-sm" data-testid="action-button-review">
      {review.status === 'hidden' ? (
        <>
          <div role="alert" className="font-semibold text-nim-error" data-testid="action-button-hidden">
            This prompt contains {review.count} hidden {review.count === 1 ? 'character' : 'characters'} and cannot be run.
          </div>
          <div className="mt-0.5 text-xs text-nim-muted">
            Invisible characters can carry instructions you cannot read. They are shown escaped below; remove them from the button to run it.
          </div>
          <PromptPreview prompt={review.prompt} escaped />
        </>
      ) : (
        <>
          <div className="font-semibold text-nim">Start an agent session with this prompt?</div>
          <div className="mt-0.5 text-xs text-nim-muted">
            It runs as you, with this page as context. Anyone who can edit the page can change this prompt, so read it first.
          </div>
          {review.status === 'resolving' ? <div className="mt-2 text-xs text-nim-muted">Checking the model...</div> : null}
          {review.status === 'ready' ? (
            <>
              <PromptPreview prompt={review.launch.prompt} escaped={false} />
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-nim-muted">Model</dt>
                <dd className="m-0 text-nim select-text" data-testid="action-button-review-model">
                  {review.launch.modelName} <span className="font-mono text-nim-faint">({review.launch.model})</span>
                  {review.launch.usesDefaultModel ? <span className="text-nim-muted"> -- your default model</span> : null}
                </dd>
                <dt className="text-nim-muted">Effort</dt>
                <dd className="m-0 font-mono text-nim select-text" data-testid="action-button-review-effort">
                  {review.launch.effort}
                  {review.launch.effortClamped ? <span className="font-sans text-nim-warning">{` -- lowered from ${review.launch.requestedEffort}, the highest this model supports is ${review.launch.effort}`}</span> : null}
                </dd>
              </dl>
            </>
          ) : null}
        </>
      )}
      <div className="mt-2 flex gap-2">
        {review.status === 'ready' ? (
          <button type="button" className={primaryButton} disabled={running} onClick={onStart} data-testid="action-button-confirm">
            {running ? 'Starting...' : 'Start session'}
          </button>
        ) : null}
        <button type="button" className={secondaryButton} disabled={running} onClick={onCancel} data-testid="action-button-cancel">Cancel</button>
      </div>
    </div>
  );
}

function NewItemTitle({ action, running, onCreate, onCancel }: {
  action: NewItemAction;
  running: boolean;
  onCreate: (title: string, newTab: boolean) => void;
  onCancel: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(action.title ?? '');
  const create = (newTab: boolean) => { if (title.trim()) onCreate(title.trim(), newTab); };
  return (
    <div className="action-button-new-item mt-2 flex items-center gap-2" data-testid="action-button-new-item">
      <input
        className="min-w-0 flex-1 rounded border border-nim bg-nim px-2 py-1 text-sm text-nim focus:border-[var(--nim-border-focus)] focus:outline-none disabled:opacity-60"
        value={title}
        placeholder={`Title of the new ${action.type}`}
        autoFocus
        disabled={running}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') create(event.metaKey || event.ctrlKey);
          if (event.key === 'Escape') onCancel();
        }}
        data-testid="action-button-title"
      />
      <button type="button" className={primaryButton} disabled={running || !title.trim()} onClick={(event) => create(event.metaKey || event.ctrlKey)} data-testid="action-button-create">
        {running ? 'Creating...' : 'Create'}
      </button>
      <button type="button" className={secondaryButton} disabled={running} onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function ActionButtonView({ kind, source, editable, host, onSaveSource, getPagePath, readTemplate = resolveTemplateBody, editRequest = 0 }: ActionButtonViewProps): JSX.Element {
  const parsed = useMemo(() => (kind === 'session' ? parseSessionAction(source) : parseNewItemAction(source)), [kind, source]);
  /** The source the open review or title step was opened against. */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editRequest > 0) setEditing(true);
  }, [editRequest]);
  // Synchronous: a second Enter lands before React re-renders with `running`.
  const inFlight = useRef(false);
  const currentSource = useRef(source);
  currentSource.current = source;

  // A change under an open review means the user has not read what would run.
  useEffect(() => {
    if (openedFor !== null && openedFor !== source && !running) {
      setOpenedFor(null);
      setReview(null);
      setNotice('This button changed while it was open. Review it again before running it.');
    }
  }, [source, openedFor, running]);

  const available = kind === 'session' ? !!(host?.resolveSession && host.startSession) : !!host?.createItem;
  const unavailable = available ? null : kind === 'session' ? SESSION_UNAVAILABLE_REASON : NEW_ITEM_UNAVAILABLE_REASON;
  const close = () => {
    setOpenedFor(null);
    setReview(null);
  };

  const open = () => {
    setNotice(null);
    setError(null);
    setOpenedFor(source);
    if (kind !== 'session' || !parsed.ok) return;
    const action = parsed.value as SessionAction;
    const hidden = countHiddenCharacters(`${action.label}\n${action.prompt}\n${action.model ?? ''}`);
    if (hidden > 0) {
      setReview({ status: 'hidden', prompt: action.prompt, count: hidden });
      return;
    }
    setReview({ status: 'resolving' });
    const opened = source;
    void host!.resolveSession!({ ...action, pagePath: getPagePath() })
      .catch((thrown: unknown) => ({ ok: false as const, error: thrown instanceof Error ? thrown.message : String(thrown) }))
      .then((result) => {
        // A review for an older version of the block is stale; the effect above already closed it.
        if (currentSource.current !== opened) return;
        if (result.ok) {
          setReview({ status: 'ready', launch: Object.freeze({ ...result.launch }) });
        } else {
          setReview({ status: 'failed' });
          setError(result.error);
        }
      });
  };

  const finish = async (work: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(null);
    try {
      const result = await work();
      if (result.ok) close();
      else setError(result.error);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };

  const startSession = () => {
    if (!host?.startSession || openedFor !== source || review?.status !== 'ready') return;
    const launch = review.launch;
    void finish(() => host.startSession!(launch));
  };

  const createItem = (action: NewItemAction, title: string, newTab: boolean) => {
    if (!host?.createItem || openedFor !== source) return;
    void finish(async () => {
      const template = await readTemplate(action.template);
      if (!template.ok) return template;
      return host.createItem!({ type: action.type, title, body: template.body, pagePath: getPagePath(), newTab });
    });
  };

  return (
    <div className="action-button-block my-3" contentEditable={false} data-testid="action-button-block" data-action-kind={kind}>
      {parsed.ok ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={primaryButton}
            disabled={!!unavailable || running}
            title={unavailable ?? undefined}
            onClick={open}
            data-testid="action-button"
          >
            {parsed.value.label}
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-nim-muted">
            {unavailable ?? (kind === 'session'
              ? escapeHiddenCharacters((parsed.value as SessionAction).prompt.split('\n')[0])
              : `Creates a ${(parsed.value as NewItemAction).type} page under this page`)}
          </span>
          {editable ? (
            <button type="button" className={linkButton} onClick={() => setEditing(!editing)} data-testid="action-button-edit">
              {editing ? 'Done' : 'Edit'}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div role="alert" className="action-button-error flex-1 rounded border border-nim bg-nim-tertiary px-3 py-1 font-mono text-xs text-nim-error select-text" data-testid="action-button-error">
            {parsed.error}
          </div>
          {editable ? <button type="button" className={linkButton} onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button> : null}
        </div>
      )}
      {notice ? <div className="mt-1 text-xs text-nim-warning" role="status" data-testid="action-button-notice">{notice}</div> : null}
      {parsed.ok && openedFor === source && kind === 'session' && review ? (
        <SessionReview review={review} running={running} onStart={startSession} onCancel={close} />
      ) : null}
      {parsed.ok && openedFor === source && kind === 'new-item' ? (
        <NewItemTitle action={parsed.value as NewItemAction} running={running} onCreate={(title, newTab) => createItem(parsed.value as NewItemAction, title, newTab)} onCancel={close} />
      ) : null}
      {error ? <div role="alert" className="mt-1 text-xs text-nim-error select-text" data-testid="action-button-failure">{error}</div> : null}
      {editing ? <SourceEditor source={source} onSave={onSaveSource} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

export function ActionButtonBlock({ kind, source, nodeKey }: { kind: ActionButtonKind; source: string; nodeKey: NodeKey }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const anchor = useRef<HTMLDivElement>(null);
  const [editRequest, setEditRequest] = useState(0);
  useBlockActions(nodeKey, { edit: editable ? () => setEditRequest((n) => n + 1) : null });
  return (
    <div ref={anchor}>
      <ActionButtonView
        editRequest={editRequest}
        kind={kind}
        source={source}
        editable={editable}
        host={getActionButtonHost()}
        getPagePath={() => pagePathOf(anchor.current)}
        onSaveSource={(text) => editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          if ($isActionButtonNode(node)) node.setSource(text);
        })}
      />
    </div>
  );
}
