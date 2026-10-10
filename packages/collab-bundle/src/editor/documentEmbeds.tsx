import React from 'react';
import { usePlacedViewAttrs } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/usePlacedViewAttrs';
import { PlacedViewResizeFrame } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/PlacedViewResizeFrame';
import { buildCollabUri, isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import { setEmbedPluginCallbacks, type EmbedFrameProps } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbedPluginCallbacks';
import { parsePlacedViewUrl, type PlacedViewTarget } from '@nimbalyst/runtime/core/placedViewUrl';
import type { CollabEditorMountOptions } from './types';

/** The renderer is global, but document authority and preview ownership are not. */
export const BrowserDocumentEmbedContext = React.createContext<CollabEditorMountOptions['renderDecisionArtifact']>(undefined);

function sharedArtifact(src: string): string | null {
  try {
    if (isCollabUri(src)) {
      parseCollabUri(src);
      return src;
    }
    const url = new URL(src);
    if (url.protocol !== 'nimbalyst:' || url.hostname !== 'doc') return null;
    const path = url.pathname.replace(/^\/+/, '');
    const queryOrgId = url.searchParams.get('orgId');
    if (queryOrgId && path) return buildCollabUri(queryOrgId, decodeURIComponent(path));
    const [orgId, ...documentId] = path.split('/');
    return orgId && documentId.length ? buildCollabUri(decodeURIComponent(orgId), decodeURIComponent(documentId.join('/'))) : null;
  } catch { return null; }
}

/**
 * What a host renders for a placed view; null falls back to the note. `target`
 * is the parsed link, `attrs` the definition from its title.
 */
export type BrowserPlacedViewRenderer = (view: {
  nodeKey: string;
  src: string;
  label: string;
  target: PlacedViewTarget;
  attrs: Readonly<Record<string, string>>;
  onAttrsChange?: (patch: Readonly<Record<string, string | null>>) => void;
}) => React.ReactNode | null;

let placedViewRenderer: BrowserPlacedViewRenderer | null = null;

/**
 * Installs the host's placed-view renderer for every editor this bundle
 * mounts, or removes it with null. A placed view reads the project's tracker
 * items, which only the host has, so the host renders it inside its own
 * tracker provider. Returns a function that removes this renderer.
 */
export function setBrowserPlacedViewRenderer(renderer: BrowserPlacedViewRenderer | null): () => void {
  placedViewRenderer = renderer;
  return () => {
    if (placedViewRenderer === renderer) placedViewRenderer = null;
  };
}

/**
 * A placed view with no host renderer says where the view can be seen, and a
 * console view link links to its own console page.
 */
function BrowserPlacedViewNote({ src, label }: { src: string; label: string }): React.JSX.Element {
  const name = label || 'View';
  const consoleHref = /^https:/i.test(src) ? src : null;
  return <div className="collab-bundle-document-embed" contentEditable={false}>
    <div className="collab-bundle-document-embed-unavailable" data-testid="placed-view-unavailable">
      {name}: this live view shows in the Nimbalyst desktop app.
      {consoleHref ? <> <a href={consoleHref}>Open {name}</a></> : null}
    </div>
  </div>;
}

function BrowserDocumentEmbed({ src, label, nodeKey, attrs }: EmbedFrameProps): React.JSX.Element {
  const render = React.useContext(BrowserDocumentEmbedContext);
  const onAttrsChange = usePlacedViewAttrs(nodeKey);
  const target = parsePlacedViewUrl(src);
  if (target) {
    const view = placedViewRenderer?.({ nodeKey, src, label, target, attrs, onAttrsChange });
    if (!view) return <BrowserPlacedViewNote src={src} label={label} />;
    return target.kind === 'type' ? <PlacedViewResizeFrame attrs={attrs} onAttrsChange={onAttrsChange}>{view}</PlacedViewResizeFrame> : <>{view}</>;
  }
  const artifact = sharedArtifact(src);
  const preview = artifact ? render?.(nodeKey, artifact) : null;
  return <div className="collab-bundle-document-embed" contentEditable={false}>
    {preview ?? <div className="collab-bundle-document-embed-unavailable">{label || 'Shared document'}: preview unavailable in this view.</div>}
  </div>;
}

/** Explicit call keeps registration in the production bundle. */
export function registerBrowserDocumentEmbeds(): void {
  setEmbedPluginCallbacks({ renderEmbed: BrowserDocumentEmbed });
}
