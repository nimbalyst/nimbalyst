/**
 * The type map: every label a project uses, grouped into domain zones, with
 * one line per pair of types that links, a pill per relationship, and an
 * inspector beside it. Pan by dragging or scrolling, zoom with a pinch (around the
 * cursor), Ctrl+wheel, the buttons or `+`/`-`/`0`, arrows to pan, Escape to deselect.
 * Zooming in shows every relationship, then each type's properties.
 *
 * The host builds the model (`buildTypeMap`) and navigates; the layout is
 * computed here (`typeMap/typeMapLayout.ts`). Everything here is behind a lazy
 * import.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { OntologyInspectorWriter } from './OntologyInspector';
import type { TypeMapModel, TypeMapRelationship } from './ontologyLabelMap';
import { OTHER_ZONE } from './typeMap/typeMapZones';
import { buildPairs, layoutTypeMap, type MapLayout, type MapPair } from './typeMap/typeMapLayout';
import { TypeMapCanvas, type MapSelection } from './typeMap/TypeMapCanvas';
import { TypeMapInspector } from './typeMap/TypeMapInspector';
import { TypeMapMinimap } from './typeMap/TypeMapMinimap';
import { TypeMapSearch } from './typeMap/TypeMapSearch';
import { useMapViewport, type Box } from './typeMap/useMapViewport';
import './typeMap/typeMap.css';

export interface OntologyTypeMapProps {
  model: TypeMapModel;
  /** Opens a label's type page (its table); `newTab` when Cmd/Ctrl was held. */
  onOpenLabel: (id: string, options?: { newTab: boolean }) => void;
  /** Opens a page by item id. */
  onOpenPage?: (id: string) => void;
  /** Opens the pages that carry no label; omitted hides the entry. */
  onOpenUnlabeled?: () => void;
  /** Files proposal requests; null or omitted (the public wiki, viewers) hides those actions. */
  writer?: OntologyInspectorWriter | null;
  /** False drops the inspector: the map takes the width and a click on a type opens it. */
  inspector?: boolean;
}

/** The type and relationship ids a selection lights: itself and its neighbourhood. */
export function litIds(selection: MapSelection, relationships: readonly TypeMapRelationship[]): Set<string> {
  const lit = new Set<string>();
  if (!selection) return lit;
  for (const relationship of relationships) {
    const touches = selection.kind === 'type'
      ? relationship.from === selection.id || relationship.to === selection.id
      : relationship.id === selection.id;
    if (!touches) continue;
    lit.add(`rel:${relationship.id}`).add(`type:${relationship.from}`).add(`type:${relationship.to}`);
  }
  if (selection.kind === 'type') lit.add(`type:${selection.id}`);
  return lit;
}

