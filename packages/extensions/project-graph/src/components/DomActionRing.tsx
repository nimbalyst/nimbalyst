import type { GraphNodeTypeSchema, ProjectGraphNode } from '../types';

interface DomActionRingProps {
  x: number;
  y: number;
  node: ProjectGraphNode;
  schema: GraphNodeTypeSchema | undefined;
  onAction: (action: string) => void;
}

interface RingSlot {
  key: string;
  label: string;
  count?: number;
  color: string;
  textColor: string;
  fill: string;
  angle: number;
  radius?: number;
  dashed?: boolean;
  action: string;
}

const PALETTE: Record<string, { color: string; fill: string; textColor: string }> = {
  feature: { color: '#4fd1a3', fill: '#0e1a14', textColor: '#4fd1a3' },
  bug: { color: '#ff3346', fill: '#1a0d10', textColor: '#ff5a6e' },
  'ai-session': { color: '#ffb84d', fill: '#1a1408', textColor: '#ffb84d' },
  'markdown-doc': { color: '#8290a8', fill: '#161922', textColor: '#a9b3c6' },
  task: { color: '#93b3d8', fill: '#141a22', textColor: '#bcd0e8' },
  file: { color: '#5b6478', fill: '#1c1f29', textColor: '#a9b3c6' },
  plan: { color: '#b9d36b', fill: '#1d2418', textColor: '#b9d36b' },
  initiative: { color: '#f4a574', fill: '#2a2218', textColor: '#f4a574' },
  project: { color: '#6aa8ff', fill: '#1a2236', textColor: '#bcd0e8' },
  module: { color: '#58c4dc', fill: '#152027', textColor: '#9bd6dd' },
};

const RING_RADIUS = 64;

function buildSlots(node: ProjectGraphNode, schema: GraphNodeTypeSchema | undefined): RingSlot[] {
  const slots: RingSlot[] = [];
  const childTypes = schema?.childTypes ?? [];
  const counts = node.counts ?? {};
  const angles = [-Math.PI / 4, 0, Math.PI / 4, (3 * Math.PI) / 4, Math.PI, (-3 * Math.PI) / 4];
  childTypes.slice(0, 5).forEach((child, idx) => {
    const p = PALETTE[child] ?? { color: '#9aa3b6', fill: '#1d2230', textColor: '#9aa3b6' };
    slots.push({
      key: child,
      label: child.replace(/-/g, ' ').slice(0, 4),
      count: counts[child],
      color: p.color,
      textColor: p.textColor,
      fill: p.fill,
      angle: angles[idx]!,
      radius: child === 'bug' ? 17 : 14,
      action: `expand:${child}`,
    });
  });
  slots.push({
    key: 'add',
    label: '+',
    color: '#3d4763',
    textColor: '#9aa3b6',
    fill: '#1d2230',
    angle: (-3 * Math.PI) / 4,
    radius: 14,
    dashed: true,
    action: 'add-child',
  });
  if (typeof node.fields?.path === 'string' && node.type !== 'commit') {
    slots.push({
      key: 'open',
      label: 'open',
      color: '#6aa8ff',
      textColor: '#bcd0e8',
      fill: '#1a2236',
      angle: Math.PI / 2,
      radius: 17,
      action: 'open-file',
    });
  }
  return slots;
}

export function DomActionRing({ x, y, node, schema, onAction }: DomActionRingProps) {
  const slots = buildSlots(node, schema);
  const launchAction = schema?.quickActions?.includes('launch-fix-session')
    ? 'launch-fix-session'
    : schema?.quickActions?.includes('launch-session') ? 'launch-session' : null;

  return (
    <div className="pg-dom-ring" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {/* Halo */}
      <div className="pg-dom-ring-halo" />
      <div className="pg-dom-ring-halo pg-dom-ring-halo-inner" />

      {/* Launch session pill (top) */}
      {launchAction && (
        <button
          type="button"
          className="pg-dom-ring-launch"
          onClick={(e) => { e.stopPropagation(); onAction(launchAction); }}
        >
          <span className="pg-dom-ring-dot" />
          Launch session
        </button>
      )}

      {/* Surrounding action chips */}
      {slots.map(slot => {
        const cx = Math.cos(slot.angle) * RING_RADIUS;
        const cy = Math.sin(slot.angle) * RING_RADIUS;
        const size = (slot.radius ?? 14) * 2;
        return (
          <button
            key={slot.key}
            type="button"
            className={`pg-dom-ring-chip${slot.dashed ? ' is-dashed' : ''}`}
            style={{
              left: `calc(50% + ${cx}px - ${size / 2}px)`,
              top: `calc(50% + ${cy}px - ${size / 2}px)`,
              width: size,
              height: size,
              background: slot.fill,
              borderColor: slot.color,
              color: slot.textColor,
            }}
            title={slot.action}
            onClick={(e) => { e.stopPropagation(); onAction(slot.action); }}
          >
            {typeof slot.count === 'number' ? (
              <span className="pg-dom-ring-chip-stack">
                <span className="pg-dom-ring-chip-count">{slot.count}</span>
                <span className="pg-dom-ring-chip-sub">{slot.label}</span>
              </span>
            ) : (
              <span className="pg-dom-ring-chip-label">{slot.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
