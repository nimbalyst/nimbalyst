/**
 * The drawn map: zones, one line per pair of types, a pill per relationship
 * and a box per type. Presentational; pan and zoom live on the scene group
 * (`useMapViewport`), and which pills and property lists show is CSS keyed on
 * the svg's `data-zoom`.
 */
import { memo, useId } from 'react';
import type { TypeMapRelationship, TypeMapType } from '../ontologyLabelMap';
import { DETAIL_ROWS, DETAIL_ROW_H as ROW_H, detailRows, expandedHeight, isMajor, pairStrokeWidth, type MapLayout, type MapPair, type PairStyle } from './typeMapLayout';

export type MapSelection = { kind: 'type' | 'relationship'; id: string } | null;

export function initials(name: string): string {
  return name.split(/[\s-]+/).filter(Boolean).map((word) => word[0]!).join('').slice(0, 2).toUpperCase();
}

const STYLES: PairStyle[] = ['used', 'unused', 'off-label', 'violation'];

export interface TypeMapCanvasProps {
  layout: MapLayout;
  types: ReadonlyMap<string, TypeMapType>;
  pairs: ReadonlyMap<string, MapPair>;
  relationships: ReadonlyMap<string, TypeMapRelationship>;
  zoneTone: ReadonlyMap<string, number>;
  maxCount: number;
  /** Ids (`type:x`, `rel:x`) in the hovered or selected neighbourhood. */
  lit: ReadonlySet<string>;
  selection: MapSelection;
  /** The click comes along so a type can open in a new tab on Cmd/Ctrl. */
  onSelect: (selection: MapSelection, event?: { metaKey: boolean; ctrlKey: boolean }) => void;
  onHover: (selection: MapSelection) => void;
}

