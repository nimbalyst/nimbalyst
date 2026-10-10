/**
 * The rendered transclusion: a header naming the source page with an "Open"
 * action, and the section itself in a nested read-only editor so charts,
 * chips, callouts and further transclusions render as they do on the source.
 * The host pushes every change to the source page; the section is re-cut and
 * applied in place.
 *
 * Nesting is bounded: each block adds its page to `TransclusionChainContext`,
 * and a block whose page is already in the chain, or that sits
 * `MAX_TRANSCLUSION_DEPTH` transclusions deep, renders a notice instead.
 */

import React, { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $getNodeByKey, type LexicalEditor } from 'lexical';

import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { parseEmbedAttrs } from '../EmbedPlugin/embedAttrs';
import { setTitleAttr } from '../EmbedPlugin/embedTitle';
import { PlacedViewResizeFrame } from '../EmbedPlugin/PlacedViewResizeFrame';
import { useBlockActions } from '../DraggableBlockPlugin/useBlockActions';
import { applyExternalMarkdown } from '../../applyExternalMarkdown';
import { getTransclusionHost, type TransclusionSourceState } from './transclusionHost';
import {
  checkTransclusionNesting,
  parseTransclusionHref,
  transclusionTargetKey,
  type ParsedTransclusionHref,
} from './transclusionLink';
import { extractTransclusionSection } from './transclusionSection';
import { $downgradeTransclusionToLink, $isTransclusionNode } from './TransclusionNodeCore';

interface TransclusionChain {
  keys: readonly string[];
  depth: number;
}

const TransclusionChainContext = createContext<TransclusionChain>({ keys: [], depth: 0 });

// Lazy: the full editor would otherwise load with every graph that registers
// the built-in extensions (tests, light hosts), and it imports this module.
const NimbalystEditor = lazy(() => import('../../NimbalystEditor').then((module) => ({ default: module.NimbalystEditor })));

function useSourceState(link: ParsedTransclusionHref | null, enabled: boolean): TransclusionSourceState | null {
  const [state, setState] = useState<TransclusionSourceState | null>(null);
  useEffect(() => {
    const host = getTransclusionHost();
    if (!link || !enabled || !host) {
      setState(null);
      return;
    }
    setState({ status: 'loading' });
    return host.subscribe(link, setState);
    // `link` is re-derived from the href each render; key on the href.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.pageHref, enabled]);
  return state;
}

function noticeFor(state: TransclusionSourceState | null, hasHost: boolean, anchor: string | null, sectionMissing: boolean): string | null {
  if (!hasHost) return 'Transcluded content is not available here. Open the page to read it.';
  if (!state || state.status === 'loading') return null;
  switch (state.status) {
    case 'missing':
      return state.message ?? 'This page no longer exists, or it is not on this device.';
    case 'no-access':
      return state.message ?? 'You do not have access to this page.';
    case 'error':
      return state.message;
    case 'ready':
      return sectionMissing ? `The section "#${anchor}" is no longer on this page.` : null;
  }
}

function TransclusionBody({ markdown }: { markdown: string }): React.JSX.Element {
  const editorRef = useRef<LexicalEditor | null>(null);
  const initialRef = useRef(markdown);
  const appliedRef = useRef(markdown);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || appliedRef.current === markdown) return;
    appliedRef.current = markdown;
    applyExternalMarkdown(editor, markdown);
  }, [markdown]);

  const onEditorReady = useCallback((editor: LexicalEditor) => {
    editorRef.current = editor;
    if (appliedRef.current !== initialRef.current) applyExternalMarkdown(editor, appliedRef.current);
  }, []);

  return (
    <Suspense fallback={null}>
      <NimbalystEditor
        config={{
          initialContent: initialRef.current,
          isRichText: true,
          editable: false,
          showToolbar: false,
          onEditorReady,
        }}
      />
    </Suspense>
  );
}

