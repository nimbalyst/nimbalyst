/**
 * The rendered link preview: a bookmark card, or the site's player when the
 * link is `preview=embed` and its URL is on the allowlist.
 *
 * Iframe rules: the `src` is always the URL `resolveExternalEmbed` built, on
 * the provider's origin, never the authored URL. The frame is sandboxed;
 * `allow-same-origin` keeps the player on its own origin (players need their
 * own storage), which is never the app's origin, so the frame cannot reach
 * the editor. Navigation out of the frame opens in the system browser through
 * the app's window-open guard.
 *
 * A player has the shared block resizer's bottom-right grip. It keeps
 * its aspect ratio, so a drag saves only `width=` in the link title; dragged
 * to the column's edge (or a double-clicked grip) removes it to fill the
 * column. A card gets the same grip for its width; its height follows its text.
 */

import React, { useEffect, useRef, useState, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { $getNodeByKey, type NodeKey } from 'lexical';

import type { EmbedAttrs } from '../EmbedPlugin/EmbeddedFileNodeCore';
import { $isEmbeddedFileNode } from '../EmbedPlugin/EmbeddedFileNodeCore';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import BlockResizer from '../../ui/BlockResizer';
import { PlacedViewResizeFrame } from '../EmbedPlugin/PlacedViewResizeFrame';
import { parseWebUrl, resolveExternalEmbed } from './externalEmbeds';
import { getLinkPreviewCallbacks, type LinkPreviewMetadata } from './LinkPreviewCallbacks';
import { $setPreviewAttr } from './linkPreviewInsert';
import { getLinkPreviewMode, LINK_PREVIEW_ATTR, type LinkPreviewMode } from './linkPreviewLinks';

const MIN_PLAYER_WIDTH = 240;

/** The player's saved width in px, or undefined to fill the column. */
export function parsePlayerWidth(value: string | undefined): number | undefined {
  const parsed = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, MIN_PLAYER_WIDTH) : undefined;
}

const metadataRequests = new Map<string, Promise<LinkPreviewMetadata | null>>();

function requestMetadata(url: string): Promise<LinkPreviewMetadata | null> {
  let request = metadataRequests.get(url);
  if (!request) {
    const host = getLinkPreviewCallbacks().fetchLinkPreview;
    const electronAPI = (window as unknown as { electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }).electronAPI;
    const fetcher = host
      ?? (electronAPI ? (target: string) => electronAPI.invoke('link-preview:fetch', { url: target }) as Promise<LinkPreviewMetadata | null> : null);
    request = fetcher ? fetcher(url).catch(() => null) : Promise.resolve(null);
    metadataRequests.set(url, request);
  }
  return request;
}

function useLinkMetadata(url: string, enabled: boolean): LinkPreviewMetadata | null | undefined {
  const [state, setState] = useState<{ url: string; data: LinkPreviewMetadata | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void requestMetadata(url).then((data) => {
      if (live) setState({ url, data });
    });
    return () => {
      live = false;
    };
  }, [url, enabled]);
  return state?.url === url ? state.data : undefined;
}

export interface LinkPreviewBlockProps {
  src: string;
  label: string;
  attrs: EmbedAttrs;
  nodeKey: NodeKey;
}

