/**
 * The host-supplied card renderer.
 *
 * Module-level callback slot, filled by the renderer, exactly as
 * `setEmbedPluginCallbacks` is filled with `EmbedFrame` at
 * `packages/electron/src/renderer/components/EmbedFrame/index.ts`. The canvas
 * must not learn how to resolve an extension, read a file, or open a collab
 * room, for the same reason the Lexical `EmbedPlugin` must not: Slice 6
 * publishes this module to the web console through `@nimbalyst/collab-bundle`,
 * where none of those things exist in the same form and an Electron import is a
 * hard failure.
 *
 * The slot is deliberately narrow. It takes a reference and a detail level and
 * returns a component; it does not take a save callback, a room handle, or a
 * dirty signal, because each host already owns all three through its own
 * `EditorHost` plumbing. Widening it later is easy; narrowing it once two hosts
 * depend on it is not.
 *
 * `cold` never reaches the editor renderer. The optional preview slot may
 * supply a lightweight image; otherwise the canvas draws its label summary.
 */

import type { ComponentType, ReactNode } from 'react';

import type { CanvasDocReference, CanvasFileReference } from './CanvasDocument';
// Type-only, and circular on purpose: `canvasRevisions` needs the reference
// union that is defined here, and the slot below needs the source it defines.
// Both edges are erased at build.
import type { CanvasRevisionSource } from './canvasRevisions';

/** The two reference kinds that resolve to a real editor. */
export type CanvasCardReference = CanvasFileReference | CanvasDocReference;

/**
 * What a host's picker resolves to.
 *
 * The label rides along rather than being derived from the reference, because
 * it cannot be: a `doc` URI ends in an opaque document id, and a card titled
 * `f3a91c...` is worse than no title. Only the host knows the human name.
 */
export interface CanvasCardPick {
  reference: CanvasCardReference;
  label?: string;
}

/**
 * Turning something dragged onto the board into a card.
 *
 * Two methods rather than one because the browser gives a drag two different
 * amounts of information. During `dragover` the payload is in *protected mode*
 * -- `getData` returns an empty string, and only the list of MIME types is
 * readable -- so deciding whether to show a drop target has to be answerable
 * from `accepts(types)` alone. The values only become readable on `drop`.
 *
 * Host-supplied for the same reason `renderCard` is: the desktop drags
 * workspace paths out of a file tree, the console drags document ids out of a
 * shared-docs tree, and the canvas is published to both.
 */
export interface CanvasDropSource {
  /** Dragover: types only; the values are unreadable at this point. */
  accepts(types: readonly string[]): boolean;
  /** Drop: the payload, or null if it turned out not to name anything. */
  read(dataTransfer: DataTransfer): CanvasCardPick | null;
}

export interface CanvasCardRenderProps {
  /** Canvas node id. Stable across moves; useful as a mount key. */
  nodeId: string;
  reference: CanvasCardReference;
  /** Display name for chrome and error states. May be empty. */
  label: string;
  /**
   * `warm` -- mount read-only, no editing affordances, pointer-inert.
   * `hot` -- editable and focusable; the viewport is at scale 1.0.
   *
   * A host must treat this as a property change, not a remount: warming and
   * heating the same card must not tear down its editor or its room.
   */
  detail: 'warm' | 'hot';
}

/** Lightweight content may replace a cold summary or a warm editor. */
export interface CanvasCardPreviewProps {
  nodeId: string;
  reference: CanvasCardReference;
  label: string;
  detail: 'cold' | 'warm' | 'hot';
  width: number;
  height: number;
  /** Return this for unsupported references and when editing. */
  children: ReactNode;
}

/**
 * The host's answer to "how many unresolved comments are inside this card's own
 * document?" -- the *other* half of the dual count, and the half the canvas
 * cannot compute, because that conversation lives in that document's comment
 * room and not in the board's.
 *
 * `getOpenThreadCount` returning `undefined` or `null` means **unknown**, not
 * zero: a cold card has no room open, a private file has no room at all, and a
 * host may have no provider. The chrome renders unknown as absent. A host that
 * cannot tell must not answer 0, because 0 reads as "nobody has commented on
 * this document" and that is a claim it has no basis for.
 */
export interface CanvasCardCommentSource {
  /**
   * Watch these cards' own documents; the listener fires when any answer
   * changes. The board re-subscribes when its set of reference cards changes,
   * so a host can size its work to what is actually on screen.
   */
  watch(
    references: readonly CanvasCardReference[],
    onChange: () => void
  ): () => void;
  getOpenThreadCount(
    reference: CanvasCardReference
  ): number | null | undefined;
}

/**
 * A request from an `@agent` comment reply, handed to the host to turn into a
 * working session. See `canvasComments.ts` for why exactly one client raises it.
 */
export interface CanvasAgentDispatch {
  threadId: string;
  commentId: string;
  /** Ready-to-send prompt naming the board, the thread, and the ask. */
  prompt: string;
  anchorLabel: string;
}

export interface CanvasCallbacks {
  /**
   * Mounts the real editor for a `file` or `doc` card. When undefined, the
   * canvas falls back to a labelled placeholder naming what the card points at,
   * so a board opened in a host with no renderer registered is still readable
   * rather than a wall of blanks.
   */
  renderCard?: ComponentType<CanvasCardRenderProps>;

  /** Must not open editors or rooms for cold cards. Optional per host. */
  renderCardPreview?: ComponentType<CanvasCardPreviewProps>;
  /** Open a screenshot's recorded source file in the host editor. */
  openScreenshotSource?(path: string): void;

  /** In-document comment counts for reference cards. Optional; see above. */
  cardComments?: CanvasCardCommentSource;

  /**
   * Revision history for a card's content. Absent means this host cannot ask
   * -- the board then shows no history affordance at all, rather than an empty
   * rail, which would read as "this document has no past" and is a different
   * claim entirely.
   */
  revisions?: CanvasRevisionSource;

  /**
   * Start a session for an `@agent` reply. Absent means this host cannot run
   * sessions (the browser console today), and the mention stays an ordinary
   * comment rather than a button that silently does nothing.
   */
  dispatchAgentThread?(request: CanvasAgentDispatch): void;

  /**
   * Ask the user which existing file or document to put on the board, and
   * resolve with the reference to embed -- or null if they backed out.
   *
   * A host seam for the same reason `renderCard` is one: "which documents
   * exist" is a filesystem question on the desktop and a collab-room question
   * in the browser, and the canvas is published to both. It resolves a
   * reference rather than creating one, so nothing here can mint a document as
   * a side effect of a picker being cancelled.
   *
   * Absent means this host has no picker, and the board hides the affordance
   * instead of offering a button that opens nothing.
   */
  pickCardReference?(): Promise<CanvasCardPick | null>;

  /**
   * Drag a file or document from the host's own tree onto the board.
   *
   * Absent means the board ignores drops entirely rather than swallowing them,
   * so a drag the host cannot interpret falls through to whatever else on the
   * page would have handled it.
   */
  dropSource?: CanvasDropSource;
}

let callbacks: CanvasCallbacks = {};

export function getCanvasCallbacks(): CanvasCallbacks {
  return callbacks;
}

export function setCanvasCallbacks(next: CanvasCallbacks): void {
  callbacks = next;
}
