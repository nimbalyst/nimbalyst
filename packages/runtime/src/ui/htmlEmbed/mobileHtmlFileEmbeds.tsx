/**
 * `.html` embeds for the iOS and Android markdown editors.
 *
 * A link alone in its paragraph, `[Label](diagram.html "height=400")`,
 * becomes an embed once `.html` is registered as embeddable; this module
 * registers it and supplies the renderer. The phone has no file system the
 * web view can read, so the renderer asks native for the synced copy by the
 * path written in the link (`readEmbedFile`), and native answers through
 * `resolve`. The content renders through the same sandbox shell as desktop
 * (`HtmlEmbedFrame`), which native serves at `shellUrl`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { EmbedFrameProps } from '../../editor/plugins/EmbedPlugin/EmbedPluginCallbacks';
import { setEmbedPluginCallbacks } from '../../editor/plugins/EmbedPlugin/EmbedPluginCallbacks';
import { setEmbeddableExtensions } from '../../editor/plugins/EmbedPlugin/embeddableExtensions';
import { HtmlEmbedFrame } from './HtmlEmbedFrame';
import { readHtmlEmbedTheme } from './htmlEmbedTheme';

import './mobileHtmlFileEmbeds.css';

/** Above this a fixed height from the link title is ignored on a phone screen. */
const MAX_MOBILE_EMBED_HEIGHT = 2000;
const MIN_MOBILE_EMBED_HEIGHT = 80;

export interface MobileHtmlEmbedHost {
  /** Ask native for the file at `src` (as written in the link); answered by `resolve(requestId, ...)`. */
  requestFile(requestId: number, src: string): void;
  /** URL of the sandbox shell native serves with `HTML_EMBED_SHELL_CSP`. */
  shellUrl: string;
  /** A link tapped inside the embed, already filtered by `classifyEmbedHref`. */
  openLink(href: string): void;
}

export interface MobileHtmlEmbeds {
  /** Native's answer: the file's text, or null with the reason it could not be read. */
  resolve(requestId: number, content: string | null, error?: string): void;
}

type FileResult = { text: string; error: null } | { text: null; error: string };

/** Request/response pairing for `readEmbedFile`; exported for tests. */
export function createEmbedFileRequests(send: (requestId: number, src: string) => void) {
  let nextId = 1;
  const pending = new Map<number, (result: FileResult) => void>();
  return {
    request(src: string): Promise<FileResult> {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send(id, src);
      });
    },
    resolve(requestId: number, content: string | null, error?: string): void {
      const settle = pending.get(requestId);
      if (!settle) return;
      pending.delete(requestId);
      settle(typeof content === 'string' ? { text: content, error: null } : { text: null, error: error || 'File not found' });
    },
  };
}

export function parseMobileEmbedHeight(value: string | undefined): number | undefined {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.max(parsed, MIN_MOBILE_EMBED_HEIGHT), MAX_MOBILE_EMBED_HEIGHT);
}

export function installMobileHtmlEmbeds(host: MobileHtmlEmbedHost): MobileHtmlEmbeds {
  const requests = createEmbedFileRequests((id, src) => host.requestFile(id, src));

  const MobileHtmlFileEmbed: React.FC<EmbedFrameProps> = ({ src, label, attrs }) => {
    const [result, setResult] = useState<FileResult | null>(null);
    // The mobile apps are dark only.
    const theme = useMemo(() => readHtmlEmbedTheme('dark'), []);
    const height = parseMobileEmbedHeight(attrs.height);

    useEffect(() => {
      let cancelled = false;
      setResult(null);
      void requests.request(src).then((next) => {
        if (!cancelled) setResult(next);
      });
      return () => {
        cancelled = true;
      };
    }, [src]);

    const onNavigate = useCallback((href: string) => host.openLink(href), []);

    return (
      <div className="mobile-html-embed" contentEditable={false} data-embed-src={src}>
        {result === null ? (
          <div className="mobile-html-embed__placeholder">Loading {label || src}…</div>
        ) : result.error !== null ? (
          <div className="mobile-html-embed__placeholder mobile-html-embed__placeholder--error">
            <span>{result.error}</span>
            <code>{src}</code>
          </div>
        ) : (
          <HtmlEmbedFrame html={result.text} shellUrl={host.shellUrl} onNavigate={onNavigate} theme={theme} height={height} title={label || src} />
        )}
      </div>
    );
  };

  setEmbeddableExtensions(['.html']);
  setEmbedPluginCallbacks({ renderEmbed: MobileHtmlFileEmbed });
  return { resolve: requests.resolve };
}
