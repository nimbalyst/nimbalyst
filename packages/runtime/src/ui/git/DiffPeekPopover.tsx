import { useEffect, useMemo, useRef } from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  FloatingPortal,
  autoUpdate,
  useDismiss,
  useRole,
  useInteractions,
} from '@floating-ui/react';
import { UnifiedDiffView, diffStats } from './UnifiedDiffView';

export type PopoverMode = 'peek' | 'pinned';

interface DiffPeekPopoverProps {
  anchorRect: DOMRect;
  filePath: string;
  mode: PopoverMode;
  diff: string;
  isBinary: boolean;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onPin: () => void;
  /** Optional. When provided, renders the "Open in editor" link in the header. */
  onOpenInEditor?: () => void;
  /** Controlled width in px. Falls back to a default when omitted. */
  width?: number;
  /** Controlled height in px. Falls back to a default when omitted. */
  height?: number;
  /** Called (debounced) when the user drags the resize handle. */
  onResize?: (size: { width: number; height: number }) => void;
}

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 380;
const RESIZE_DEBOUNCE_MS = 150;

const KBD_CLASS =
  'inline-block py-px px-1 mr-0.5 rounded-sm border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] font-mono text-[9px] leading-none';

export function DiffPeekPopover({
  anchorRect,
  filePath,
  mode,
  diff,
  isBinary,
  loading,
  error,
  onClose,
  onPin,
  onOpenInEditor,
  width,
  height,
  onResize,
}: DiffPeekPopoverProps) {
  const virtualRef = useMemo(() => ({
    getBoundingClientRect: () => anchorRect,
  }), [anchorRect]);

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    elements: { reference: virtualRef as unknown as Element },
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ fallbackPlacements: ['left-start', 'top-start', 'bottom-start'], padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  const dismiss = useDismiss(context, {
    outsidePress: true,
    escapeKey: true,
  });
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const stats = useMemo(() => diffStats(diff), [diff]);
  const filename = filePath.split('/').pop() ?? filePath;
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';

  useEffect(() => {
    if (mode !== 'peek') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onPin();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, onPin]);

  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReportedRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!onResize) return;
    const node = refs.floating.current;
    if (!node) return;
    const initial = node.getBoundingClientRect();
    lastReportedRef.current = {
      width: Math.round(initial.width),
      height: Math.round(initial.height),
    };
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const last = lastReportedRef.current;
      if (last && last.width === w && last.height === h) return;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        lastReportedRef.current = { width: w, height: h };
        onResize({ width: w, height: h });
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [onResize, refs.floating]);

  const sizedStyle: React.CSSProperties = {
    ...floatingStyles,
    width: width ?? DEFAULT_WIDTH,
    height: height ?? DEFAULT_HEIGHT,
  };

  const containerClass = `flex flex-col overflow-hidden outline-none z-[1000] bg-[var(--nim-bg-secondary)] rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.2)] resize min-w-[320px] min-h-[160px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-32px)] border ${
    mode === 'peek'
      ? 'border-dashed border-[var(--nim-primary)]'
      : 'border-[var(--nim-primary)]'
  }`;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={sizedStyle}
        className={containerClass}
        {...getFloatingProps()}
      >
        <div className="flex items-center gap-2 py-2 px-3 border-b border-[var(--nim-border)] bg-[var(--nim-bg)] text-xs">
          <span
            className="flex-1 flex items-baseline gap-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono"
            title={filePath}
          >
            {dir && <span className="text-[var(--nim-text-faint)] text-[11px]">{dir}/</span>}
            <span className="text-[var(--nim-text)] font-semibold">{filename}</span>
          </span>
          <span className="flex gap-1.5 font-mono text-[11px] font-semibold">
            {stats.added > 0 && <span className="text-[var(--nim-success)]">+{stats.added}</span>}
            {stats.removed > 0 && <span className="text-[var(--nim-error)]">−{stats.removed}</span>}
          </span>
          {mode === 'peek' && (
            <span className="text-[10px] tracking-[0.06em] uppercase py-0.5 px-1.5 rounded-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
              Peeking
            </span>
          )}
          {mode === 'pinned' && (
            <span className="text-[10px] tracking-[0.06em] uppercase py-0.5 px-1.5 rounded-sm bg-[color-mix(in_srgb,var(--nim-primary)_25%,transparent)] text-[var(--nim-primary)]">
              Pinned
            </span>
          )}
          {onOpenInEditor && (
            <button
              type="button"
              className="bg-transparent border-0 cursor-pointer text-[var(--nim-primary)] text-[11px] py-0.5 px-1 hover:underline"
              onClick={(e) => { e.stopPropagation(); onOpenInEditor(); }}
            >
              Open in editor
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto bg-[var(--nim-bg)]">
          <UnifiedDiffView diff={diff} isBinary={isBinary} loading={loading} error={error} />
        </div>

        <div className="flex gap-3 py-1.5 px-3 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[10px] text-[var(--nim-text-faint)]">
          <span><kbd className={KBD_CLASS}>Esc</kbd> close</span>
          {mode === 'peek' && <span><kbd className={KBD_CLASS}>Enter</kbd> pin</span>}
        </div>
      </div>
    </FloatingPortal>
  );
}