export function TransclusionBlock({ href, label, title, nodeKey }: { href: string; label: string; title: string; nodeKey: string }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const chain = useContext(TransclusionChainContext);
  const link = useMemo(() => parseTransclusionHref(href), [href]);
  const key = link ? transclusionTargetKey(link.target) : null;
  const guard = key ? checkTransclusionNesting(chain.keys, chain.depth, key) : 'ok';
  const host = getTransclusionHost();
  const state = useSourceState(link, guard === 'ok');

  const section = useMemo(() => {
    if (!link || state?.status !== 'ready') return null;
    return extractTransclusionSection(state.markdown, link.anchor);
  }, [link, state]);

  const childChain = useMemo<TransclusionChain>(
    () => ({ keys: key ? [...chain.keys, key] : chain.keys, depth: chain.depth + 1 }),
    [chain, key],
  );

  const open = useCallback((event: React.MouseEvent) => {
    if (!link || !host) return;
    event.preventDefault();
    host.open(link, { href, newTab: event.metaKey || event.ctrlKey });
  }, [host, href, link]);

  const onBodyClick = useCallback((event: React.MouseEvent) => {
    // Let links and buttons inside the section act, and never navigate away
    // from a text selection the user is making.
    if ((event.target as HTMLElement).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    open(event);
  }, [open]);

  const unlink = useCallback(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isTransclusionNode(node)) $downgradeTransclusionToLink(node);
    });
  }, [editor, nodeKey]);

  useBlockActions(nodeKey, {
    open: link && host ? () => host.open(link, { href, newTab: false }) : null,
  });

  const sourceTitle = (state?.status === 'ready' ? state.title : null) || label || href;
  // Width and body height from the corner grip, saved as `width=` / `height=` in the link title.
  const sizeAttrs = useMemo(() => {
    const { width, height } = parseEmbedAttrs(title);
    return { ...(width ? { width } : {}), ...(height ? { height } : {}) };
  }, [title]);
  const bodyHeight = sizeAttrs.height && Number(sizeAttrs.height) > 0 ? `${Number(sizeAttrs.height)}px` : undefined;
  const onSizeChange = editable ? (patch: Readonly<Record<string, string | null>>) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isTransclusionNode(node)) return;
      let next = node.getTitle();
      for (const [key, value] of Object.entries(patch)) next = setTitleAttr(next, key, value);
      node.setTitle(next);
    });
  } : undefined;
  const heading = section?.status === 'ok' ? section.heading : null;
  const notice = guard === 'cycle'
    ? 'This page is already shown above; it is not repeated here.'
    : guard === 'too-deep'
      ? 'Transclusions nest too deeply to show here.'
      : noticeFor(state, !!host, link?.anchor ?? null, section?.status === 'missing-section');

  return (
    <PlacedViewResizeFrame attrs={sizeAttrs} onAttrsChange={onSizeChange}>
    <div className="transclusion-block my-3 rounded-lg border border-nim bg-nim-secondary" contentEditable={false} data-transclusion-href={href}>
      <div className="transclusion-block-header flex items-center gap-2 border-b border-nim px-3 py-1.5 text-xs text-nim-faint">
        <MaterialSymbol icon="format_quote" size={16} />
        <a
          className="transclusion-block-source min-w-0 truncate text-nim-link no-underline hover:underline"
          href={href}
          onClick={open}
          title={heading ? `${sourceTitle} > ${heading}` : sourceTitle}
        >
          {sourceTitle}
          {heading ? <span className="text-nim-faint">{` > ${heading}`}</span> : null}
        </a>
        <span className="flex-1" />
        {editable ? (
          <button type="button" className="transclusion-block-unlink text-nim-faint hover:text-nim" onClick={unlink} title="Show as a link">
            <MaterialSymbol icon="link" size={16} />
          </button>
        ) : null}
        {host && link ? (
          <button type="button" className="transclusion-block-open text-nim-faint hover:text-nim" onClick={open} title="Open the source page">
            <MaterialSymbol icon="open_in_new" size={16} />
          </button>
        ) : null}
      </div>
      {notice ? (
        <div className="transclusion-block-notice px-3 py-2 text-sm text-nim-faint">{notice}</div>
      ) : section?.status === 'ok' ? (
        <div className={`transclusion-block-body cursor-pointer px-3 ${bodyHeight ? 'overflow-auto' : ''}`} style={bodyHeight ? { height: bodyHeight } : undefined} onClick={onBodyClick} data-placed-view-body="">
          <TransclusionChainContext.Provider value={childChain}>
            <TransclusionBody markdown={section.markdown} />
          </TransclusionChainContext.Provider>
        </div>
      ) : (
        <div className="transclusion-block-loading px-3 py-2 text-sm text-nim-faint">Loading...</div>
      )}
    </div>
    </PlacedViewResizeFrame>
  );
}
