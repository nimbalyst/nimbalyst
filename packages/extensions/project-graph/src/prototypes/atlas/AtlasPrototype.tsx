/**
 * Project Atlas -- a stable, labeled territory map of the project's areas.
 *
 * Design constraints this file is built around:
 *  - Geography never moves. Territory order comes from `atlasModel` and is keyed
 *    on area identity, so the date range, the selection, a rename, and a
 *    refreshed snapshot all repaint overlays without rearranging the map.
 *  - No hairball. Connectors are drawn for the selected area only, capped, and
 *    each one names the relation family that produced it.
 *  - Bounded detail. Every list states "showing X of Y" and pages.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PrototypeViewProps } from '../contracts';
import {
  CONNECTION_FAMILY_SHORT,
  areaActivityInRange,
  areaConnections,
  areaStandings,
  buildAreaIndex,
  connectorPath,
  layoutTerritories,
  moveTerritoryFocus,
  plural,
  type TerritoryBox,
} from './atlasModel';
import { AreaDetailPanel, type RelationLens } from './AreaDetailPanel';
import './atlas.css';

/** Bridges drawn on the map. The panel still lists every connection. */
const MAX_CONNECTORS = 6;
/** Evidence carried per connection; the true total is reported separately. */
const EVIDENCE_CAP = 200;
/** Used until the ResizeObserver reports (and in environments without one). */
const FALLBACK_MAP_WIDTH = 880;