export function OntologyTypeMap({ model, onOpenLabel, onOpenPage, onOpenUnlabeled, writer = null, inspector = true }: OntologyTypeMapProps) {
  const [showEmpty, setShowEmpty] = useState(true);
  const [showUnused, setShowUnused] = useState(true);
  const [selection, setSelection] = useState<MapSelection>(null);
  const [hover, setHover] = useState<MapSelection>(null);
  // The canvas's shape, in steps of 0.1, so zones pack to it without relaying out on every pixel.
  const [aspect, setAspect] = useState(1.5);

  const typeById = useMemo(() => new Map(model.types.map((type) => [type.id, type])), [model.types]);
  const zoneTone = useMemo(() => new Map(model.zones.map((zone, i) => [zone.id, zone.id === OTHER_ZONE ? 4 : i % 4])), [model.zones]);
  // A selected empty type stays on the map when empty types are hidden; otherwise selection must not relayout.
  const keepType = !showEmpty && selection?.kind === 'type' ? selection.id : null;
  const types = useMemo(() => model.types.filter((type) => showEmpty || type.count > 0 || type.id === keepType), [model.types, showEmpty, keepType]);
  const relationships = useMemo(() => {
    const shown = new Set(types.map((type) => type.id));
    return model.relationships.filter((relationship) => shown.has(relationship.from) && shown.has(relationship.to) && (showUnused || relationship.statements > 0));
  }, [model.relationships, types, showUnused]);
  const pairs = useMemo(() => buildPairs(relationships), [relationships]);
  const pairById = useMemo(() => new Map<string, MapPair>(pairs.map((pair) => [pair.id, pair])), [pairs]);
  const relationshipById = useMemo(() => new Map(model.relationships.map((relationship) => [relationship.id, relationship])), [model.relationships]);
  const maxCount = useMemo(() => Math.max(1, ...model.types.map((type) => type.count)), [model.types]);

  // Lay out again when what is shown changes (a toggle) or the canvas changes shape, then fit.
  const layout = useMemo<MapLayout>(() => layoutTypeMap({ types, zones: model.zones, pairs, aspect }), [types, model.zones, pairs, aspect]);
  const viewport = useMapViewport(layout);
  const { fit } = viewport;
  useEffect(() => {
    fit(false);
  }, [layout, fit]);
  useEffect(() => {
    const canvas = viewport.canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    let width = canvas.clientWidth;
    const measure = () => {
      if (canvas.clientWidth && canvas.clientHeight) setAspect(Math.round((canvas.clientWidth / canvas.clientHeight) * 10) / 10);
    };
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      if (Math.abs(canvas.clientWidth - width) < 40) return;
      width = canvas.clientWidth;
      fit(false);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [viewport.canvasRef, fit]);

  const boxOf = useCallback((target: NonNullable<MapSelection>): Box | null => {
    if (target.kind === 'type') return layout.nodes.get(target.id) ?? null;
    const relationship = relationshipById.get(target.id);
    const pill = layout.pills.find((entry) => entry.relationshipId === target.id);
    const ends = relationship ? [layout.nodes.get(relationship.from), layout.nodes.get(relationship.to)].filter((box): box is Box => Boolean(box)) : [];
    const boxes = [...ends, ...(pill ? [pill] : [])];
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    return { x, y, w: Math.max(...boxes.map((box) => box.x + box.w)) - x, h: Math.max(...boxes.map((box) => box.y + box.h)) - y };
  }, [layout, relationshipById]);

  const center = useCallback((target: NonNullable<MapSelection>, k?: number) => {
    const box = boxOf(target);
    if (box) viewport.focus(box, k);
  }, [boxOf, viewport]);
  const pick = useCallback((target: NonNullable<MapSelection>) => {
    setSelection(target);
    center(target, target.kind === 'type' ? 1.45 : undefined);
  }, [center]);
  const { dragged } = viewport;
  const select = useCallback((target: MapSelection, event?: { metaKey: boolean; ctrlKey: boolean }) => {
    if (dragged()) return;
    if (!inspector && target?.kind === 'type') {
      onOpenLabel(target.id, { newTab: Boolean(event && (event.metaKey || event.ctrlKey)) });
      return;
    }
    setSelection(target);
  }, [dragged, inspector, onOpenLabel]);

  const lit = useMemo(() => litIds(hover ?? selection, relationships), [hover, selection, relationships]);
  const statements = relationships.reduce((sum, relationship) => sum + relationship.statements, 0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = 60;
    const keys: Record<string, () => void> = {
      '+': () => viewport.zoomBy(1.25),
      '=': () => viewport.zoomBy(1.25),
      '-': () => viewport.zoomBy(0.8),
      '0': () => viewport.fit(),
      Escape: () => setSelection(null),
      ArrowLeft: () => viewport.panBy(step, 0),
      ArrowRight: () => viewport.panBy(-step, 0),
      ArrowUp: () => viewport.panBy(0, step),
      ArrowDown: () => viewport.panBy(0, -step),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div className="ontology-type-map" data-testid="ontology-type-map" onKeyDown={onKeyDown}>
      <div className="type-map-toolbar">
        <TypeMapSearch types={types} relationships={relationships} typeById={typeById} onPick={pick} />
        <div className="type-map-toggles">
          <label><input type="checkbox" checked={showEmpty} onChange={(event) => setShowEmpty(event.target.checked)} /> Types with no pages</label>
          <label><input type="checkbox" checked={showUnused} onChange={(event) => setShowUnused(event.target.checked)} /> Relationships nobody uses yet</label>
        </div>
        <span className="type-map-summary">{`${types.length} types · ${relationships.length} relationships · ${statements} linking statements`}</span>
        <div className="type-map-zoom" role="group" aria-label="Zoom">
          <button type="button" title="Zoom out (-)" aria-label="Zoom out" onClick={() => viewport.zoomBy(0.8)}>&minus;</button>
          <span className="type-map-zoom-percent" ref={viewport.percentRef}>100%</span>
          <button type="button" title="Zoom in (+)" aria-label="Zoom in" onClick={() => viewport.zoomBy(1.25)}>+</button>
          <button type="button" title="Fit the map (0)" onClick={() => viewport.fit()}>Fit</button>
        </div>
      </div>
      <div className={`type-map-work${inspector ? '' : ' type-map-work-full'}`}>
        <div
          className="type-map-canvas"
          ref={viewport.canvasRef}
          tabIndex={0}
          role="application"
          aria-label="Type map. Drag or scroll to pan. Pinch or Control-scroll to zoom."
          onClick={() => { if (!viewport.dragged()) setSelection(null); }}
        >
          <svg className="type-map-svg" ref={viewport.svgRef} data-zoom="fit">
            <g ref={viewport.sceneRef}>
              <TypeMapCanvas
                layout={layout}
                types={typeById}
                pairs={pairById}
                relationships={relationshipById}
                zoneTone={zoneTone}
                maxCount={maxCount}
                lit={lit}
                selection={selection}
                onSelect={select}
                onHover={setHover}
              />
            </g>
          </svg>
          <TypeMapMinimap layout={layout} types={typeById} zoneTone={zoneTone} viewRef={viewport.miniViewRef} onJump={viewport.centerOn} onShown={viewport.refresh} />
          <div className="type-map-hint">{`Drag or scroll to pan · pinch or Ctrl+scroll to zoom · ${inspector ? 'click a type or a relationship' : 'click a type to open it'} · zoom in for properties`}</div>
        </div>
        {inspector && <TypeMapInspector
          model={model}
          typeById={typeById}
          relationships={relationships}
          zoneTone={zoneTone}
          selection={selection}
          onPick={pick}
          onCenter={(target) => center(target)}
          onOpenLabel={onOpenLabel}
          onOpenUnlabeled={onOpenUnlabeled}
          onOpenPage={onOpenPage}
          writer={writer}
        />}
      </div>
    </div>
  );
}

