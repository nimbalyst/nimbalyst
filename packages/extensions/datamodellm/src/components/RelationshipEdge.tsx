/**
 * Relationship Edge Component
 *
 * A React Flow edge that displays a relationship between entities
 * with crow's foot notation for cardinality.
 */

import { memo } from 'react';
import { type EdgeProps, type Edge, getSmoothStepPath } from '@xyflow/react';
import type { Relationship } from '../types';

export interface RelationshipEdgeData extends Record<string, unknown> {
  relationship: Relationship;
}

const EDGE_OFFSET = 22;
const EDGE_STROKE_WIDTH = 3;
const EDGE_STROKE_WIDTH_SELECTED = 5;
const EDGE_HOVER_TARGET_WIDTH = 20;

function RelationshipEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<Edge<RelationshipEdgeData>>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const relationship = data?.relationship;

  // Get stroke color based on selection state
  const getStrokeColor = () => {
    return selected ? 'var(--nim-primary)' : 'var(--nim-text-muted)';
  };

  // Get cardinality type for source and target
  const getSourceCardinality = (): 'one' | 'many' => {
    switch (relationship?.type) {
      case '1:1':
      case '1:N':
        return 'one';
      case 'N:M':
        return 'many';
      default:
        return 'one';
    }
  };

  const getTargetCardinality = (): 'one' | 'many' => {
    switch (relationship?.type) {
      case '1:1':
        return 'one';
      case '1:N':
      case 'N:M':
        return 'many';
      default:
        return 'one';
    }
  };

  // Helper to render crow's foot notation marker
  const renderCrowsFootMarker = (
    cardinality: 'one' | 'many',
    x: number,
    y: number,
    position: 'left' | 'right' | 'top' | 'bottom'
  ) => {
    const strokeColor = getStrokeColor();
    const strokeWidth = selected ? EDGE_STROKE_WIDTH_SELECTED : EDGE_STROKE_WIDTH;

    let rotation = 0;
    switch (position) {
      case 'right':
        rotation = 180;
        break;
      case 'left':
        rotation = 0;
        break;
      case 'bottom':
        rotation = 270;
        break;
      case 'top':
        rotation = 90;
        break;
    }

    if (cardinality === 'one') {
      return (
        <g transform={`translate(${x}, ${y}) rotate(${rotation})`}>
          <line x1="0" y1="-10" x2="0" y2="10" stroke={strokeColor} strokeWidth={strokeWidth} />
        </g>
      );
    } else {
      return (
        <g transform={`translate(${x}, ${y}) rotate(${rotation})`}>
          <line x1="0" y1="0" x2="12" y2="0" stroke={strokeColor} strokeWidth={strokeWidth} />
          <line x1="12" y1="0" x2="22" y2="-10" stroke={strokeColor} strokeWidth={strokeWidth} />
          <line x1="12" y1="0" x2="22" y2="10" stroke={strokeColor} strokeWidth={strokeWidth} />
        </g>
      );
    }
  };

  return (
    <g className="react-flow__edge-interaction">
      {/* Invisible wider hover target for easier interaction */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={EDGE_HOVER_TARGET_WIDTH}
        className="cursor-pointer"
        style={{ pointerEvents: 'all' }}
      />

      {/* Visible edge path */}
      <path
        id={id}
        className="datamodel-edge"
        style={{
          fill: 'none',
          stroke: getStrokeColor(),
          strokeWidth: selected ? EDGE_STROKE_WIDTH_SELECTED : EDGE_STROKE_WIDTH,
          pointerEvents: 'none',
        }}
        d={edgePath}
      />

      {/* Source cardinality */}
      {renderCrowsFootMarker(
        getSourceCardinality(),
        sourceX + (sourcePosition === 'right' ? EDGE_OFFSET : sourcePosition === 'left' ? -EDGE_OFFSET : 0),
        sourceY + (sourcePosition === 'bottom' ? EDGE_OFFSET : sourcePosition === 'top' ? -EDGE_OFFSET : 0),
        sourcePosition
      )}

      {/* Target cardinality */}
      {renderCrowsFootMarker(
        getTargetCardinality(),
        targetX + (targetPosition === 'right' ? EDGE_OFFSET : targetPosition === 'left' ? -EDGE_OFFSET : 0),
        targetY + (targetPosition === 'bottom' ? EDGE_OFFSET : targetPosition === 'top' ? -EDGE_OFFSET : 0),
        targetPosition
      )}

      {/* Relationship label */}
      {relationship?.name && (
        <foreignObject x={labelX - 60} y={labelY - 12} width={120} height={24} className="overflow-visible">
          <div className="datamodel-edge-label-container">
            <div className={`datamodel-edge-label ${selected ? 'datamodel-edge-label-selected' : ''}`}>
              {relationship.name}
            </div>
          </div>
        </foreignObject>
      )}
    </g>
  );
}

export const RelationshipEdge = memo(RelationshipEdgeComponent);
