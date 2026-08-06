import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import type { Settings } from 'sigma/settings';
import type { NodeDisplayData, PartialButFor } from 'sigma/types';
import type { ProjectGraphNode, ProjectGraphSnapshot } from '../types';
import { getTypeSchema } from '../schema';
import type { GraphNodeTypeSchema } from '../types';
import type { LayoutClusterInfo } from '../adapters/layout';
import { DomActionRing } from './DomActionRing';

export interface GraphCanvasHandle {
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
  getZoomPercent(): number;
}

interface GraphCanvasProps {
  snapshot: ProjectGraphSnapshot;
  clusters: LayoutClusterInfo[];
  types: GraphNodeTypeSchema[];
  visibleTypes: ReadonlySet<string>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onNodeAction: (action: string, node: ProjectGraphNode) => void;
  onNodeDoubleClick: (node: ProjectGraphNode) => void;
  /** Approx world bounds for the current view (already padded). */
  visibleBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * Playhead in epoch ms. When set, nodes with `createdAt > currentTime` are
   * hidden, and nodes whose `closedAt <= currentTime` desaturate. `null` = no
   * gating (live view, all nodes visible).
   */
  currentTime: number | null;
  /** Camera ratio change notification (1.0 means a 1:1 mapping; lower = more zoomed-in). */
  onCameraRatioChange?: (ratio: number) => void;
  /** Approximate visible world rectangle. */
  onViewportChange?: (rect: { x: number; y: number; w: number; h: number }) => void;
}

const EDGE_COLOR: Record<string, string> = {
  contains: '#3d4763',
  implements: '#3a5b66',
  worked_on_in: '#ff5a6e',
  edited_in: '#5a6478',
  generated: '#5a6478',
  references: '#5a6478',
  closes: '#5a6478',
  requested_by: '#ff9ec1',
  owned_by: '#84e0c6',
  related_to: '#ff5a6e',
  planned_by: '#3d4763',
  designed_by: '#3d4763',
  touches: '#3a4660',
};

/**
 * Sigma-ready hex colors. The schema's `colorToken` references a CSS var; for
 * Sigma we need a literal color string, so we resolve known tokens here.
 */
const TYPE_COLOR: Record<string, string> = {
  '--pg-c-objective': '#ffd47a',
  '--pg-c-initiative': '#f4a574',
  '--pg-c-project': '#6aa8ff',
  '--pg-c-module': '#58c4dc',
  '--pg-c-feature': '#4fd1a3',
  '--pg-c-plan': '#b9d36b',
  '--pg-c-decision': '#d8b06a',
  '--pg-c-architecture': '#7ab3ff',
  '--pg-c-strategy': '#c9a8ff',
  '--pg-c-task': '#93b3d8',
  '--pg-c-bug': '#ff5a6e',
  '--pg-c-bug-high': '#ff3346',
  '--pg-c-incident': '#ff8a3d',
  '--pg-c-github-issue': '#b078e8',
  '--pg-c-github-pr': '#56c5ff',
  '--pg-c-commit': '#7b85a3',
  '--pg-c-session': '#ffb84d',
  '--pg-c-workstream': '#ffd87a',
  '--pg-c-doc': '#8290a8',
  '--pg-c-file': '#5b6478',
  '--pg-c-customer': '#ff9ec1',
  '--pg-c-collaborator': '#84e0c6',
};

const CATEGORY_HALO_COLOR: Record<string, string> = {
  strategy: 'rgba(201,168,255,0.10)',
  delivery: 'rgba(255,90,110,0.08)',
  knowledge: 'rgba(130,144,168,0.08)',
  people: 'rgba(132,224,198,0.08)',
  external: 'rgba(88,196,220,0.08)',
  system: 'rgba(120,128,150,0.06)',
};

function resolveTypeColor(schema: GraphNodeTypeSchema | undefined): string {
  if (!schema) return '#9aa3b6';
  return TYPE_COLOR[schema.colorToken] ?? '#9aa3b6';
}