export function LinkPreviewBlock({ src, label, attrs, nodeKey }: LinkPreviewBlockProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const [isResizing, setIsResizing] = useState(false);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const mode = getLinkPreviewMode(attrs) ?? 'card';
  const embed = mode === 'embed' ? resolveExternalEmbed(src) : null;
  const metadata = useLinkMetadata(src, !embed);
  const url = parseWebUrl(src);
  const host = url?.hostname.replace(/^www\./, '') ?? src;

  const setAttr = (key: string, value: string | null) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isEmbeddedFileNode(node)) $setPreviewAttr(node, key, value);
    });
  };
  const setMode = (next: LinkPreviewMode) => setAttr(LINK_PREVIEW_ATTR, next);

  const onResizeEnd = (width: number) => {
    setIsResizing(false);
    const player = playerRef.current;
    const column = player?.parentElement?.clientWidth ?? Infinity;
    // Dragged out to the column's edge means "fill the column", not a fixed width.
    const fill = width >= column - 1;
    if (player) {
      // The aspect ratio sets the height; the saved title owns the width now.
      player.style.height = '';
      if (fill) player.style.width = '';
    }
    setAttr('width', fill ? null : String(Math.round(width)));
  };
  const resetWidth = () => {
    if (playerRef.current) {
      playerRef.current.style.width = '';
      playerRef.current.style.height = '';
    }
    setAttr('width', null);
  };

  const select = (event: React.MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('a,button,iframe')) return;
    if (!event.shiftKey) clearSelection();
    setSelected(true);
  };

  const switchButton = editable && resolveExternalEmbed(src) ? (
    <button
      type="button"
      className="link-preview-mode ml-auto shrink-0 cursor-pointer border-none bg-transparent p-0 text-[11px] text-nim-link hover:underline"
      data-testid="link-preview-mode"
      onClick={() => setMode(embed ? 'card' : 'embed')}
    >
      {embed ? 'Show as card' : 'Show player'}
    </button>
  ) : null;

  const outline = isSelected ? 'outline outline-2 outline-[var(--nim-border-focus)]' : '';

  if (embed) {
    const width = parsePlayerWidth(attrs.width);
    return (
      <div
        ref={playerRef}
        className={`link-preview-block link-preview-embed relative my-3 max-w-full rounded-lg border border-nim bg-nim-secondary p-2 ${outline}`}
        style={width === undefined ? undefined : { width: `${width}px` }}
        contentEditable={false}
        data-testid="link-preview-embed"
        data-provider={embed.provider}
        onClick={select}
      >
        <div className="relative w-full overflow-hidden rounded" style={{ aspectRatio: String(embed.aspectRatio) }}>
          <iframe
            // The frame would swallow the pointer moves of a drag.
            className={`absolute inset-0 h-full w-full border-0 ${isResizing ? 'pointer-events-none' : ''}`}
            src={embed.embedUrl}
            title={label || embed.contentName}
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            loading="lazy"
          />
        </div>
        <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-nim-faint">
          <a className="truncate text-nim-link hover:underline" href={src} target="_blank" rel="noopener noreferrer">{label || src}</a>
          {switchButton}
        </div>
        {editable ? (
          <BlockResizer
            editor={editor}
            targetRef={playerRef}
            handles="corner"
            minWidth={MIN_PLAYER_WIDTH}
            maxWidth={playerRef.current?.parentElement?.clientWidth}
            onResizeStart={() => setIsResizing(true)}
            onResizeEnd={onResizeEnd}
            onReset={resetWidth}
          />
        ) : null}
      </div>
    );
  }

  const title = metadata?.title || (label && label !== src ? label : host);
  const siteName = metadata?.siteName || host;
  const cardAttrs: Record<string, string> = attrs.width ? { width: attrs.width } : {};
  const onCardSize = editable ? (patch: Readonly<Record<string, string | null>>) => {
    if ('width' in patch) setAttr('width', patch.width ?? null);
  } : undefined;
  return (
    <PlacedViewResizeFrame attrs={cardAttrs} onAttrsChange={onCardSize}>
    <div className={`link-preview-block link-preview-card my-3 flex max-w-full overflow-hidden rounded-lg border border-nim bg-nim-secondary ${outline}`} contentEditable={false} data-testid="link-preview-card" onClick={select}>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2">
        <a className="link-preview-title truncate text-sm font-medium text-nim hover:underline" href={src} target="_blank" rel="noopener noreferrer">{title}</a>
        {metadata?.description ? (
          <div className="link-preview-description line-clamp-2 text-xs text-nim-muted select-text">{metadata.description}</div>
        ) : null}
        <div className="mt-auto flex min-w-0 items-center gap-1.5 text-[11px] text-nim-faint">
          {metadata?.favicon ? (
            <img className="h-3.5 w-3.5 shrink-0" src={metadata.favicon.startsWith('data:image/') ? metadata.favicon : ''} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
          ) : (
            <MaterialSymbol icon="link" size={14} />
          )}
          <span className="truncate">{siteName}</span>
          {metadata === undefined ? <span className="shrink-0">Loading preview...</span> : null}
          {switchButton}
        </div>
      </div>
    </div>
    </PlacedViewResizeFrame>
  );
}