export function AtlasPrototype(props: PrototypeViewProps) {
  const {
    model, range, selectedAreaId, selectedNodeId,
    onSelectArea, onSelectNode, onOpenNode, onNavigate, onRenameArea,
  } = props;

  const mapRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const [mapWidth, setMapWidth] = useState(FALLBACK_MAP_WIDTH);
  // Recorded links, not everything. Connections sort by volume, and on a real
  // index the directory rollups outnumber recorded links by three orders of
  // magnitude — an "all relations" default fills all six drawn routes with
  // path-derived edges and hides every link a record actually asserts. The
  // other families stay one selection away.
  const [lens, setLens] = useState<RelationLens>('recorded-link');
  const [openConnectionId, setOpenConnectionId] = useState<string | null>(null);
  const [tab, setTab] = useState<'connections' | 'activity' | 'records'>('connections');

  const index = useMemo(() => buildAreaIndex(model), [model]);
  const standings = useMemo(() => areaStandings(model, index), [model, index]);
  const activity = useMemo(() => areaActivityInRange(model, index, range), [model, index, range]);
  const layout = useMemo(() => layoutTerritories(index.order, mapWidth), [index.order, mapWidth]);

  const boxById = useMemo(() => {
    const map = new Map<string, TerritoryBox>();
    for (const box of layout.boxes) map.set(box.areaId, box);
    return map;
  }, [layout]);

  const connectionResult = useMemo(
    () =>
      selectedAreaId
        ? areaConnections(model, index, selectedAreaId, { evidenceCap: EVIDENCE_CAP })
        : { connections: [], internalEdges: { total: 0, byFamily: {} } },
    [model, index, selectedAreaId],
  );

  // Each drawn connection carries its place in the bundle its pair of areas
  // forms, so two families joining the same pair get two routes and two
  // controls instead of one drawn on top of the other.
  const drawnConnections = useMemo(() => {
    const filtered =
      lens === 'all'
        ? connectionResult.connections
        : connectionResult.connections.filter((c) => c.family === lens);
    const shown = filtered.slice(0, MAX_CONNECTORS);
    const perPair = new Map<string, number>();
    for (const connection of shown) {
      perPair.set(connection.otherAreaId, (perPair.get(connection.otherAreaId) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return shown.map((connection) => {
      const index = seen.get(connection.otherAreaId) ?? 0;
      seen.set(connection.otherAreaId, index + 1);
      return { connection, offset: { index, count: perPair.get(connection.otherAreaId) ?? 1 } };
    });
  }, [connectionResult, lens]);

  // A selection made elsewhere (Pulse/Trails hand-off) must not leave a stale
  // expanded bridge from the previous area behind.
  useEffect(() => {
    setOpenConnectionId(null);
  }, [selectedAreaId]);

  useEffect(() => {
    const el = mapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setMapWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selectedArea = selectedAreaId ? index.byId.get(selectedAreaId) ?? null : null;
  const connectedAreaIds = useMemo(
    () => new Set(drawnConnections.map((d) => d.connection.otherAreaId)),
    [drawnConnections],
  );

  const focusTile = useCallback((areaId: string | undefined) => {
    if (!areaId) return;
    tileRefs.current.get(areaId)?.focus();
  }, []);

  const onTileKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, areaId: string) => {
      // Arrow / Home / End only, and only while a territory has focus. This view
      // installs no window-level listeners and swallows no application keys --
      // a modified chord (Cmd/Ctrl/Alt + arrow) belongs to the app, so bail out
      // before anything here could call preventDefault on it.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Resolved against the drawn boxes: persistent slots leave holes, so
      // index arithmetic would aim at ground no territory occupies.
      const next = moveTerritoryFocus(layout.boxes, areaId, event.key);
      if (!next) return;
      event.preventDefault();
      focusTile(next);
    },
    [layout.boxes, focusTile],
  );

  const totalRecords = model.nodeById.size;

  if (index.order.length === 0) {
    return (
      <div className="pga-root">
        <p className="pga-empty pga-empty-page">
          This model has no areas. Nothing is mapped, so the Atlas shows nothing rather than
          inventing territories. {totalRecords.toLocaleString()} records are loaded.
        </p>
      </div>
    );
  }

  return (
    <div className="pga-root">
      <header className="pga-header">
        <div>
          <h1 className="pga-title">A project you can navigate</h1>
          <p className="pga-subtitle">
            Stable areas first. Select one to reveal only the relationships that explain it.
          </p>
        </div>
        <p className="pga-header-stats">
          {index.order.length} areas · {totalRecords.toLocaleString()} records loaded
          {index.unclaimedNodeCount > 0
            ? ` · ${index.unclaimedNodeCount.toLocaleString()} in no area`
            : ''}
          {model.coverage.length > 0
            ? ` · ${model.coverage.length} source limitation${model.coverage.length === 1 ? '' : 's'} apply`
            : ''}
        </p>
      </header>

      <div className="pga-body">
        <div className="pga-map-scroll">
          <div className="pga-map" ref={mapRef} style={{ height: layout.height }}>
            <svg
              className="pga-connectors"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
              focusable="false"
            >
              {selectedArea &&
                drawnConnections.map(({ connection, offset }) => {
                  const from = boxById.get(selectedArea.id);
                  const to = boxById.get(connection.otherAreaId);
                  if (!from || !to) return null;
                  const path = connectorPath(from, to, offset);
                  return (
                    <path
                      key={connection.id}
                      d={path.d}
                      className={[
                        'pga-connector',
                        `pga-connector-${connection.family}`,
                        connection.id === openConnectionId ? 'is-open' : '',
                      ].filter(Boolean).join(' ')}
                    />
                  );
                })}
            </svg>

            {index.order.map((area) => {
              const box = boxById.get(area.id);
              if (!box) return null;
              const standing = standings.get(area.id);
              const stats = activity.byArea.get(area.id);
              const isSelected = area.id === selectedAreaId;
              const isDim = Boolean(selectedArea) && !isSelected && !connectedAreaIds.has(area.id);
              const events = stats?.events ?? 0;
              const touched = stats?.touched ?? 0;
              // Fraction of this area's own records, not a share of the busiest
              // area -- see the note on AreaActivity.share.
              const share = stats?.share ?? 0;
              const recordedShare = touched > 0 ? (stats?.touchedRecorded ?? 0) / touched : 0;
              const activityText =
                events > 0
                  ? `${touched.toLocaleString()} of ${(stats?.members ?? 0).toLocaleString()} records active (${Math.round(share * 100)}%) · ${events.toLocaleString()} events in range`
                  : 'No activity recorded in range';

              return (
                <button
                  key={area.id}
                  type="button"
                  ref={(el) => {
                    if (el) tileRefs.current.set(area.id, el);
                    else tileRefs.current.delete(area.id);
                  }}
                  className={[
                    'pga-territory',
                    isSelected ? 'is-selected' : '',
                    isDim ? 'is-dim' : '',
                    area === index.unassigned ? 'is-unassigned' : '',
                  ].filter(Boolean).join(' ')}
                  style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                  aria-pressed={isSelected}
                  aria-label={`${area.label}. ${plural(standing?.total ?? 0, 'record')}. ${activityText}.`}
                  onClick={() => onSelectArea(isSelected ? null : area.id)}
                  onKeyDown={(e) => onTileKeyDown(e, area.id)}
                >
                  <span className="pga-territory-name">{area.label}</span>
                  <span className="pga-territory-basis" title={area.basis}>{area.basis}</span>
                  <span className="pga-territory-counts">
                    {plural(standing?.total ?? 0, 'record')} · {(standing?.open ?? 0).toLocaleString()} with
                    no recorded close
                  </span>
                  <span className="pga-activity-bar" aria-hidden="true">
                    {touched > 0 ? (
                      <span className="pga-activity-fill" style={{ width: `${Math.max(share * 100, 3)}%` }}>
                        <span className="pga-activity-recorded" style={{ width: `${recordedShare * 100}%` }} />
                      </span>
                    ) : (
                      <span className="pga-activity-none" />
                    )}
                  </span>
                  <span className={events > 0 ? 'pga-territory-activity' : 'pga-territory-activity is-quiet'}>
                    {activityText}
                  </span>
                  {standing && standing.topTypes.length > 0 && (
                    <span className="pga-territory-types">
                      {standing.topTypes.map((t) => `${t.type} ×${t.count}`).join(' · ')}
                    </span>
                  )}
                </button>
              );
            })}

            {selectedArea &&
              drawnConnections.map(({ connection, offset }) => {
                const from = boxById.get(selectedArea.id);
                const to = boxById.get(connection.otherAreaId);
                if (!from || !to) return null;
                const path = connectorPath(from, to, offset);
                return (
                  <button
                    key={connection.id}
                    type="button"
                    className={[
                      'pga-bridge',
                      `pga-bridge-${connection.family}`,
                      connection.id === openConnectionId ? 'is-open' : '',
                    ].filter(Boolean).join(' ')}
                    style={{ left: path.midX, top: path.midY }}
                    aria-label={`${selectedArea.label} to ${connection.otherAreaLabel}: ${connection.explanation}`}
                    onClick={() => {
                      setTab('connections');
                      setOpenConnectionId(openConnectionId === connection.id ? null : connection.id);
                    }}
                  >
                    {connection.count.toLocaleString()} {CONNECTION_FAMILY_SHORT[connection.family]}
                  </button>
                );
              })}
          </div>
        </div>

        {selectedArea ? (
          <AreaDetailPanel
            key={selectedArea.id}
            model={model}
            index={index}
            area={selectedArea}
            standing={standings.get(selectedArea.id)}
            activity={activity.byArea.get(selectedArea.id)}
            range={range}
            connections={connectionResult.connections}
            internalEdges={connectionResult.internalEdges}
            lens={lens}
            onLensChange={setLens}
            openConnectionId={openConnectionId}
            onOpenConnection={setOpenConnectionId}
            tab={tab}
            onTabChange={setTab}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
            onOpenNode={onOpenNode}
            onNavigate={onNavigate}
            onRenameArea={onRenameArea}
          />
        ) : (
          <aside className="pga-detail pga-detail-empty" aria-label="Area detail">
            <div className="pga-eyebrow">No area selected</div>
            <p>
              Select a territory to see its records, its activity in the selected range, and the
              connections that explain it.
            </p>
            <p className="pga-hint">
              Areas can overlap. Counts deduplicate inside an area and are not additive across areas.
            </p>
            {activity.totalEvents > 0 && (
              <p className="pga-detail-counts">
                {activity.totalEvents.toLocaleString()} events in the selected range
                {activity.unmappedEvents > 0
                  ? ` · ${activity.unmappedEvents.toLocaleString()} belong to records in no area`
                  : ''}
              </p>
            )}
            {/* The shell's Sources & limitations disclosure is the authority on
                coverage; restating all of it here just crowds the map. */}
            {model.coverage.length > 0 && (
              <p className="pga-hint">
                Every count here inherits the source limitations listed under Sources &amp; limitations.
              </p>
            )}
          </aside>
        )}
      </div>

      <footer className="pga-footer">
        <span className="pga-legend">
          <i className="pga-swatch pga-swatch-recorded" /> Record with a recorded event
          <i className="pga-swatch pga-swatch-observed" /> Last-observed only
        </span>
        <span className="pga-footer-note">
          Bar length is the share of an area&apos;s own records active in range. Geography is fixed; the date range
          moves the overlay only.
        </span>
        <span className="pga-footer-spacer" />
        {index.unassigned ? (
          <button
            type="button"
            className="pga-mini-btn"
            onClick={() => onSelectArea(index.unassigned!.id)}
          >
            Unassigned: {plural(index.unassigned.nodeIds.length, 'record')}
          </button>
        ) : (
          <span className="pga-footer-note">No Unassigned area in this model.</span>
        )}
      </footer>
    </div>
  );
}
