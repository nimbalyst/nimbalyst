/**
 * Page info: a document's properties (its frontmatter) and the sources it
 * cites, beside the page instead of above and below it. Opened from the
 * header's info button; closed by default.
 */

import React, { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { LexicalEditor } from 'lexical';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { FrontmatterProperties, type FrontmatterPropertiesProps } from '@nimbalyst/runtime/plugins/FrontmatterPlugin/FrontmatterProperties';
import { detectTrackerFromFrontmatter } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import { useCitationIndex } from '@nimbalyst/runtime/editor/plugins/CitationPlugin/citationIndex';
import { useResizeDragShield } from '../../hooks/useResizeDragShield';
import {
  PAGE_INFO_PANEL_MAX_WIDTH,
  clampPageInfoPanelWidth,
  pageInfoPanelWidthAtom,
  setPageInfoPanelWidth,
  usePageInfoPanelOpen,
} from './pageInfoPanelState';

const CitationSourcesList = lazy(() => import('@nimbalyst/runtime/editor/plugins/CitationPlugin/CitationSourcesList'));

export interface PageInfoPanelProps {
  editor: LexicalEditor | null;
  /** The document's frontmatter; absent for documents without any (shared pages). */
  properties?: FrontmatterPropertiesProps;
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="page-info-section border-b border-nim px-3.5 pb-4 pt-3">
      <h3 className="m-0 mb-2.5 flex items-center text-[11px] font-normal uppercase tracking-wider text-nim-faint">
        {title}
        {count !== undefined && count > 0 && <span className="ml-auto normal-case tracking-normal">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

export function PageInfoPanel({ editor, properties }: PageInfoPanelProps) {
  const [open, setOpen] = usePageInfoPanelOpen();
  const { citations } = useCitationIndex(open ? editor : null);
  const contentVersion = properties?.contentVersion;
  const getContent = properties?.getContent;
  // A tracker document's frontmatter is edited in its header.
  const showProperties = useMemo(
    () => Boolean(getContent) && detectTrackerFromFrontmatter(getContent!()) === null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getContent, contentVersion],
  );

  const savedWidth = useAtomValue(pageInfoPanelWidthAtom);
  const [draggingWidth, setDraggingWidth] = useState<number | null>(null);
  const dragRef = useRef({ startX: 0, startWidth: savedWidth, latestWidth: savedWidth });
  const startResizeDrag = useResizeDragShield({
    onMove: (event) => {
      // The panel is on the right, so dragging left widens it.
      const next = clampPageInfoPanelWidth(dragRef.current.startWidth - (event.clientX - dragRef.current.startX));
      dragRef.current.latestWidth = next;
      setDraggingWidth(next);
    },
    onEnd: () => {
      setDraggingWidth(null);
      setPageInfoPanelWidth(dragRef.current.latestWidth);
    },
  });
  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    dragRef.current = { startX: event.clientX, startWidth: savedWidth, latestWidth: savedWidth };
    startResizeDrag(event);
  }, [savedWidth, startResizeDrag]);

  if (!open) return null;
  return (
    <>
    <div
      className="page-info-panel-resize-handle relative z-10 w-1 shrink-0 cursor-col-resize bg-nim-secondary"
      onPointerDown={handleResizePointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Page info"
      data-testid="page-info-panel-resize"
    >
      <div className="mx-auto h-full w-0.5 bg-nim-border transition-colors duration-200 hover:bg-nim-accent" />
    </div>
    <aside
      className="page-info-panel flex shrink-0 flex-col overflow-y-auto bg-nim-secondary"
      // A drag clamps to the min; the cap keeps a narrow column's editor usable.
      style={{ width: draggingWidth ?? savedWidth, maxWidth: `min(50%, ${PAGE_INFO_PANEL_MAX_WIDTH}px)` }}
      data-testid="page-info-panel"
    >
      <div className="page-info-header flex items-center border-b border-nim px-3.5 py-2 text-[13px] font-semibold text-nim">
        Page info
        <button
          type="button"
          className="ml-auto flex border-none bg-transparent p-0.5 text-nim-faint hover:text-nim"
          onClick={() => setOpen(false)}
          aria-label="Close Page info"
        >
          <MaterialSymbol icon="close" size={16} />
        </button>
      </div>
      {properties && showProperties && (
        <Section title="Properties">
          <FrontmatterProperties {...properties} />
        </Section>
      )}
      <Section title="Sources" count={citations.length}>
        {editor ? (
          <Suspense fallback={null}>
            <CitationSourcesList editor={editor} />
          </Suspense>
        ) : null}
      </Section>
    </aside>
    </>
  );
}
