import React from 'react';

import { NimbalystEditor } from '@nimbalyst/runtime/editor/NimbalystEditor';
import type { EditorConfig } from '@nimbalyst/runtime/editor/EditorConfig';

import {
  describePresenceChange,
  emptyPresenceAnnouncementState,
  type PresenceAnnouncementState,
} from './presenceAnnouncements';
import type { CollabEditorPresence } from './types';

/** Long enough to fold a reconnect's leave/rejoin pair into one message. */
const PRESENCE_ANNOUNCE_DEBOUNCE_MS = 900;

export type PresenceSubscription = (
  listener: (presence: CollabEditorPresence) => void,
) => () => void;

interface BrowserEditorSurfaceProps {
  config: EditorConfig;
  subscribeToPresence?: PresenceSubscription;
}

/**
 * Polite announcements of who joined or left, for assistive tech only.
 *
 * Rendered unconditionally so the live region exists in the accessibility tree
 * before the first message lands — a region inserted at the same time as its
 * text is frequently not spoken.
 */
function PresenceAnnouncements({
  subscribeToPresence,
}: {
  subscribeToPresence: PresenceSubscription;
}): React.JSX.Element {
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    let state: PresenceAnnouncementState = emptyPresenceAnnouncementState;
    let latest: CollabEditorPresence | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      timer = null;
      if (!latest) return;
      const result = describePresenceChange(state, latest.participants);
      state = { known: result.known, described: result.described };
      if (result.message) setMessage(result.message);
    };

    const unsubscribe = subscribeToPresence((presence) => {
      latest = presence;
      if (timer) return;
      timer = setTimeout(flush, PRESENCE_ANNOUNCE_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [subscribeToPresence]);

  return (
    <div
      className="collab-bundle-presence-announcements"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {message}
    </div>
  );
}

/**
 * Contexts where Tab means "indent this", not "move on".
 *
 * List items and table cells are the classic ones; `code.nim-code` is the
 * runtime's fenced code block, as distinct from `.nim-text-code`, which is an
 * inline code span inside ordinary prose and carries no indentation meaning.
 */
const INDENTABLE_SELECTOR = 'li, table, code.nim-code';

function selectionWantsIndentation(editable: HTMLElement): boolean {
  const selection = editable.ownerDocument.getSelection();
  const anchor = selection?.anchorNode ?? null;
  if (!anchor) return false;
  const element = anchor.nodeType === Node.ELEMENT_NODE
    ? (anchor as Element)
    : anchor.parentElement;
  if (!element || !editable.contains(element)) return false;
  return element.closest(INDENTABLE_SELECTOR) !== null;
}

/**
 * Let Tab leave the document.
 *
 * The runtime registers `TabIndentationExtension` unconditionally, which
 * consumes Tab and Shift+Tab everywhere in the document and inserts a tab
 * character. In a full-window desktop editor that is merely opinionated; in a
 * browser tab it is a WCAG 2.1.2 keyboard trap — measured in real Chrome, six
 * consecutive Tab presses left focus in the editor and added six tab
 * characters, with no keyboard route to the toolbar, the shell around it, or
 * anything after the document.
 *
 * Indentation is kept where it means something. Everywhere else the event is
 * stopped before it reaches Lexical's root listener and, deliberately, is *not*
 * default-prevented — so the browser performs its own focus move and the tab
 * order stays whatever the host page declares.
 */
function releaseTabFromDocument(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const editable = target.closest<HTMLElement>('[contenteditable="true"]');
  if (!editable || !event.currentTarget.contains(editable)) return;
  if (selectionWantsIndentation(editable)) return;
  event.stopPropagation();
}

export function BrowserEditorSurface({
  config,
  subscribeToPresence,
}: BrowserEditorSurfaceProps): React.JSX.Element {
  return (
    <div
      className="collab-bundle-editor"
      onKeyDownCapture={releaseTabFromDocument}
    >
      {subscribeToPresence && (
        <PresenceAnnouncements subscribeToPresence={subscribeToPresence} />
      )}
      <NimbalystEditor config={config} />
    </div>
  );
}
