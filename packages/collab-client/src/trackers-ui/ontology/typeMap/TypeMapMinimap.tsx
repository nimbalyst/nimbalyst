/**
 * The whole map in miniature with the visible area outlined; a click flies
 * there. It sits small and translucent in the bottom-right corner, comes up
 * on hover, and collapses to a button. The outline rect is updated by
 * `useMapViewport`, not by React.
 */
import { memo, useEffect, useState } from 'react';
import type { TypeMapType } from '../ontologyLabelMap';
import type { MapLayout } from './typeMapLayout';

export interface TypeMapMinimapProps {
  layout: MapLayout;
  types: ReadonlyMap<string, TypeMapType>;
  zoneTone: ReadonlyMap<string, number>;
  viewRef: React.RefObject<SVGRectElement | null>;
  onJump: (x: number, y: number) => void;
  /** Redraws the outline after the minimap reopens. */
  onShown: () => void;
}

export const TypeMapMinimap = memo(function TypeMapMinimap({ layout, types, zoneTone, viewRef, onJump, onShown }: TypeMapMinimapProps) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (open) onShown();
  }, [open, onShown]);
  const stroke = Math.max(layout.width, layout.height) / 70;
  return (
    <div className="type-map-minimap-wrap type-map-hud" data-open={open ? 'true' : 'false'} onClick={(event) => event.stopPropagation()}>
      {open && (
        <svg
          className="type-map-minimap"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="button"
          aria-label="Map overview: click to move there"
          onPointerDown={(event) => {
            event.stopPropagation();
            const svg = event.currentTarget;
            const point = svg.createSVGPoint();
            point.x = event.clientX;
            point.y = event.clientY;
            const local = point.matrixTransform(svg.getScreenCTM()?.inverse());
            onJump(local.x, local.y);
          }}
        >
          {layout.zones.map((zone) => <rect key={zone.id} className="type-map-minimap-zone" x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx={18} />)}
          {[...layout.nodes].map(([id, box]) => {
            const type = types.get(id);
            return <rect key={id} className="type-map-minimap-node" data-tone={type ? zoneTone.get(type.zone) ?? 0 : 0} data-empty={type?.count ? 'false' : 'true'} x={box.x} y={box.y} width={box.w} height={box.h} rx={8} />;
          })}
          <rect ref={viewRef} className="type-map-minimap-view" strokeWidth={stroke} />
        </svg>
      )}
      <button
        type="button"
        className="type-map-minimap-toggle"
        aria-label={open ? 'Hide the overview' : 'Show the overview'}
        title={open ? 'Hide the overview' : 'Show the overview'}
        onClick={() => setOpen((shown) => !shown)}
      >
        {open ? '−' : 'Overview'}
      </button>
    </div>
  );
});
