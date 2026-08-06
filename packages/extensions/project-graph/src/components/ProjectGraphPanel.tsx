import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import type { GraphNodeTypeSchema, GraphViewDefinition, ProjectGraphNode, ProjectGraphSnapshot } from '../types';
import { BUILTIN_NODE_TYPES, BUILTIN_VIEWS, TRACKER_CATEGORY } from '../schema';
import { loadProjectGraphConfig, type ResolvedProjectGraphConfig } from '../config';
import { loadProjectSnapshot, type GraphLayoutMode, type SnapshotDiagnostics } from '../adapters/loader';
import type { LayoutClusterInfo } from '../adapters/layout';
import { GraphSidebar } from './GraphSidebar';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import { GraphInspector } from './GraphInspector';
import { Minimap } from './Minimap';
import { TimelineStrip } from './TimelineStrip';
import { TimelineView, type TimelineGroupBy } from './TimelineView';
import { TimelineRangeBar } from './TimelineRangeBar';
import type { TimelineDateRange } from '../timeline/dateRange';
import {
  IconArrow,
  IconClock,
  IconFit,
  IconGraph,
  IconHand,
  IconLasso,
  IconLayout,
  IconMinus,
  IconPlus,
  IconShare,
} from './icons';

const STORAGE_KEYS = {
  hiddenTypes: 'project-graph.hiddenTypes',
  activeView: 'project-graph.activeViewId',
  customViews: 'project-graph.customViews',
  mode: 'project-graph.mode',
  timelineGroupBy: 'project-graph.timelineGroupBy',
  layoutMode: 'project-graph.layoutMode',
} as const;

type PanelMode = 'graph' | 'timeline';

