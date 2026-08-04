import type { ProjectGraphNode, NodeShape, GraphNodeTypeSchema } from '../types';

/**
 * Type-cluster packing layout.
 *
 * Nodes are grouped by type and packed into rectangular grids ("clusters").
 * Clusters are then laid out in wrap-rows, ordered by category so types from
 * the same category sit together. Within a cluster, nodes are sorted by
 * label and placed left-to-right, top-to-bottom.
 *
 * The result is reasonably compact — at adapter sizes (~600 nodes) the
 * world bounds are roughly 2500x2000 so a fit-to-view zoom shows the whole
 * thing without horizontal scroll bingo.
 */

const CATEGORY_ORDER = ['strategy', 'delivery', 'knowledge', 'people', 'tracker', 'external', 'system'];

const TYPE_ORDER: string[] = [
  'objective',
  'initiative',
  'project',
  'module',
  'feature',
  'plan',
  'decision',
  'architecture-doc',
  'task',
  'github-pr',
  'github-issue',
  'bug',
  'incident',
  'ai-session',
  'commit',
  'markdown-doc',
  'directory',
  'file',
  'collaborator',
  'customer',
];

interface Footprint { w: number; h: number; }

function footprintForShape(type: string, shape: NodeShape): Footprint {
  switch (shape) {
    case 'card':
      return { w: 146, h: 58 };
    case 'pill':
      // directories use a wider footprint because their labels are paths
      return { w: type === 'file' || type === 'directory' ? 168 : 128, h: 46 };
    case 'dot':
      return { w: 36, h: 36 };
    case 'hex':
      return { w: 48, h: 48 };
    case 'stack':
      return { w: 100, h: 40 };
    default:
      return { w: 128, h: 46 };
  }
}

function shapeFor(type: string, typeIndex: Map<string, GraphNodeTypeSchema>): NodeShape {
  return typeIndex.get(type)?.shape ?? 'pill';
}

function categoryFor(type: string, typeIndex: Map<string, GraphNodeTypeSchema>): string {
  return typeIndex.get(type)?.category ?? 'system';
}

function packShape(count: number, fp: Footprint, targetAspect: number): { cols: number; rows: number; width: number; height: number } {
  // cluster_w/cluster_h = cols*fp.w / (rows*fp.h) = targetAspect
  // → cols = sqrt(targetAspect * count * fp.h / fp.w)
  const rawCols = Math.sqrt(targetAspect * count * fp.h / fp.w);
  const cols = Math.max(1, Math.round(rawCols));
  const rows = Math.ceil(count / cols);
  return { cols, rows, width: cols * fp.w, height: rows * fp.h };
}

/**
 * Aspect target — wider clusters look more "scannable" but ones with very few
 * nodes look weird if forced into a long bar. So we taper the aspect with size.
 */
function aspectFor(count: number): number {
  if (count <= 4) return 1.0;
  if (count <= 12) return 1.4;
  if (count <= 40) return 2.0;
  if (count <= 100) return 2.8;
  return 3.4;
}

interface ClusterPlacement {
  type: string;
  category: string;
  fp: Footprint;
  cols: number;
  rows: number;
  width: number;
  height: number;
  /** Top-left x of the cluster body (excludes label area above). */
  x: number;
  /** Top-left y of the cluster body. */
  y: number;
  count: number;
}

/**
 * Pack clusters into wrap-rows, breaking the row when the running width would
 * exceed MAX_ROW_WIDTH. Categories are kept together by emitting a row break
 * before a new category if the current row already has content from a
 * different category.
 */
const MAX_ROW_WIDTH = 3200;
const CLUSTER_GAP_X = 56;
const CLUSTER_GAP_Y = 64;
const CLUSTER_HEADER_H = 30;
const ORIGIN_X = 40;
const ORIGIN_Y = 40;

