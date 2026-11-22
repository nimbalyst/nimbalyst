/**
 * All of the mockup's comment wiring in one place: the pin store, the thread
 * source over the host service, and the anchor adapter registration.
 *
 * The host `comments` service is optional. When it is absent -- a mockup opened
 * outside a collaborative room, a host too old to provide it, a read-only
 * viewer with no collaboration context -- this returns a null source and the
 * editor degrades to no commenting. It deliberately does NOT fall back to a
 * local simulation: a comment that looked like it was shared and was not is
 * worse than a missing button.
 *
 * Pins still get a store in that case, because the overlay renders whatever is
 * in `mockupPins`, and a shared doc can carry pins written by a peer whose
 * host does expose the service.
 */

import { useEffect, useMemo, useRef, type RefObject } from "react";
import type {
  CollaborationCommentsService,
  MountedCommentAnchorAdapter,
} from "@nimbalyst/extension-sdk";
import { Doc as YDoc } from "yjs";
import type * as Y from "yjs";
import { MockupPinRepository } from "../../comments/mockupPinRepository";
import {
  bindMockupPinStore,
  canWriteMockupPins,
  guardMockupPinWrites,
  type MockupPinStore,
} from "../../comments/mockupPinStore";
import { createMockupPinAnchorAdapter } from "../../comments/mockupPinAnchor";
import {
  createMockupCommentSource,
  type MockupCommentSource,
} from "../../comments/mockupCommentSource";

export interface UseMockupCommentsOptions {
  /** Null outside a collaborative room. */
  yDoc: Y.Doc | null;
  /** Null when the host does not offer collaborative comments. */
  service: CollaborationCommentsService | null | undefined;
  /** The signed-in collaborator, absent outside a room. */
  user: { id: string; name: string } | null | undefined;
  iframeRef: RefObject<HTMLIFrameElement | null>;
}

export interface MockupCommentsWiring {
  store: MockupPinStore;
  /** Null means commenting is unavailable, not that there are no comments. */
  source: MockupCommentSource | null;
  /**
   * The adapter registered with the host. Returned so the thread pane resolves
   * anchors through the same instance the platform does, rather than building a
   * second one that could answer differently.
   */
  adapter: MountedCommentAnchorAdapter | null;
  /**
   * Whether this surface can place and author right now. Recomputed on every
   * render rather than memoized: the host refreshes capabilities against the
   * document access source, so a mid-session revocation has to land at once.
   */
  canComment: boolean;
}

export function useMockupComments({
  yDoc,
  service,
  user,
  iframeRef,
}: UseMockupCommentsOptions): MockupCommentsWiring {
  // Pins live in the shared Y.Doc beside the HTML, so replacing the HTML leaves
  // them intact. Outside a room there is no shared doc; a private one keeps
  // this a single implementation of the pin store rather than a second,
  // unreachable simulation of it. It stays empty either way, because the
  // comments service that authors pins comes from the same absent
  // collaboration context.
  const repository = useMemo(
    () => new MockupPinRepository(yDoc ?? new YDoc()),
    [yDoc]
  );
  useEffect(() => () => repository.destroy(), [repository]);

  // Read through a ref: the store outlives a service swap, and the gate must
  // answer from the current service at write time.
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const store = useMemo(
    () => guardMockupPinWrites(bindMockupPinStore(repository), () => canWriteMockupPins(serviceRef.current)),
    [repository]
  );

  const viewer = useMemo(
    () => ({ userId: user?.id ?? "local", name: user?.name ?? "You" }),
    [user?.id, user?.name]
  );

  const source = useMemo(
    () =>
      // No surface gate stacked on top of the capability: the host's answer to
      // "may this user comment?" is the whole answer, and it is independent of
      // whether they may edit the document.
      service ? createMockupCommentSource({ service, pins: store, viewer }) : null,
    [service, store, viewer]
  );
  useEffect(() => () => source?.dispose(), [source]);

  // The adapter is what lets the platform create a mockup thread at all: it
  // refuses an anchor no adapter reports attached. It reads the live pin set
  // and the live frame through closures, so building it once per source is
  // enough -- nothing it needs is captured by value.
  const adapter = useMemo(
    () =>
      source
        ? createMockupPinAnchorAdapter({
            getPins: () => store.snapshot(),
            getDocument: () => iframeRef.current?.contentDocument ?? null,
            getResolvedPinIds: () => source.getResolvedPinIds(),
          })
        : null,
    [source, store, iframeRef]
  );

  // Registering in an effect is safe because placement cannot happen before the
  // frame is mounted, but it must stay registered for the whole life of the
  // source, not just while the pane is open -- a peer's thread is resolved
  // through it too.
  useEffect(() => {
    if (!service || !adapter) return;
    return service.registerAnchorAdapter(adapter);
  }, [service, adapter]);

  return { store, source, adapter, canComment: source?.canComment() ?? false };
}
