/**
 * The small neighborhood diagram at the top of a category's detail page in
 * "What we track": the category and the categories it links to directly. The
 * project-wide map is the label type map in the wiki (`OntologyTypeMap`).
 */
import { formatCount, type DomainCategory, type DomainEdge, type DomainModel } from './ontologyDomain';
import type { OpenCategory } from './OntologyParts';

function edgeCount(edge: DomainEdge, fromUs: boolean): string {
  if (edge.state === 'missing') return '';
  if (!fromUs && edge.have < edge.total) return `${formatCount(edge.have)} of ${formatCount(edge.total)}`;
  return formatCount(edge.links);
}

function clip(cx: number, cy: number, tx: number, ty: number, w: number, h: number): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  const scale = Math.min((w / 2 + 4) / Math.abs(dx || 1e-6), (h / 2 + 4) / Math.abs(dy || 1e-6));
  return [cx + dx * scale, cy + dy * scale];
}

function EdgeLabel({ x, y, text, count, onClick }: { x: number; y: number; text: string; count: string; onClick?: () => void }) {
  const width = (text.length + (count ? count.length + 3 : 0)) * 6.1 + 16;
  return (
    <g className="ontology-edge-label" onClick={onClick}>
      <rect x={x - width / 2} y={y - 10} width={width} height={20} rx={10} />
      <text x={x} y={y + 4} textAnchor="middle">{text}{count && <tspan> {count}</tspan>}</text>
    </g>
  );
}

function ArrowDefs({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
        <path className="ontology-arrow" d="M0,0 L10,5 L0,10 z" />
      </marker>
    </defs>
  );
}

function nodeCountLabel(category: DomainCategory): string {
  if (category.ghost) return 'not tracked';
  if (category.us) return 'us';
  return `${formatCount(category.count)}${category.countLabel ? ` ${category.countLabel}` : ''}`;
}

/** The category and its direct neighbors, for the top of a detail page. */
export function OntologyNeighborhood({ model, categoryId, onOpen, onOpenGap }: {
  model: DomainModel;
  categoryId: string;
  onOpen: OpenCategory;
  onOpenGap: (gapId: string) => void;
}) {
  const edges = model.edges.filter((edge) => edge.from === categoryId || edge.to === categoryId);
  const byId = new Map(model.categories.map((category) => [category.id, category]));
  const others = [...new Set(edges.map((edge) => (edge.from === categoryId ? edge.to : edge.from)))].filter((id) => byId.has(id));
  if (!others.length) return null;
  const W = 720;
  const H = 300;
  const boxW = 140;
  const boxH = 44;
  const positions = new Map<string, [number, number]>([[categoryId, [W / 2, H / 2]]]);
  others.forEach((id, index) => {
    const step = (2 * Math.PI) / others.length;
    const angle = others.length === 1 ? 0 : -Math.PI / 2 + index * step;
    positions.set(id, [W / 2 + Math.cos(angle) * 262, H / 2 + Math.sin(angle) * 105]);
  });
  return (
    <div className="ontology-canvas ontology-neighborhood">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Directly connected categories">
        <ArrowDefs id="ontology-arrow-small" />
        {edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to)).map((edge) => {
          const [x1, y1] = positions.get(edge.from)!;
          const [x2, y2] = positions.get(edge.to)!;
          const [sx, sy] = clip(x1, y1, x2, y2, boxW, boxH);
          const [ex, ey] = clip(x2, y2, x1, y1, boxW, boxH);
          const missing = edge.state === 'missing';
          return (
            <g key={edge.id} className="ontology-edge" data-state={edge.state}>
              <path d={`M${sx},${sy} L${ex},${ey}`} strokeWidth={1.6} markerEnd={missing ? undefined : 'url(#ontology-arrow-small)'} />
              <EdgeLabel
                x={(sx + ex) / 2}
                y={(sy + ey) / 2}
                text={missing ? `${edge.verb}  +` : edge.verb}
                count={edgeCount(edge, byId.get(edge.from)?.us ?? false)}
                onClick={missing && edge.gapId ? () => onOpenGap(edge.gapId!) : undefined}
              />
            </g>
          );
        })}
        {[...positions.entries()].map(([id, [x, y]]) => {
          const category = byId.get(id)!;
          const self = id === categoryId;
          return (
            <g
              key={id}
              className="ontology-node"
              data-selected={self ? 'true' : 'false'}
              data-us={category.us ? 'true' : 'false'}
              data-ghost={category.ghost ? 'true' : 'false'}
              onClick={self ? undefined : () => onOpen(id)}
            >
              <rect className="ontology-node-box" x={x - boxW / 2} y={y - boxH / 2} width={boxW} height={boxH} rx={9} />
              <text className="ontology-node-title" x={x} y={y - 2} textAnchor="middle">{category.name}</text>
              <text className="ontology-node-example" x={x} y={y + 14} textAnchor="middle">{nodeCountLabel(category)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