function computeWorldBounds(snapshot: ProjectGraphSnapshot, clusters: LayoutClusterInfo[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  // Prefer cluster rectangles since they account for the full halo + label area.
  for (const c of clusters) {
    if (c.x < minX) minX = c.x;
    if (c.headerY < minY) minY = c.headerY;
    if (c.x + c.width > maxX) maxX = c.x + c.width;
    if (c.y + c.height > maxY) maxY = c.y + c.height;
  }
  if (!isFinite(minX)) {
    for (const n of snapshot.nodes) {
      if (typeof n.x === 'number' && typeof n.y === 'number') {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
    }
  }
  if (!isFinite(minX)) {
    minX = 0; minY = 0; maxX = 1200; maxY = 800;
  }
  const padX = 80, padY = 60;
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

/** "feature-request" -> "Feature Request". Fallback label for type-def-less types. */
function humanizeType(type: string): string {
  return type
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const EMPTY_SNAPSHOT: ProjectGraphSnapshot = {
  generatedAt: 0,
  nodes: [],
  edges: [],
  stats: { nodeCount: 0, edgeCount: 0, countsByType: {} },
};

export function ProjectGraphPanel({ host }: PanelHostProps) {
  // Snapshot is loaded from the adapter pipeline (git, plans, docs, github).
  // Until adapters resolve, we render an empty graph with a loading badge.
  const [snapshot, setSnapshot] = useState<ProjectGraphSnapshot>(EMPTY_SNAPSHOT);
  const [diagnostics, setDiagnostics] = useState<SnapshotDiagnostics | null>(null);
  const [clusters, setClusters] = useState<LayoutClusterInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Resolved config = built-ins + discovered tracker type defs + project file.
  const [config, setConfig] = useState<ResolvedProjectGraphConfig>({
    types: BUILTIN_NODE_TYPES,
    views: BUILTIN_VIEWS,
    extraCategories: [],
    colorOverrides: {},
    hasProjectConfig: false,
    configPath: '.nimbalyst/project-graph.json',
  });

  useEffect(() => {
    let cancelled = false;
    void loadProjectGraphConfig(host).then(resolved => {
      if (!cancelled) setConfig(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  // 'inventory' = deterministic per-type grid; 'map' = force-directed connected
  // core with isolated nodes parked beneath.
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>(
    () => host.storage.get<GraphLayoutMode>(STORAGE_KEYS.layoutMode) ?? 'inventory',
  );
  useEffect(() => { void host.storage.set(STORAGE_KEYS.layoutMode, layoutMode); }, [host.storage, layoutMode]);

  // Pass the resolved type schemas into the loader so the deterministic layout
  // clusters custom tracker types under their real category instead of "system".
  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const { snapshot: snap, diagnostics: diag, clusters: cls } = await loadProjectSnapshot(host, config.types, layoutMode);
      setSnapshot(snap);
      setDiagnostics(diag);
      setClusters(cls);
    } finally {
      setIsLoading(false);
    }
  }, [host, config.types, layoutMode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Dev-only: expose snapshot for debugging via renderer_eval.
  useEffect(() => {
    (window as unknown as { __pgSnapshot?: ProjectGraphSnapshot }).__pgSnapshot = snapshot;
  }, [snapshot]);

  // Every type PRESENT in the data must have a schema so the sidebar can render
  // a toggle for it. config.types already covers built-ins + tracker type defs;
  // this backfills any straggler type that has items but no def row (e.g. a
  // type whose def was deleted) so it stays toggleable rather than stuck-on.
  const types = useMemo<GraphNodeTypeSchema[]>(() => {
    const known = new Set(config.types.map(t => t.type));
    const extra: GraphNodeTypeSchema[] = [];
    for (const type of Object.keys(snapshot.stats.countsByType)) {
      if (known.has(type)) continue;
      extra.push({
        type,
        label: humanizeType(type),
        category: TRACKER_CATEGORY,
        colorToken: '--pg-c-file',
        shape: 'pill',
        quickActions: ['open'],
      });
    }
    return extra.length > 0 ? [...config.types, ...extra] : config.types;
  }, [config.types, snapshot.stats.countsByType]);
  const allViews = useMemo(() => {
    const stored = host.storage.get<typeof BUILTIN_VIEWS>(STORAGE_KEYS.customViews) ?? [];
    const byId = new Map(config.views.map(v => [v.id, v] as const));
    for (const v of stored) byId.set(v.id, v);
    return Array.from(byId.values());
  }, [host.storage, config.views]);

  const [activeViewId, setActiveViewId] = useState<string>(() => {
    return host.storage.get<string>(STORAGE_KEYS.activeView) ?? 'everything';
  });

  const activeView = useMemo<GraphViewDefinition>(() => {
    return allViews.find(v => v.id === activeViewId) ?? allViews[0]!;
  }, [allViews, activeViewId]);

  // Hidden types are stored as a list; visible types is the complement against
  // the active view's includedTypes (or all types if the view has none).
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => {
    const stored = host.storage.get<string[]>(STORAGE_KEYS.hiddenTypes);
    return new Set(stored ?? []);
  });

  const visibleTypes = useMemo<Set<string>>(() => {
    const baseTypes: string[] = activeView.includedTypes ?? types.map(t => t.type);
    return new Set(baseTypes.filter(t => !hiddenTypes.has(t)));
  }, [activeView, types, hiddenTypes]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Graph vs. Timeline mode. Timeline reuses the same visible-types filter but
  // renders a Gantt-style surface instead of the Sigma canvas.
  const [mode, setMode] = useState<PanelMode>(() => host.storage.get<PanelMode>(STORAGE_KEYS.mode) ?? 'graph');
  const [timelineGroupBy, setTimelineGroupBy] = useState<TimelineGroupBy>(
    () => host.storage.get<TimelineGroupBy>(STORAGE_KEYS.timelineGroupBy) ?? 'none',
  );
  const [timelineDateRange, setTimelineDateRange] = useState<TimelineDateRange | null>(null);
  const [isTimeRangeOpen, setIsTimeRangeOpen] = useState(false);
  useEffect(() => { void host.storage.set(STORAGE_KEYS.mode, mode); }, [host.storage, mode]);
  useEffect(() => { void host.storage.set(STORAGE_KEYS.timelineGroupBy, timelineGroupBy); }, [host.storage, timelineGroupBy]);

  // Nodes filtered to the active view's visible types (the timeline needs the
  // pre-filtered set; the Sigma canvas filters internally via reducers).
  // For the "Everything" view (no includedTypes) we include every type present
  // in the data -- even custom tracker types (e.g. idea, blog) that have no
  // built-in schema entry -- since that's exactly where status-change history
  // lives. Named views still respect their includedTypes list.
  const timelineNodes = useMemo(() => {
    if (activeView.includedTypes == null) {
      return snapshot.nodes.filter(n => !hiddenTypes.has(n.type));
    }
    return snapshot.nodes.filter(n => visibleTypes.has(n.type));
  }, [snapshot.nodes, activeView, hiddenTypes, visibleTypes]);

  // Sigma owns the camera now; we only mirror zoom percent for the UI readout.
  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [viewport, setViewport] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 1200, h: 800 });

  // ---------- Timeline state ----------
  // Range = [earliest createdAt, max(latest createdAt, latest closedAt, now)].
  // Default currentTime sits at `range.max` so the initial render is identical
  // to the no-timeline version — the user opts in by dragging back.
  const timeRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const n of snapshot.nodes) {
      if (n.createdAt != null) {
        if (n.createdAt < min) min = n.createdAt;
        if (n.createdAt > max) max = n.createdAt;
      }
      if (n.closedAt != null && n.closedAt > max) max = n.closedAt;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: Date.now() - 30 * 24 * 60 * 60 * 1000, max: Date.now() };
    }
    return { min, max };
  }, [snapshot.nodes]);

  const [currentTime, setCurrentTime] = useState<number>(timeRange.max);
  const [playing, setPlaying] = useState(false);
  // Default speed = fit-60s. When snapshot reloads we re-pick it.
  const [speed, setSpeed] = useState<number>(() => Math.max(1, (timeRange.max - timeRange.min) / 60));

  // When a new snapshot lands, snap the playhead to `max` (live) and re-pick a
  // fit-60s speed for the new span. Without this, the playhead would stick at
  // the old `max` after refresh.
  const lastSnapshotIdRef = useRef<number>(snapshot.generatedAt);
  useEffect(() => {
    if (snapshot.generatedAt === lastSnapshotIdRef.current) return;
    lastSnapshotIdRef.current = snapshot.generatedAt;
    setCurrentTime(timeRange.max);
    setSpeed(Math.max(1, (timeRange.max - timeRange.min) / 60));
  }, [snapshot.generatedAt, timeRange.min, timeRange.max]);

  // RAF play loop. Advances currentTime by `speed * realElapsedSec` until it
  // hits `timeRange.max`, then auto-pauses.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCurrentTime(prev => {
        const next = prev + speed * dt;
        if (next >= timeRange.max) {
          setPlaying(false);
          return timeRange.max;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, timeRange.max]);

  // If the user hits play while at the end, rewind to the start so something
  // visibly happens.
  const handleTogglePlay = useCallback(() => {
    setPlaying(prev => {
      if (!prev && currentTime >= timeRange.max - 1) {
        setCurrentTime(timeRange.min);
      }
      return !prev;
    });
  }, [currentTime, timeRange.min, timeRange.max]);

  const handleScrub = useCallback((t: number) => {
    setCurrentTime(t);
    setPlaying(false);
  }, []);

  // Only constrain the canvas by time when the user has scrubbed off the
  // live end. At t = max we pass `null` so the canvas reducers skip the
  // time gate entirely.
  const timeFilter = currentTime >= timeRange.max ? null : currentTime;

  // Persist user state.
  useEffect(() => { void host.storage.set(STORAGE_KEYS.activeView, activeViewId); }, [host.storage, activeViewId]);
  useEffect(() => { void host.storage.set(STORAGE_KEYS.hiddenTypes, Array.from(hiddenTypes)); }, [host.storage, hiddenTypes]);

  // Filter visible nodes by search query as well -- if a search query is set,
  // mute all non-matching nodes via visibleTypes intersection.
  // (Filtering happens inside the canvas via the types filter; search affects
  // selection: pressing Enter on a search match selects the first hit.)
  const onToggleType = useCallback((type: string) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const onSetGroupHidden = useCallback((typesInGroup: string[], hidden: boolean) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      for (const t of typesInGroup) {
        if (hidden) next.add(t);
        else next.delete(t);
      }
      return next;
    });
  }, []);

  const onSelectView = useCallback((id: string) => {
    setActiveViewId(id);
    setSelectedNodeId(null);
    // Each saved view starts from its own clean included-types set; clear any
    // manual per-type hides carried over from the previous view.
    setHiddenTypes(new Set());
  }, []);

  // Global Show all / Hide all. "Hide all" hides every type present in the data
  // (the only ones with rows); "Show all" clears the hidden set entirely.
  const onSetAllHidden = useCallback((hidden: boolean) => {
    setHiddenTypes(hidden ? new Set(Object.keys(snapshot.stats.countsByType)) : new Set());
  }, [snapshot.stats.countsByType]);

  const onNodeDoubleClick = useCallback((node: ProjectGraphNode) => {
    const raw = typeof node.fields?.path === 'string' ? (node.fields.path as string) : null;
    if (!raw) return;
    // Commits store the hash in fields.path; only open if it looks like a file.
    if (node.type === 'commit') return;
    const absolute = raw.startsWith('/') ? raw : `${host.workspacePath.replace(/\/$/, '')}/${raw}`;
    host.openFile(absolute);
  }, [host]);

  const onNodeAction = useCallback((action: string, node: ProjectGraphNode) => {
    // Until the action plane is wired to real services, surface the action in
    // the host's panel logs. Open-file is the one action we can do today via
    // the host API.
    if (action === 'open-file' && typeof node.fields?.path === 'string') {
      host.openFile(node.fields.path);
      return;
    }
    if (action.startsWith('expand:')) {
      const childType = action.slice('expand:'.length);
      setHiddenTypes(prev => {
        if (!prev.has(childType)) return prev;
        const next = new Set(prev);
        next.delete(childType);
        return next;
      });
      return;
    }
    // For all other actions, leave a console breadcrumb. A future PR will
    // route them through host IPC to TrackerService, SessionService, etc.
    // eslint-disable-next-line no-console
    console.log('[project-graph] node action', action, node);
  }, [host]);

  // Search: jump to first matching node.
  const onSearchSubmit = useCallback(() => {
    if (!searchQuery.trim()) return;
    const q = searchQuery.toLowerCase();
    const match = snapshot.nodes.find(n => n.label.toLowerCase().includes(q));
    if (match) setSelectedNodeId(match.id);
  }, [searchQuery, snapshot.nodes]);

  const worldBounds = useMemo(() => computeWorldBounds(snapshot, clusters), [snapshot, clusters]);

  // Bounds restricted to the currently-visible clusters (driven by the active view + hidden types).
  const visibleBounds = useMemo(() => {
    const visibleClusters = clusters.filter(c => visibleTypes.has(c.type));
    if (visibleClusters.length === 0) return worldBounds;
    return computeWorldBounds(snapshot, visibleClusters);
  }, [snapshot, clusters, visibleTypes, worldBounds]);

  const canvasWrapRef = useRef<HTMLElement | null>(null);

  const handleFit = useCallback(() => canvasRef.current?.fit(), []);

  // F key fits to view, but only when typing in an input is not active.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      const ae = document.activeElement;
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || (ae instanceof HTMLElement && ae.isContentEditable)) {
        return;
      }
      if (!canvasWrapRef.current) return;
      const rect = canvasWrapRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      e.preventDefault();
      handleFit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleFit]);

  // Inject any project-defined color tokens onto the panel root so SVG
  // children can resolve `var(--pg-c-custom-foo)` via the colorToken.
  const rootStyle = useMemo<CSSProperties>(() => {
    if (Object.keys(config.colorOverrides).length === 0) return {};
    return config.colorOverrides as unknown as CSSProperties;
  }, [config.colorOverrides]);

  return (
    <div className="pg-root" style={rootStyle} onKeyDown={(e) => {
      if (e.key === 'Enter' && document.activeElement instanceof HTMLInputElement) {
        onSearchSubmit();
      }
    }}>
      {/* ===== TOP BAR ===== */}
      <div className="pg-header-stack">
      <header className="pg-topbar">
        <div className="pg-crumb">
          <div className="pg-crumb-icon">
            <IconGraph stroke="white" strokeWidth={2.4} />
          </div>
          <span className="pg-crumb-title">Project Graph</span>
          <span className="pg-crumb-sep">/</span>
          <span className="pg-crumb-scope">{host.workspacePath.split('/').filter(Boolean).pop() ?? 'workspace'}</span>
        </div>

        <div className="pg-mode-switch" role="tablist" aria-label="View mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'graph'}
            className={`pg-mode-tab${mode === 'graph' ? ' is-active' : ''}`}
            onClick={() => setMode('graph')}
          >
            Graph
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'timeline'}
            className={`pg-mode-tab${mode === 'timeline' ? ' is-active' : ''}`}
            onClick={() => setMode('timeline')}
          >
            Timeline
          </button>
        </div>

        <div className="pg-spacer" />

        <div className="pg-views" role="tablist">
          {allViews.map(view => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={view.id === activeViewId}
              className={`pg-view-tab${view.id === activeViewId ? ' is-active' : ''}`}
              onClick={() => onSelectView(view.id)}
              title={view.description}
            >
              <span className="pg-dot" />
              {view.name}
            </button>
          ))}
        </div>

        <div className="pg-spacer" />

        <div className="pg-top-actions">
          <button
            type="button"
            className={`pg-icon-btn${timelineDateRange ? ' is-active' : ''}`}
            title={timelineDateRange ? 'Edit timeline time range' : 'Filter timeline by time range'}
            aria-label="Filter timeline by time range"
            aria-expanded={isTimeRangeOpen}
            onClick={() => {
              setMode('timeline');
              setIsTimeRangeOpen(open => !open);
            }}
          >
            <IconClock />
          </button>
          <button className="pg-icon-btn" title="Layout"><IconLayout /></button>
          <button className="pg-icon-btn" title="Share view"><IconShare /></button>
        </div>
      </header>
      {isTimeRangeOpen && (
        <TimelineRangeBar
          range={timelineDateRange}
          onChange={setTimelineDateRange}
          onClose={() => setIsTimeRangeOpen(false)}
        />
      )}
      </div>

      {/* ===== MAIN ===== */}
      <div className="pg-main">
        <GraphSidebar
          snapshot={snapshot}
          types={types}
          extraCategories={config.extraCategories}
          visibleTypes={visibleTypes}
          onToggleType={onToggleType}
          onSetGroupHidden={onSetGroupHidden}
          onSetAllHidden={onSetAllHidden}
          views={allViews}
          activeViewId={activeViewId}
          onSelectView={onSelectView}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />

        {mode === 'graph' ? (
        <main className="pg-canvas-wrap" ref={canvasWrapRef}>
          <div className="pg-grid-bg" />

          {/* canvas controls (top-left) */}
          <div className="pg-canvas-toolbar">
            <div className="pg-toolbar-group">
              <button className="pg-icon-btn" title="Select"><IconArrow /></button>
              <button className="pg-icon-btn" title="Pan"><IconHand /></button>
              <button className="pg-icon-btn" title="Lasso"><IconLasso /></button>
            </div>
            <div className="pg-label-pill">
              <span className="pg-dot" />
              {selectedNodeId ? `Focus: ${snapshot.nodes.find(n => n.id === selectedNodeId)?.label ?? 'node'}` : `View: ${activeView.name}`}
            </div>
            <div className="pg-layout-switch" role="tablist" aria-label="Layout">
              <button
                type="button"
                role="tab"
                aria-selected={layoutMode === 'map'}
                className={`pg-layout-tab${layoutMode === 'map' ? ' is-active' : ''}`}
                onClick={() => setLayoutMode('map')}
                title="Force-directed map of the connected graph"
              >
                Map
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={layoutMode === 'inventory'}
                className={`pg-layout-tab${layoutMode === 'inventory' ? ' is-active' : ''}`}
                onClick={() => setLayoutMode('inventory')}
                title="Deterministic per-type grid"
              >
                Inventory
              </button>
            </div>
          </div>

          {/* legend (top-right) */}
          <div className="pg-legend">
            <div className="pg-legend-title">
              <span>Rollup</span>
              <span>Quality health</span>
            </div>
            <div className="pg-legend-row">
              <span style={{ width: 64, color: 'var(--pg-text-mute)' }}>Critical</span>
              <span className="pg-legend-bar" />
              <span style={{ width: 50, color: 'var(--pg-text-mute)', textAlign: 'right' }}>Healthy</span>
            </div>
            <div className="pg-legend-pills">
              <span className="pg-pill is-bug">{snapshot.stats.countsByType.bug ?? 0} open</span>
              <span className="pg-pill is-warn">4 high</span>
              <span className="pg-pill is-good">68% solved</span>
            </div>
          </div>

          <GraphCanvas
            ref={canvasRef}
            snapshot={snapshot}
            clusters={clusters}
            types={types}
            visibleTypes={visibleTypes}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onNodeAction={onNodeAction}
            onNodeDoubleClick={onNodeDoubleClick}
            visibleBounds={visibleBounds}
            currentTime={timeFilter}
            onCameraRatioChange={(r) => setZoomPercent(Math.round((1 / r) * 100))}
            onViewportChange={setViewport}
          />

          {/* zoom controls (bottom-left) */}
          <div className="pg-canvas-zoom">
            <button className="pg-icon-btn" onClick={() => canvasRef.current?.zoomIn()} title="Zoom in"><IconPlus /></button>
            <div className="pg-zoom-level">{zoomPercent}%</div>
            <button className="pg-icon-btn" onClick={() => canvasRef.current?.zoomOut()} title="Zoom out"><IconMinus /></button>
            <button className="pg-icon-btn" onClick={handleFit} title="Fit"><IconFit /></button>
          </div>

          <Minimap
            snapshot={snapshot}
            types={types}
            viewport={viewport}
            worldBounds={worldBounds}
          />

          <div className="pg-canvas-tip">
            <kbd>Space</kbd> pan
            <span>·</span>
            <kbd>⌘ scroll</kbd> zoom
            <span>·</span>
            <kbd>F</kbd> fit
            <span>·</span>
            <kbd>E</kbd> expand children
          </div>
        </main>
        ) : (
          <TimelineView
            nodes={timelineNodes}
            types={types}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onNodeDoubleClick={onNodeDoubleClick}
            groupBy={timelineGroupBy}
            onGroupByChange={setTimelineGroupBy}
            dateRange={timelineDateRange}
          />
        )}

        <GraphInspector
          snapshot={snapshot}
          types={types}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          onAction={onNodeAction}
        />
      </div>

      {/* ===== TIMELINE SCRUBBER (graph mode only) ===== */}
      {mode === 'graph' && (
        <TimelineStrip
          nodes={snapshot.nodes}
          range={timeRange}
          currentTime={currentTime}
          onChange={handleScrub}
          playing={playing}
          onTogglePlay={handleTogglePlay}
          speed={speed}
          onSpeedChange={setSpeed}
        />
      )}

      {/* ===== STATUS BAR ===== */}
      <footer className="pg-statusbar">
        <div className="pg-seg">
          <span className="pg-live-dot" style={{ background: isLoading ? 'var(--pg-warn)' : 'var(--pg-good)' }} />
          {isLoading ? 'loading adapters…' : 'live · last updated just now'}
        </div>
        <div className="pg-seg">
          <span className="pg-badge">{snapshot.stats.nodeCount} nodes</span>
          <span className="pg-badge">{snapshot.stats.edgeCount} edges</span>
          <span className="pg-badge">{activeView.name}</span>
          {timelineDateRange && mode === 'timeline' && <span className="pg-badge">time range filtered</span>}
          {config.hasProjectConfig && (
            <span className="pg-badge" title={config.configPath}>+ project config</span>
          )}
          {diagnostics?.adapters.map(a => (
            <span
              key={a.id}
              className="pg-badge"
              title={a.message ?? `${a.nodes} nodes · ${a.edges} edges`}
              style={a.status === 'error'
                ? { color: 'var(--pg-bad)' }
                : a.status === 'unavailable'
                  ? { color: 'var(--pg-text-mute)' }
                  : undefined}
            >
              {a.label}: {a.status === 'ok' ? a.nodes : a.status}
            </span>
          ))}
          <button
            type="button"
            className="pg-badge"
            onClick={() => void refresh()}
            disabled={isLoading}
            style={{ cursor: 'pointer' }}
          >
            ⟳ refresh
          </button>
        </div>
        <div className="pg-spacer" />
        <div className="pg-seg">workspace: {host.workspacePath.split('/').slice(-2).join('/')}</div>
      </footer>
    </div>
  );
}
