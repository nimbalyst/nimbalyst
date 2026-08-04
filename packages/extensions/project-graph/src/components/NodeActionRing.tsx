import type { GraphNodeTypeSchema, ProjectGraphNode } from '../types';

interface NodeActionRingProps {
  node: ProjectGraphNode;
  schema: GraphNodeTypeSchema | undefined;
  x: number;
  y: number;
  onAction: (action: string) => void;
}

interface RingSlot {
  key: string;
  label: string;
  count?: number;
  color: string;
  textColor: string;
  fill: string;
  /** angle in radians around the node, 0 = right, increasing clockwise */
  angle: number;
  radius?: number;
  dashed?: boolean;
  primary?: boolean;
  action: string;
}

/**
 * Build slots from the schema's child types + a "+" add slot and a top
 * "launch session" pill.
 */
function buildSlots(node: ProjectGraphNode, schema: GraphNodeTypeSchema | undefined): RingSlot[] {
  const slots: RingSlot[] = [];
  const counts = node.counts ?? {};
  const childTypes = schema?.childTypes ?? [];
  const palette: Record<string, { color: string; fill: string; textColor: string }> = {
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

  // angles around the circle, starting top-right
  const angles = [-Math.PI / 4, 0, Math.PI / 4, (3 * Math.PI) / 4, Math.PI, (-3 * Math.PI) / 4];
  childTypes.slice(0, 5).forEach((child, idx) => {
    const p = palette[child] ?? { color: '#9aa3b6', fill: '#1d2230', textColor: '#9aa3b6' };
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

  // Always include the "+" add slot at top-left
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

  if (schema?.quickActions?.includes('launch-session') || schema?.quickActions?.includes('launch-fix-session')) {
    slots.push({
      key: 'launch',
      label: 'Launch session',
      color: '#4a5d8c',
      textColor: '#e6e8ee',
      fill: '#1a2236',
      angle: -Math.PI / 2,
      primary: true,
      action: schema.quickActions.includes('launch-fix-session') ? 'launch-fix-session' : 'launch-session',
    });
  }

  return slots;
}

export function NodeActionRing({ node, schema, x, y, onAction }: NodeActionRingProps) {
  if (!schema) return null;
  const slots = buildSlots(node, schema);
  if (slots.length === 0) return null;

  const ringRadius = 60;

  return (
    <g transform={`translate(${x}, ${y})`} pointerEvents="all">
      {/* Outer pulsing halo on selection */}
      <circle cx={0} cy={0} r={68} fill="rgba(88,196,220,0.10)" />
      <circle cx={0} cy={0} r={56} fill="rgba(88,196,220,0.14)" stroke="rgba(88,196,220,0.4)" strokeWidth={1} />

      {slots.map((slot) => {
        if (slot.primary) {
          const cx = 0;
          const cy = -ringRadius - 4;
          return (
            <g
              key={slot.key}
              className="pg-action-ring-button"
              transform={`translate(${cx}, ${cy})`}
              onClick={(e) => {
                e.stopPropagation();
                onAction(slot.action);
              }}
            >
              <rect x={-50} y={-10} width={100} height={20} rx={10} fill={slot.fill} stroke={slot.color} strokeWidth={1} />
              <circle cx={-36} cy={0} r={3} fill="#ffb84d" />
              <text x={-28} y={3} fontSize={9.5} fill={slot.textColor} fontWeight={600}>
                {slot.label}
              </text>
            </g>
          );
        }
        const cx = Math.cos(slot.angle) * ringRadius;
        const cy = Math.sin(slot.angle) * ringRadius;
        const r = slot.radius ?? 14;
        return (
          <g
            key={slot.key}
            className="pg-action-ring-button"
            transform={`translate(${cx}, ${cy})`}
            onClick={(e) => {
              e.stopPropagation();
              onAction(slot.action);
            }}
          >
            <circle
              r={r}
              fill={slot.fill}
              stroke={slot.color}
              strokeWidth={slot.dashed ? 1.2 : 1.4}
              strokeDasharray={slot.dashed ? '2 2' : undefined}
            />
            {typeof slot.count === 'number' ? (
              <>
                <text y={-1} fontSize={9.5} fill={slot.textColor} fontWeight={700} textAnchor="middle">
                  {slot.count}
                </text>
                <text y={9} fontSize={7} fill="#9aa3b6" textAnchor="middle">
                  {slot.label}
                </text>
              </>
            ) : (
              <text y={3} fontSize={13} fill={slot.textColor} fontWeight={700} textAnchor="middle">
                {slot.label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