export const TypeMapCanvas = memo(function TypeMapCanvas({ layout, types, pairs, relationships, zoneTone, maxCount, lit, selection, onSelect, onHover }: TypeMapCanvasProps) {
  const uid = useId().replace(/:/g, '');
  const marker = (style: PairStyle) => `type-map-arrow-${uid}-${style}`;
  const focus = lit.size > 0;
  const isSelected = (kind: 'type' | 'relationship', id: string) => selection?.kind === kind && selection.id === id;
  const pairLit = (pair: MapPair) => pair.relationships.some((relationship) => lit.has(`rel:${relationship.id}`));

  return (
    <>
      <defs>
        {STYLES.map((style) => (
          <marker key={style} id={marker(style)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path className="type-map-arrow" data-style={style} d="M0,0 L10,5 L0,10 z" />
          </marker>
        ))}
      </defs>
      <g className="type-map-zones">
        {layout.zones.map((zone) => (
          <g key={zone.id} className="type-map-zone" data-tone={zoneTone.get(zone.id) ?? 0}>
            <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx={18} />
            <text x={zone.x + 18} y={zone.y + 27}>{zone.name}</text>
          </g>
        ))}
      </g>
      <g className="type-map-lines" data-focus={focus ? 'true' : 'false'}>
        {layout.pairs.map((route) => {
          const pair = pairs.get(route.id);
          if (!pair) return null;
          const d = route.path;
          const selected = pair.relationships.some((relationship) => isSelected('relationship', relationship.id));
          return (
            <g
              key={route.id}
              className="type-map-line"
              data-style={pair.style}
              data-lit={pairLit(pair) ? 'true' : 'false'}
              data-selected={selected ? 'true' : 'false'}
              onClick={(event) => { event.stopPropagation(); onSelect({ kind: 'relationship', id: pair.relationships[0]!.id }); }}
              onMouseEnter={() => onHover({ kind: 'relationship', id: pair.relationships[0]!.id })}
              onMouseLeave={() => onHover(null)}
            >
              <path className="type-map-line-stroke" d={d} strokeWidth={pairStrokeWidth(pair)} markerEnd={`url(#${marker(pair.style)})`} markerStart={pair.both ? `url(#${marker(pair.style)})` : undefined} />
              <path className="type-map-line-hit" d={d} />
            </g>
          );
        })}
      </g>
      <g className="type-map-pills" data-focus={focus ? 'true' : 'false'}>
        {layout.pills.map((pill) => {
          const relationship = relationships.get(pill.relationshipId);
          if (!relationship) return null;
          return (
            <g
              key={pill.relationshipId}
              className="type-map-pill"
              data-status={relationship.status}
              data-major={isMajor(relationship) ? 'true' : 'false'}
              data-lit={lit.has(`rel:${relationship.id}`) ? 'true' : 'false'}
              data-selected={isSelected('relationship', relationship.id) ? 'true' : 'false'}
              transform={`translate(${pill.x},${pill.y})`}
              onClick={(event) => { event.stopPropagation(); onSelect({ kind: 'relationship', id: relationship.id }); }}
              onMouseEnter={() => onHover({ kind: 'relationship', id: relationship.id })}
              onMouseLeave={() => onHover(null)}
            >
              <title>{`${types.get(relationship.from)?.plural ?? relationship.from} ${relationship.verb} ${types.get(relationship.to)?.plural ?? relationship.to}: ${relationship.statements} statements`}</title>
              <rect width={pill.w} height={pill.h} rx={pill.h / 2} />
              <text className="type-map-pill-verb" x={9} y={14}>{relationship.verb}</text>
              {relationship.statements > 0 && <text className="type-map-pill-count" x={pill.w - 9} y={14} textAnchor="end">{relationship.statements}</text>}
            </g>
          );
        })}
      </g>
      <g className="type-map-nodes" data-focus={focus ? 'true' : 'false'}>
        {[...layout.nodes].map(([id, box]) => {
          const type = types.get(id);
          if (!type) return null;
          const full = expandedHeight(type);
          const bar = type.count ? Math.max(6, (box.w - 24) * Math.sqrt(type.count / Math.max(maxCount, 1))) : 0;
          const caption = type.broader.length ? `kind of ${type.broader.join(', ')}` : '';
          const nameY = caption ? 25 : 32;
          return (
            <g
              key={id}
              className="type-map-node"
              data-type-id={id}
              data-empty={type.count ? 'false' : 'true'}
              data-declared={type.declared ? 'true' : 'false'}
              data-lit={lit.has(`type:${id}`) ? 'true' : 'false'}
              data-selected={isSelected('type', id) ? 'true' : 'false'}
              data-tone={zoneTone.get(type.zone) ?? 0}
              transform={`translate(${box.x},${box.y})`}
              onClick={(event) => { event.stopPropagation(); onSelect({ kind: 'type', id }, event); }}
              onMouseEnter={() => onHover({ kind: 'type', id })}
              onMouseLeave={() => onHover(null)}
            >
              <title>{`${type.plural}: ${type.count} ${type.count === 1 ? 'page' : 'pages'}${type.declared ? '' : ' (not in the registry)'}`}</title>
              <rect className="type-map-node-box type-map-node-compact" width={box.w} height={box.h} rx={10} />
              <rect className="type-map-node-box type-map-node-full" width={box.w} height={full} rx={10} />
              <rect className="type-map-node-badge" x={10} y={(box.h - 24) / 2 - (caption ? 1 : 0)} width={24} height={24} rx={6} />
              <text className="type-map-node-initials" x={22} y={box.h / 2 + 3.5 - (caption ? 1 : 0)} textAnchor="middle">{initials(type.name)}</text>
              <text className="type-map-node-name" x={42} y={nameY} data-long={type.plural.length > 14 ? 'true' : 'false'}>{type.plural.length > 17 ? `${type.plural.slice(0, 16)}…` : type.plural}</text>
              {caption && <text className="type-map-node-caption" x={42} y={40}>{caption.length > 24 ? `${caption.slice(0, 23)}…` : caption}</text>}
              <text className="type-map-node-count" x={box.w - 12} y={nameY} textAnchor="end">{type.count}</text>
              {bar > 0 && <rect className="type-map-node-bar" x={12} y={box.h - 6} width={bar} height={2.5} rx={1.2} />}
              {detailRows(type) > 0 && <g className="type-map-node-detail">
                {type.properties.slice(0, DETAIL_ROWS).map((property, i) => {
                  const y = box.h + 8 + i * ROW_H;
                  const share = type.count ? property.filled / type.count : 0;
                  return (
                    <g key={property.id}>
                      <text x={12} y={y + 9}>{property.name.length > 15 ? `${property.name.slice(0, 14)}…` : property.name}</text>
                      <rect className="type-map-node-track" x={104} y={y + 3} width={40} height={4} rx={2} />
                      <rect className="type-map-node-fill" x={104} y={y + 3} width={40 * share} height={4} rx={2} />
                      <text x={box.w - 12} y={y + 9} textAnchor="end">{type.count ? `${Math.round(share * 100)}%` : ''}</text>
                    </g>
                  );
                })}
                {type.properties.length > DETAIL_ROWS && <text x={12} y={box.h + 8 + DETAIL_ROWS * ROW_H + 9}>{`${type.properties.length - DETAIL_ROWS} more in the panel`}</text>}
              </g>}
            </g>
          );
        })}
      </g>
    </>
  );
});