/** Sigma node display size by node shape. */
function sizeForShape(schema: GraphNodeTypeSchema | undefined, isBugSeverity: boolean): number {
  const shape = schema?.shape ?? 'pill';
  switch (shape) {
    case 'card': return 9;
    case 'pill': return 6;
    case 'dot': return isBugSeverity ? 6 : 4;
    case 'hex': return 7;
    case 'stack': return 6;
    default: return 5;
  }
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(props, ref) {
  const {
    snapshot,
    clusters,
    types,
    visibleTypes,
    selectedNodeId,
    onSelectNode,
    onNodeAction,
    onNodeDoubleClick,
    visibleBounds,
    onCameraRatioChange,
    onViewportChange,
    currentTime,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const haloCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [tickCount, setTickCount] = useState(0); // bump to trigger DOM overlay reposition

  // Theme-aware label colors. We read the CSS vars from the panel root so the
  // canvas labels follow whatever Nimbalyst theme is active (light/dark/custom).
  // Default values are the dark-theme fallbacks from styles.css.
  const themeColorsRef = useRef({
    text: '#e6e8ee',
    textDim: '#9aa3b6',
    textMute: '#6b7388',
    hoverBg: '#161a23',
    hoverBorder: '#2d3548',
  });

  // Refs that the reducers / event handlers close over. We update refs instead
  // of recreating Sigma when these change.
  const selectedRef = useRef<string | null>(selectedNodeId);
  const hoveredRef = useRef<string | null>(null);
  const visibleTypesRef = useRef<ReadonlySet<string>>(visibleTypes);
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
  const clustersRef = useRef<LayoutClusterInfo[]>(clusters);
  const typesRef = useRef<GraphNodeTypeSchema[]>(types);
  const onSelectRef = useRef(onSelectNode);
  const onDoubleClickRef = useRef(onNodeDoubleClick);
  const snapshotRef = useRef(snapshot);
  const onCameraRatioChangeRef = useRef(onCameraRatioChange);
  const onViewportChangeRef = useRef(onViewportChange);
  // Time gating: per-node createdAt/closedAt looked up by id, plus the live
  // playhead. The map is built once per snapshot and read inside the hot
  // reducer path, so a Map is faster than scanning snapshot.nodes each call.
  const nodeTimesRef = useRef<Map<string, { createdAt?: number; closedAt?: number }>>(new Map());
  const currentTimeRef = useRef<number | null>(currentTime);

  useEffect(() => { selectedRef.current = selectedNodeId; sigmaRef.current?.refresh(); }, [selectedNodeId]);
  useEffect(() => { visibleTypesRef.current = visibleTypes; sigmaRef.current?.refresh(); }, [visibleTypes]);
  useEffect(() => { clustersRef.current = clusters; redrawHalos(); }, [clusters]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { typesRef.current = types; }, [types]);
  useEffect(() => { onSelectRef.current = onSelectNode; }, [onSelectNode]);
  useEffect(() => { onDoubleClickRef.current = onNodeDoubleClick; }, [onNodeDoubleClick]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { onCameraRatioChangeRef.current = onCameraRatioChange; }, [onCameraRatioChange]);
  useEffect(() => { onViewportChangeRef.current = onViewportChange; }, [onViewportChange]);
  useEffect(() => { currentTimeRef.current = currentTime; sigmaRef.current?.refresh(); }, [currentTime]);

  // Build the per-id time lookup when the snapshot changes.
  useEffect(() => {
    const map = new Map<string, { createdAt?: number; closedAt?: number }>();
    for (const n of snapshot.nodes) {
      if (n.createdAt != null || n.closedAt != null) {
        map.set(n.id, { createdAt: n.createdAt, closedAt: n.closedAt });
      }
    }
    nodeTimesRef.current = map;
  }, [snapshot.nodes]);

  // Compute adjacency once per snapshot — drives the dim logic.
  useEffect(() => {
    const map = new Map<string, Set<string>>();
    for (const e of snapshot.edges) {
      const a = map.get(e.sourceId) ?? new Set<string>();
      a.add(e.targetId);
      map.set(e.sourceId, a);
      const b = map.get(e.targetId) ?? new Set<string>();
      b.add(e.sourceId);
      map.set(e.targetId, b);
    }
    adjacencyRef.current = map;
  }, [snapshot.edges]);

  // Rebuild the graph whenever the snapshot changes.
  useEffect(() => {
    const graph = new Graph({ type: 'directed', multi: true, allowSelfLoops: false });
    for (const n of snapshot.nodes) {
      if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
      const schema = getTypeSchema(types, n.type);
      const isBugSeverity = n.type === 'bug' && (n.severity === 'critical' || n.severity === 'high');
      graph.addNode(n.id, {
        // Sigma reads x/y in graph coords; we flip y because Sigma's coordinate
        // system has y growing upward by default while our layout has y growing
        // downward.
        x: n.x,
        y: -n.y,
        size: sizeForShape(schema, isBugSeverity),
        color: resolveTypeColor(schema),
        label: n.label,
        nimType: n.type,
        nimSchema: schema,
        nimSeverity: isBugSeverity,
      });
    }
    for (const e of snapshot.edges) {
      if (!graph.hasNode(e.sourceId) || !graph.hasNode(e.targetId)) continue;
      try {
        graph.addEdgeWithKey(e.id, e.sourceId, e.targetId, {
          color: EDGE_COLOR[e.type] ?? '#3d4763',
          size: e.type === 'related_to' || e.type === 'worked_on_in' ? 1.2 : 0.7,
          nimType: e.type,
          nimLabel: e.label,
        });
      } catch {
        // Ignore duplicate edge keys -- adapter dedupe should make this rare.
      }
    }
    graphRef.current = graph;
    sigmaRef.current?.setGraph(graph);
    sigmaRef.current?.refresh();
    redrawHalos();
  }, [snapshot, types]); // eslint-disable-line react-hooks/exhaustive-deps

  // Instantiate Sigma once.
  useEffect(() => {
    if (!containerRef.current || sigmaRef.current) return;
    const graph = graphRef.current ?? new Graph({ type: 'directed', multi: true });
    graphRef.current = graph;

    // Seed theme colors before sigma initial render so labels paint correctly
    // on first paint (light theme without this would show pale text on white).
    readThemeColors();

    // Custom hover label drawer. The default `drawDiscNodeHover` hardcodes a
    // white background with a black shadow, which is unreadable in dark themes
    // and clashes with custom themes. We draw a rounded rect using --pg-bg-2
    // (matches the panel surface) and use the theme's text color.
    const drawThemedNodeHover = (
      context: CanvasRenderingContext2D,
      data: PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'>,
      ctxSettings: Settings,
    ): void => {
      const size = ctxSettings.labelSize;
      const font = ctxSettings.labelFont;
      const weight = ctxSettings.labelWeight;
      context.font = `${weight} ${size}px ${font}`;
      if (typeof data.label !== 'string') return;

      const PADDING_X = 6;
      const PADDING_Y = 4;
      const textWidth = context.measureText(data.label).width;
      const boxW = Math.round(textWidth + PADDING_X * 2);
      const boxH = Math.round(size + PADDING_Y * 2);
      const radius = 5;
      // Position the label box to the right of the node, vertically centered.
      const gap = Math.max(4, data.size + 4);
      const x = data.x + gap;
      const y = data.y - boxH / 2;

      context.save();
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 2;
      context.shadowBlur = 8;
      context.shadowColor = 'rgba(0,0,0,0.35)';
      context.fillStyle = themeColorsRef.current.hoverBg;
      roundRect(context, x, y, boxW, boxH, radius);
      context.fill();
      context.restore();

      context.strokeStyle = themeColorsRef.current.hoverBorder;
      context.lineWidth = 1;
      roundRect(context, x + 0.5, y + 0.5, boxW - 1, boxH - 1, radius);
      context.stroke();

      context.fillStyle = themeColorsRef.current.text;
      context.textBaseline = 'middle';
      context.fillText(data.label, x + PADDING_X, y + boxH / 2);
    };

    const settings: Partial<Settings> = {
      labelFont: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif',
      labelSize: 11,
      labelWeight: '600',
      labelColor: { color: themeColorsRef.current.text },
      labelDensity: 0.4,
      labelGridCellSize: 80,
      labelRenderedSizeThreshold: 7,
      defaultNodeColor: '#9aa3b6',
      defaultEdgeColor: '#3d4763',
      edgeLabelColor: { color: themeColorsRef.current.textDim },
      defaultDrawNodeHover: drawThemedNodeHover,
      edgeLabelSize: 9,
      renderEdgeLabels: false,
      minCameraRatio: 0.05,
      maxCameraRatio: 20,
      enableEdgeEvents: false,
      nodeReducer: (node, data) => {
        const res = { ...data } as Record<string, unknown>;
        const visible = visibleTypesRef.current.has(data.nimType as string);
        const ratio = sigmaRef.current?.getCamera().ratio ?? 1;
        // LOD thresholds are calibrated for the customBBox we set on fit:
        // ratio = 1 means "fit-to-view"; ratio < 1 zooms in, ratio > 1 zooms out.
        const isFile = data.nimType === 'file';
        const isCommit = data.nimType === 'commit';
        if (!visible) { res.hidden = true; return res; }
        // Time gating: hide nodes that haven't been "born" yet. Nodes with no
        // known createdAt always render (we can't gate what we don't know).
        const t = currentTimeRef.current;
        const times = t != null ? nodeTimesRef.current.get(node as string) : undefined;
        if (t != null && times?.createdAt != null && times.createdAt > t) {
          res.hidden = true;
          return res;
        }
        // Post-close fade: bug closed / session completed before currentTime.
        // Mark a flag here; the dim happens after the focus logic so dim+focus
        // compose deterministically.
        const isPostClose = t != null && times?.closedAt != null && times.closedAt <= t;
        // Hide files past 1x fit (they're noise at scale).
        if (isFile && ratio >= 0.9) { res.hidden = true; return res; }
        // Hide commit dots when fully zoomed-out.
        if (isCommit && ratio >= 1.4) { res.hidden = true; return res; }
        const sel = selectedRef.current;
        const hov = hoveredRef.current;
        const focus = sel ?? hov;
        // Hide labels by default — Sigma's label density does a good job once
        // labels are allowed. Suppress all labels at low zoom.
        if (ratio > 0.7) {
          res.label = '';
        }
        // Force label for focused node + neighbors at most zooms
        if (focus && (focus === node || adjacencyRef.current.get(focus)?.has(node as string))) {
          res.forceLabel = true;
        }
        // Highlighting + dimming
        if (focus) {
          if (focus === node) {
            res.highlighted = true;
            res.size = (data.size as number) * 1.4;
          } else if (adjacencyRef.current.get(focus)?.has(node as string)) {
            // adjacent — keep normal
          } else {
            // dim
            res.color = dimColor(data.color as string, sel ? 0.18 : 0.45);
            res.label = '';
          }
        }
        // Apply post-close fade after focus handling so it stacks: a closed
        // node is desaturated regardless of focus.
        if (isPostClose) {
          res.color = dimColor((res.color as string) ?? (data.color as string), 0.28);
        }
        return res;
      },
      edgeReducer: (edge, data) => {
        const res = { ...data } as Record<string, unknown>;
        const graph = graphRef.current;
        if (!graph) return res;
        const src = graph.source(edge as string);
        const tgt = graph.target(edge as string);
        // Hide edges whose endpoint hasn't been born yet under the current
        // playhead. Without this, edges render as orphaned lines because
        // Sigma's hidden-node logic doesn't propagate to edge endpoints.
        const t = currentTimeRef.current;
        if (t != null) {
          const ts = nodeTimesRef.current.get(src as string);
          const tt = nodeTimesRef.current.get(tgt as string);
          if ((ts?.createdAt != null && ts.createdAt > t) ||
              (tt?.createdAt != null && tt.createdAt > t)) {
            res.hidden = true;
            return res;
          }
        }
        const sel = selectedRef.current;
        const hov = hoveredRef.current;
        const focus = sel ?? hov;
        if (!focus) return res;
        if (src === focus || tgt === focus) {
          res.color = themeColorsRef.current.text;
          res.size = ((data.size as number) ?? 1) * 2.2;
          res.zIndex = 2;
        } else {
          res.color = dimColor(data.color as string, sel ? 0.18 : 0.5);
        }
        return res;
      },
    };

    const sigma = new Sigma(graph, containerRef.current, settings);
    sigmaRef.current = sigma;
    // Dev-only: expose for debugging in renderer_eval.
    (window as unknown as { __pgSigma?: Sigma }).__pgSigma = sigma;

    // Halo layer behind the edges layer.
    const halo = sigma.createCanvas('halos', { beforeLayer: 'edges' });
    halo.style.pointerEvents = 'none';
    haloCanvasRef.current = halo;

    sigma.on('afterRender', () => {
      redrawHalos();
      // Bump tickCount so DOM overlays reposition.
      setTickCount(t => t + 1);
    });

    sigma.on('clickNode', ({ node }) => {
      onSelectRef.current(node);
    });
    sigma.on('doubleClickNode', ({ node, event }) => {
      event.preventSigmaDefault?.();
      const n = snapshotRef.current.nodes.find(x => x.id === node);
      if (n) onDoubleClickRef.current(n);
    });
    sigma.on('enterNode', ({ node }) => {
      hoveredRef.current = node;
      setHoveredNodeId(node);
      sigma.refresh();
    });
    sigma.on('leaveNode', () => {
      hoveredRef.current = null;
      setHoveredNodeId(null);
      sigma.refresh();
    });
    sigma.on('clickStage', () => {
      onSelectRef.current(null);
    });
    // Camera moves should retrigger overlay position.
    sigma.getCamera().on('updated', () => {
      setTickCount(t => t + 1);
      sigma.refresh();
      onCameraRatioChangeRef.current?.(sigma.getCamera().ratio);
      if (onViewportChangeRef.current) {
        try {
          const rect = sigma.viewRectangle();
          // Y axis is flipped relative to layout coords.
          onViewportChangeRef.current({
            x: rect.x1,
            y: -rect.y2,
            w: rect.x2 - rect.x1,
            h: rect.y2 - rect.y1,
          });
        } catch {
          // viewRectangle may throw before first render — ignore.
        }
      }
    });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
      haloCanvasRef.current = null;
    };
  }, []);

  const visibleBoundsRef = useRef(visibleBounds);
  useEffect(() => { visibleBoundsRef.current = visibleBounds; }, [visibleBounds]);

  const doFit = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const b = visibleBoundsRef.current;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w <= 0 || h <= 0) return;
    const dim = sigma.getDimensions();
    if (dim.width === 0 || dim.height === 0) return;
    // Set a custom bbox covering visible world. With customBBox set and camera
    // x=y=0.5, ratio=1, the camera frames exactly that bbox.
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    sigma.setCustomBBox({
      x: [cx - w / 2, cx + w / 2],
      y: [-(cy + h / 2), -(cy - h / 2)],
    });
    sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 240 });
    sigma.scheduleRefresh();
  }, []);

  useImperativeHandle(ref, () => ({
    fit: () => doFit(),
    zoomIn: () => {
      const cam = sigmaRef.current?.getCamera();
      if (!cam) return;
      const st = cam.getState();
      cam.animate({ ...st, ratio: Math.max(0.05, st.ratio / 1.25) }, { duration: 120 });
    },
    zoomOut: () => {
      const cam = sigmaRef.current?.getCamera();
      if (!cam) return;
      const st = cam.getState();
      cam.animate({ ...st, ratio: Math.min(20, st.ratio * 1.25) }, { duration: 120 });
    },
    getZoomPercent: () => {
      const r = sigmaRef.current?.getCamera().ratio ?? 1;
      return Math.round((1 / r) * 100);
    },
  }), [doFit]);

  // Auto-fit on first snapshot load. We watch node count → 0-to-non-zero.
  const didAutoFitRef = useRef(false);
  useEffect(() => {
    if (didAutoFitRef.current) return;
    if (snapshot.nodes.length === 0) return;
    if (!sigmaRef.current) return;
    didAutoFitRef.current = true;
    // Schedule on the next tick so Sigma has dimensions.
    requestAnimationFrame(() => doFit());
  }, [snapshot.nodes.length, doFit]);

  // Wheel handler at the container level: shift+wheel = horizontal pan,
  // plain wheel (when not over a node) pans vertically. ctrl+wheel = zoom is
  // handled by Sigma itself.
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) return; // sigma handles zoom
    const sigma = sigmaRef.current;
    if (!sigma) return;
    e.preventDefault();
    const cam = sigma.getCamera();
    const dim = sigma.getDimensions();
    const state = cam.getState();
    // 1 unit of camera state x/y == one viewport span.
    const dx = e.shiftKey ? (e.deltaX !== 0 ? e.deltaX : e.deltaY) / dim.width : e.deltaX / dim.width;
    const dy = e.shiftKey ? 0 : e.deltaY / dim.height;
    cam.setState({ x: state.x + dx, y: state.y - dy });
  }, []);

  // Escape clears selection.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedRef.current) {
        onSelectRef.current(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  function readThemeColors() {
    const el = containerRef.current;
    if (!el) return false;
    const cs = getComputedStyle(el);
    const text = cs.getPropertyValue('--pg-text').trim() || '#e6e8ee';
    const textDim = cs.getPropertyValue('--pg-text-dim').trim() || '#9aa3b6';
    const textMute = cs.getPropertyValue('--pg-text-mute').trim() || '#6b7388';
    // Hover label background uses the panel surface so it blends with whatever
    // theme is active; the border uses --pg-border-strong for a faint frame.
    const hoverBg = cs.getPropertyValue('--pg-bg-2').trim() || '#161a23';
    const hoverBorder = cs.getPropertyValue('--pg-border-strong').trim() || '#2d3548';
    const prev = themeColorsRef.current;
    if (
      prev.text === text && prev.textDim === textDim && prev.textMute === textMute &&
      prev.hoverBg === hoverBg && prev.hoverBorder === hoverBorder
    ) return false;
    themeColorsRef.current = { text, textDim, textMute, hoverBg, hoverBorder };
    return true;
  }

  // React to theme changes: read current CSS vars, push them into sigma's
  // settings, and redraw halos so the cluster label picks up the new color.
  useEffect(() => {
    function applyThemeColors() {
      if (!readThemeColors()) return;
      const sigma = sigmaRef.current;
      if (sigma) {
        sigma.setSetting('labelColor', { color: themeColorsRef.current.text });
        sigma.setSetting('edgeLabelColor', { color: themeColorsRef.current.textDim });
        sigma.refresh();
      }
      redrawHalos();
    }
    // Re-read on theme changes (Nimbalyst sets inline styles on documentElement
    // and toggles data-theme/class) and on browser color-scheme changes.
    const root = document.documentElement;
    const observer = new MutationObserver(applyThemeColors);
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', applyThemeColors);
    // Initial sync once the panel mounts (CSS may not have applied at sigma init).
    applyThemeColors();
    return () => {
      observer.disconnect();
      mq?.removeEventListener?.('change', applyThemeColors);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function redrawHalos() {
    const sigma = sigmaRef.current;
    const canvas = haloCanvasRef.current;
    if (!sigma || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const visibleSet = visibleTypesRef.current;
    const camRatio = sigma.getCamera().ratio;
    for (const c of clustersRef.current) {
      if (!visibleSet.has(c.type)) continue;
      const tl = sigma.graphToViewport({ x: c.x - 16, y: -(c.y - 8) });
      const br = sigma.graphToViewport({ x: c.x + c.width + 16, y: -(c.y + c.height + 8) });
      const x = Math.min(tl.x, br.x);
      const y = Math.min(tl.y, br.y);
      const w = Math.abs(br.x - tl.x);
      const h = Math.abs(br.y - tl.y);
      const radius = Math.min(28, Math.min(w, h) / 4);
      ctx.fillStyle = CATEGORY_HALO_COLOR[c.category] ?? CATEGORY_HALO_COLOR.system!;
      roundRect(ctx, x, y, w, h, radius);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, h, radius);
      ctx.stroke();
      // Label above the halo
      const headerPt = sigma.graphToViewport({ x: c.x, y: -c.headerY });
      const labelFontSize = Math.max(10, Math.min(16, 18 / camRatio));
      if (labelFontSize >= 9) {
        ctx.font = `600 ${labelFontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif`;
        ctx.fillStyle = withAlpha(themeColorsRef.current.text, 0.7);
        const schema = typesRef.current.find(t => t.type === c.type);
        const label = `${(schema?.label ?? c.type).toUpperCase()} · ${c.count}`;
        ctx.fillText(label, x + 8, headerPt.y);
      }
    }
  }

  const overlayTarget = useMemo(() => {
    const sigma = sigmaRef.current;
    const id = selectedNodeId ?? hoveredNodeId;
    if (!sigma || !id || !graphRef.current?.hasNode(id)) return null;
    const attrs = graphRef.current.getNodeAttributes(id);
    const vp = sigma.graphToViewport({ x: attrs.x as number, y: attrs.y as number });
    const node = snapshot.nodes.find(n => n.id === id);
    if (!node) return null;
    return { id, x: vp.x, y: vp.y, node, schema: getTypeSchema(types, node.type) };
  }, [selectedNodeId, hoveredNodeId, snapshot.nodes, types, tickCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedOverlay = selectedNodeId && overlayTarget && overlayTarget.id === selectedNodeId ? overlayTarget : null;
  const hoverOverlay = hoveredNodeId && hoveredNodeId !== selectedNodeId && overlayTarget && overlayTarget.id === hoveredNodeId ? overlayTarget : null;

  return (
    <div className="pg-canvas pg-canvas-sigma" data-has-selection={selectedNodeId !== null} onWheel={handleWheel}>
      <div ref={containerRef} className="pg-canvas-host" />

      {selectedOverlay && (
        <DomActionRing
          x={selectedOverlay.x}
          y={selectedOverlay.y}
          node={selectedOverlay.node}
          schema={selectedOverlay.schema}
          onAction={(action) => onNodeAction(action, selectedOverlay.node)}
        />
      )}

      {hoverOverlay && (
        <div
          className="pg-node-tooltip"
          style={{
            left: Math.min(hoverOverlay.x + 14, (containerRef.current?.clientWidth ?? 600) - 280),
            top: Math.min(hoverOverlay.y + 14, (containerRef.current?.clientHeight ?? 400) - 80),
          }}
        >
          <div className="pg-tt-type" style={{ color: resolveTypeColor(hoverOverlay.schema) }}>
            {hoverOverlay.schema?.label ?? hoverOverlay.node.type}
          </div>
          <div className="pg-tt-label">{hoverOverlay.node.label}</div>
          {hoverOverlay.node.sublabel && <div className="pg-tt-sub">{hoverOverlay.node.sublabel}</div>}
          {typeof hoverOverlay.node.fields?.path === 'string' && hoverOverlay.node.fields.path !== hoverOverlay.node.sublabel && (
            <div className="pg-tt-sub pg-tt-path">{hoverOverlay.node.fields.path as string}</div>
          )}
        </div>
      )}
    </div>
  );
});

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Convert any hex/rgb color to an rgba string with the given alpha. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4
      ? '#' + color.slice(1).split('').map(c => c + c).join('')
      : color;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  if (color.startsWith('rgba(')) return color;
  // Fallback: assume the color string is usable as-is.
  return color;
}

/** Apply an alpha to a hex color string for the dim effect. */
function dimColor(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (color.startsWith('rgba(')) return color;
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  return color;
}
