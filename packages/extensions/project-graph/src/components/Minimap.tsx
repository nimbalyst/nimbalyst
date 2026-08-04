import { useMemo } from 'react';
import type { GraphNodeTypeSchema, ProjectGraphSnapshot } from '../types';
import { getTypeSchema } from '../schema';

interface MinimapProps {
  snapshot: ProjectGraphSnapshot;
  types: GraphNodeTypeSchema[];
  viewport: { x: number; y: number; w: number; h: number };
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function Minimap({ snapshot, types, viewport, worldBounds }: MinimapProps) {
  const dots = useMemo(() => {
    return snapshot.nodes
      .filter(n => typeof n.x === 'number' && typeof n.y === 'number')
      .map(n => {
        const schema = getTypeSchema(types, n.type);
        return {
          id: n.id,
          x: n.x!,
          y: n.y!,
          color: schema ? `var(${schema.colorToken})` : '#9aa3b6',
          r: schema?.shape === 'card' ? 2.5 : schema?.shape === 'dot' ? 1.5 : 2,
        };
      });
  }, [snapshot.nodes, types]);

  const w = Math.max(1, worldBounds.maxX - worldBounds.minX);
  const h = Math.max(1, worldBounds.maxY - worldBounds.minY);

  // Position viewport rectangle as a percentage of world bounds.
  const vpStyle = {
    left: `${Math.max(0, Math.min(100, ((viewport.x - worldBounds.minX) / w) * 100))}%`,
    top: `${Math.max(0, Math.min(100, ((viewport.y - worldBounds.minY) / h) * 100))}%`,
    width: `${Math.max(2, Math.min(100, (viewport.w / w) * 100))}%`,
    height: `${Math.max(2, Math.min(100, (viewport.h / h) * 100))}%`,
  };

  return (
    <div className="pg-minimap">
      <div className="pg-minimap-header">
        <span>Minimap</span>
        <span>{snapshot.stats.nodeCount} nodes</span>
      </div>
      <div className="pg-minimap-canvas">
        <svg viewBox={`${worldBounds.minX} ${worldBounds.minY} ${w} ${h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {dots.map(d => (
            <circle key={d.id} cx={d.x} cy={d.y} r={d.r * 4} fill={d.color} />
          ))}
        </svg>
        <div className="pg-minimap-viewport" style={vpStyle} />
      </div>
    </div>
  );
}