function placeClusters(
  clusters: Array<Omit<ClusterPlacement, 'x' | 'y'>>,
): ClusterPlacement[] {
  const placed: ClusterPlacement[] = [];
  let rowX = ORIGIN_X;
  let rowY = ORIGIN_Y + CLUSTER_HEADER_H;
  let rowH = 0;
  let rowCategory: string | null = null;

  for (const c of clusters) {
    const wouldOverflow = rowX > ORIGIN_X && rowX + c.width > ORIGIN_X + MAX_ROW_WIDTH;
    const categoryBreak = rowCategory !== null && rowCategory !== c.category && rowX > ORIGIN_X;
    if (wouldOverflow || categoryBreak) {
      rowY += rowH + CLUSTER_GAP_Y + CLUSTER_HEADER_H;
      rowX = ORIGIN_X;
      rowH = 0;
    }
    placed.push({ ...c, x: rowX, y: rowY });
    rowX += c.width + CLUSTER_GAP_X;
    if (c.height > rowH) rowH = c.height;
    rowCategory = c.category;
  }
  return placed;
}

function compareTypes(a: string, b: string): number {
  const ia = TYPE_ORDER.indexOf(a);
  const ib = TYPE_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

function compareCategories(a: string, b: string): number {
  const ia = CATEGORY_ORDER.indexOf(a);
  const ib = CATEGORY_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

export interface LayoutClusterInfo {
  type: string;
  category: string;
  x: number;
  y: number;
  width: number;
  height: number;
  headerY: number;
  count: number;
}

export interface LayoutResult {
  nodes: ProjectGraphNode[];
  clusters: LayoutClusterInfo[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function applyDeterministicLayout(
  nodes: ProjectGraphNode[],
  typeSchemas: GraphNodeTypeSchema[] = [],
): LayoutResult {
  const typeIndex = new Map<string, GraphNodeTypeSchema>();
  for (const t of typeSchemas) typeIndex.set(t.type, t);

  // Group nodes by type, sort alphabetically within each type.
  const byType = new Map<string, ProjectGraphNode[]>();
  for (const n of nodes) {
    const list = byType.get(n.type) ?? [];
    list.push(n);
    byType.set(n.type, list);
  }
  for (const list of byType.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }

  // Build cluster descriptors sorted by category, then type within category.
  const clusterDescriptors: Array<Omit<ClusterPlacement, 'x' | 'y'>> = Array.from(byType.entries())
    .map(([type, list]) => {
      const shape = shapeFor(type, typeIndex);
      const fp = footprintForShape(type, shape);
      const aspect = aspectFor(list.length);
      const pack = packShape(list.length, fp, aspect);
      return {
        type,
        category: categoryFor(type, typeIndex),
        fp,
        cols: pack.cols,
        rows: pack.rows,
        width: pack.width,
        height: pack.height,
        count: list.length,
      };
    })
    .sort((a, b) => {
      const c = compareCategories(a.category, b.category);
      if (c !== 0) return c;
      return compareTypes(a.type, b.type);
    });

  const placedClusters = placeClusters(clusterDescriptors);

  // Place individual nodes within each cluster. Node coords are the node's
  // center (matches how the canvas renders shapes — transform translates to
  // the node center).
  const positioned: ProjectGraphNode[] = [];
  const clusterInfos: LayoutClusterInfo[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const c of placedClusters) {
    const list = byType.get(c.type)!;
    for (let i = 0; i < list.length; i++) {
      const col = i % c.cols;
      const row = Math.floor(i / c.cols);
      const x = c.x + col * c.fp.w + c.fp.w / 2;
      const y = c.y + row * c.fp.h + c.fp.h / 2;
      positioned.push({ ...list[i]!, x, y, cluster: c.type });
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    clusterInfos.push({
      type: c.type,
      category: c.category,
      x: c.x,
      y: c.y,
      width: c.width,
      height: c.height,
      headerY: c.y - CLUSTER_HEADER_H + 6,
      count: c.count,
    });
  }

  if (!isFinite(minX)) {
    minX = 0; minY = 0; maxX = 800; maxY = 600;
  }

  return {
    nodes: positioned,
    clusters: clusterInfos,
    bounds: { minX, minY, maxX, maxY },
  };
}
