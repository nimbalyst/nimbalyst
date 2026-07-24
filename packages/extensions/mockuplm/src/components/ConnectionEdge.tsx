/**
 * ConnectionEdge - React Flow edge for navigation arrows between mockups.
 *
 * Shows a labeled arrow indicating a navigation flow (e.g., "Click Advanced").
 */

import { memo } from 'react';
import {
  BaseEdge,
  getSmoothStepPath,
  EdgeLabelRenderer,
  type EdgeProps,
} from '@xyflow/react';
import type { Connection } from '../types/project';

export interface ConnectionEdgeData extends Record<string, unknown> {
  connection: Connection;
}

export const ConnectionEdge = memo(function ConnectionEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    data,
  } = props;

  const connection = (data as unknown as ConnectionEdgeData)?.connection;
  const label = connection?.label;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? 'var(--nim-primary)' : 'var(--nim-text-faint)',
          strokeWidth: selected ? 2.5 : 1.5,
        }}
        markerEnd="url(#mockup-arrow)"
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--nim-text-muted)',
              background: 'var(--nim-bg-secondary)',
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--nim-border)',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
