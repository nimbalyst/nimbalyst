import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphNodeTypeSchema, ProjectGraphNode } from '../types';
import { getTypeSchema } from '../schema';
import {
  buildPhaseSegments,
  phaseForStatus,
  PHASE_DEFS,
  type PhaseActivityEntry,
  type PhaseSegment,
} from '../timeline/phaseModel';
import { TimelineRuler } from './TimelineRuler';
import { timeSpansOverlap, type TimelineDateRange } from '../timeline/dateRange';

const DAY = 24 * 60 * 60 * 1000;
const GUTTER_W = 224;
const MIN_PX_PER_DAY = 0.25;
const MAX_PX_PER_DAY = 240;
const MAX_ROWS = 1000;

export type TimelineGroupBy = 'none' | 'tag';

interface TimelineViewProps {
  /** Nodes already filtered to the active view's visible types. */
  nodes: ReadonlyArray<ProjectGraphNode>;
  types: GraphNodeTypeSchema[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onNodeDoubleClick?: (node: ProjectGraphNode) => void;
  groupBy: TimelineGroupBy;
  onGroupByChange: (g: TimelineGroupBy) => void;
  dateRange: TimelineDateRange | null;
}

interface Row {
  node: ProjectGraphNode;
  segs: PhaseSegment[];
  start: number;
  end: number;
}

function getActivity(node: ProjectGraphNode): PhaseActivityEntry[] | undefined {
  const data = node.fields?.data as { activity?: unknown } | undefined;
  if (data && Array.isArray(data.activity)) return data.activity as PhaseActivityEntry[];
  return undefined;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDuration(ms: number): string {
  const d = ms / DAY;
  if (d < 1) return `${Math.max(1, Math.round(ms / (60 * 60 * 1000)))}h`;
  if (d < 21) return `${Math.round(d)}d`;
  if (d < 90) return `${Math.round(d / 7)}w`;
  if (d < 730) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export function TimelineView(props: TimelineViewProps) {
  const { nodes, types, selectedNodeId, onSelectNode, onNodeDoubleClick, groupBy, onGroupByChange, dateRange } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nowRef = useRef<number>(Date.now());
  // null pxPerDay = auto-fit to viewport; a number = user has zoomed.
  const [pxPerDay, setPxPerDay] = useState<number | null>(null);
  const [viewW, setViewW] = useState(1000);
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const [showUntagged, setShowUntagged] = useState(true);

  // Measure the scroll viewport so auto-fit knows the available width.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewW(el.clientWidth);
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setViewW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Build per-item phase segments (status-bearing, dated items only) ----
  const allRows = useMemo<Row[]>(() => {
    const now = nowRef.current;
    const rows: Row[] = [];
    for (const node of nodes) {
      // The timeline shows "phased work" -- items with a status. Statusless
      // nodes (commits, files, directories) are not lifecycle items and would
      // otherwise flood the surface with bars-to-now.
      if (!node.status) continue;
      const segs = buildPhaseSegments({
        createdAt: node.createdAt,
        closedAt: node.closedAt,
        status: node.status,
        activity: getActivity(node),
        now,
      });
      if (segs.length === 0) continue;
      rows.push({ node, segs, start: segs[0]!.startMs, end: segs[segs.length - 1]!.endMs });
    }
    rows.sort((a, b) => a.start - b.start);
    return rows;
  }, [nodes]);

  const rangedRows = useMemo(
    () => dateRange
      ? allRows.filter(row => timeSpansOverlap(row.start, row.end, dateRange))
      : allRows,
    [allRows, dateRange],
  );
  const hiddenRowCount = Math.max(0, rangedRows.length - MAX_ROWS);
  const rows = useMemo(() => rangedRows.slice(0, MAX_ROWS), [rangedRows]);

  // ---- Time range across the visible rows (always includes "now") ----
  const range = useMemo(() => {
    if (dateRange) return { min: dateRange.startMs, max: dateRange.endMs };
    const now = nowRef.current;
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      if (r.start < min) min = r.start;
      if (r.end > max) max = r.end;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = now - 30 * DAY;
      max = now;
    }
    max = Math.max(max, now);
    const pad = Math.max((max - min) * 0.02, DAY);
    return { min: min - pad, max: max + pad };
  }, [rows, dateRange]);

  const spanDays = Math.max((range.max - range.min) / DAY, 1);
  const fitPxPerDay = Math.max(
    MIN_PX_PER_DAY,
    Math.min(MAX_PX_PER_DAY, (viewW - GUTTER_W - 24) / spanDays),
  );
  const pxd = pxPerDay ?? fitPxPerDay;
  const contentWidth = spanDays * pxd;
  const xForMs = useCallback((ms: number) => ((ms - range.min) / DAY) * pxd, [range.min, pxd]);
  const todayX = xForMs(nowRef.current);

  // ---- Zoom (Ctrl/Cmd + wheel, cursor-anchored) and shift-wheel pan ----
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const trackX = el.scrollLeft + cursorX - GUTTER_W;
      const tUnder = range.min + (trackX / pxd) * DAY;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.max(MIN_PX_PER_DAY, Math.min(MAX_PX_PER_DAY, pxd * factor));
      setPxPerDay(next);
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (!el2) return;
        const newTrackX = ((tUnder - range.min) / DAY) * next;
        el2.scrollLeft = newTrackX + GUTTER_W - cursorX;
      });
    } else if (e.shiftKey) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
    // plain wheel falls through to native vertical scroll
  }, [range.min, pxd]);

  const zoomBy = useCallback((factor: number) => {
    setPxPerDay(prev => {
      const base = prev ?? fitPxPerDay;
      return Math.max(MIN_PX_PER_DAY, Math.min(MAX_PX_PER_DAY, base * factor));
    });
  }, [fitPxPerDay]);

  // Scroll to "now" on first layout so the live edge is visible.
  const didInitScroll = useRef(false);
  useEffect(() => {
    if (didInitScroll.current || rows.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    didInitScroll.current = true;
    el.scrollLeft = Math.max(0, GUTTER_W + todayX - el.clientWidth + 80);
  }, [rows.length, todayX]);

  // ---- Tag lanes ----
  const lanes = useMemo(() => {
    if (groupBy !== 'tag') return [];
    const byTag = new Map<string, Row[]>();
    const untagged: Row[] = [];
    for (const r of rows) {
      const tags = r.node.tags?.filter(Boolean) ?? [];
      if (tags.length === 0) {
        untagged.push(r);
        continue;
      }
      for (const t of tags) {
        const arr = byTag.get(t) ?? [];
        arr.push(r);
        byTag.set(t, arr);
      }
    }
    const out = Array.from(byTag.entries())
      .map(([tag, members]) => ({ tag, members }))
      .sort((a, b) => b.members.length - a.members.length || a.tag.localeCompare(b.tag));
    if (showUntagged && untagged.length > 0) out.push({ tag: 'Untagged', members: untagged });
    return out;
  }, [groupBy, rows, showUntagged]);

  const toggleTag = useCallback((tag: string) => {
    setExpandedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const renderSegments = (segs: PhaseSegment[], thin = false) =>
    segs.map((s, i) => {
      const visibleStart = Math.max(s.startMs, range.min);
      const visibleEnd = Math.min(s.endMs, range.max);
      if (visibleEnd < visibleStart) return null;
      const left = xForMs(visibleStart);
      const w = Math.max(2, xForMs(visibleEnd) - left);
      const endsNow = s.endMs >= nowRef.current - DAY;
      const title = `${s.statusLabel || s.phaseLabel} · ${fmtDate(s.startMs)} → ${endsNow ? 'now' : fmtDate(s.endMs)} · ${fmtDuration(s.endMs - s.startMs)}`;
      return (
        <div
          key={i}
          className={`pg-tl-seg${thin ? ' is-thin' : ''}`}
          style={{ left, width: w, background: `var(${s.colorVar})` }}
          title={title}
        />
      );
    });

  const renderItemRow = (row: Row, indented = false) => {
    const schema = getTypeSchema(types, row.node.type);
    const selected = row.node.id === selectedNodeId;
    const phaseLabel = row.node.status ? phaseForStatus(row.node.status).label : '';
    return (
      <div
        key={row.node.id}
        className={`pg-tl-row pg-tl-item${selected ? ' is-selected' : ''}${indented ? ' is-indented' : ''}`}
        onClick={() => onSelectNode(row.node.id)}
        onDoubleClick={() => onNodeDoubleClick?.(row.node)}
      >
        <div className="pg-tl-label" style={{ width: GUTTER_W }} title={row.node.label}>
          <span
            className="pg-tl-label-dot"
            style={{ background: schema ? `var(${schema.colorToken})` : 'var(--pg-c-file)' }}
          />
          <span className="pg-tl-label-text">{row.node.label}</span>
          {row.node.status && (
            <span className="pg-tl-label-status" title={`Current: ${row.node.status}`}>{phaseLabel}</span>
          )}
        </div>
        <div className="pg-tl-track" style={{ width: contentWidth }}>
          {renderSegments(row.segs)}
        </div>
      </div>
    );
  };

  const isEmpty = rows.length === 0;

  return (
    <main className="pg-tl">
      {/* toolbar */}
      <div className="pg-tl-toolbar">
        <div className="pg-tl-group" role="tablist" aria-label="Group by">
          <button
            type="button"
            role="tab"
            aria-selected={groupBy === 'none'}
            className={`pg-tl-group-tab${groupBy === 'none' ? ' is-active' : ''}`}
            onClick={() => onGroupByChange('none')}
          >
            Items
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={groupBy === 'tag'}
            className={`pg-tl-group-tab${groupBy === 'tag' ? ' is-active' : ''}`}
            onClick={() => onGroupByChange('tag')}
          >
            By tag
          </button>
        </div>

        {groupBy === 'tag' && (
          <label className="pg-tl-toggle">
            <input type="checkbox" checked={showUntagged} onChange={e => setShowUntagged(e.target.checked)} />
            Untagged
          </label>
        )}

        <div className="pg-tl-legend">
          {PHASE_DEFS.map(p => (
            <span key={p.key} className="pg-tl-legend-item" title={p.label}>
              <span className="pg-tl-legend-dot" style={{ background: `var(${p.colorVar})` }} />
              {p.label}
            </span>
          ))}
        </div>

        <div className="pg-tl-spacer" />

        <div className="pg-tl-zoom">
          <button type="button" className="pg-icon-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>−</button>
          <button type="button" className="pg-icon-btn" title="Fit" onClick={() => { setPxPerDay(null); didInitScroll.current = false; }}>Fit</button>
          <button type="button" className="pg-icon-btn" title="Zoom in" onClick={() => zoomBy(1.4)}>+</button>
        </div>
      </div>

      {/* scrollable surface */}
      <div className="pg-tl-scroll" ref={scrollRef} onWheel={onWheel}>
        {isEmpty ? (
          <div className="pg-tl-empty">
            {dateRange
              ? 'No dated, status-bearing items overlap this time range.'
              : 'No dated, status-bearing items in this view. Try the Everything or Delivery view, or pick item types in the sidebar.'}
          </div>
        ) : (
          <div className="pg-tl-grid" style={{ width: GUTTER_W + contentWidth }}>
            {todayX >= 0 && todayX <= contentWidth && (
              <div className="pg-tl-today" style={{ left: GUTTER_W + todayX }} title="Today" />
            )}

            {/* ruler */}
            <div className="pg-tl-row pg-tl-ruler-row">
              <div className="pg-tl-corner" style={{ width: GUTTER_W }}>
                {rows.length} item{rows.length === 1 ? '' : 's'}
                {hiddenRowCount > 0 && <span className="pg-tl-corner-more">+{hiddenRowCount} hidden</span>}
              </div>
              <TimelineRuler rangeMin={range.min} rangeMax={range.max} pxPerDay={pxd} contentWidth={contentWidth} />
            </div>

            {/* rows */}
            {groupBy === 'none'
              ? rows.map(r => renderItemRow(r))
              : lanes.map(lane => {
                  const expanded = expandedTags.has(lane.tag);
                  return (
                    <div key={lane.tag} className="pg-tl-lane">
                      <div className="pg-tl-row pg-tl-lane-head" onClick={() => toggleTag(lane.tag)}>
                        <div className="pg-tl-label" style={{ width: GUTTER_W }} title={lane.tag}>
                          <span className={`pg-tl-chevron${expanded ? ' is-open' : ''}`}>▸</span>
                          <span className="pg-tl-label-text">{lane.tag}</span>
                          <span className="pg-tl-lane-count">{lane.members.length}</span>
                        </div>
                        <div className="pg-tl-track" style={{ width: contentWidth }}>
                          {!expanded &&
                            lane.members.map(m => {
                              const visibleStart = Math.max(m.start, range.min);
                              const visibleEnd = Math.min(m.end, range.max);
                              if (visibleEnd < visibleStart) return null;
                              const left = xForMs(visibleStart);
                              const w = Math.max(2, xForMs(visibleEnd) - left);
                              return (
                                <div
                                  key={m.node.id}
                                  className="pg-tl-heat"
                                  style={{ left, width: w }}
                                  title={`${m.node.label} · ${fmtDate(m.start)} → ${fmtDate(m.end)}`}
                                />
                              );
                            })}
                        </div>
                      </div>
                      {expanded && lane.members.map(m => renderItemRow(m, true))}
                    </div>
                  );
                })}
          </div>
        )}
      </div>

      <div className="pg-tl-tip">
        <kbd>⌘ scroll</kbd> zoom
        <span>·</span>
        <kbd>⇧ scroll</kbd> pan
        <span>·</span>
        <kbd>scroll</kbd> rows
      </div>
    </main>
  );
}
