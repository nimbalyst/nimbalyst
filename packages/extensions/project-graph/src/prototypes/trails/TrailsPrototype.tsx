/**
 * Evidence Trails prototype.
 *
 * One focused artifact at a time, its recorded relations grouped into named
 * lanes, and an inspector that says what supports each connection. It is not a
 * whole-project picture and does not try to be: the hairball is the thing this
 * view exists to avoid.
 *
 * Shared state comes from the shell — the selected node is the trail's centre,
 * the selected area scopes the starting list, and the date range highlights
 * recent evidence without hiding older context.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProjectGraphNode } from '../../types';
import type { PrototypeViewProps } from '../contracts';
import {
  buildNeighborhood,
  buildSecondHop,
  buildTrailsIndex,
  degreeOf,
  describeCreation,
  describeEvent,
  describeGaps,
  explicitDegreeOf,
  findStartingArtifacts,
  formatCount,
  formatRange,
  latestEvent,
  type NeighborRef,
} from './trailsModel';
import './trails.css';

const START_LIMIT = 60;
const LANE_LIMIT = 6;
const LANE_PAGE = 5;
const SECOND_HOP_LIMIT = 6;
const CRUMB_LIMIT = 4;

function kindLabel(node: ProjectGraphNode): string {
  return node.type.replace(/[_-]+/g, ' ');
}

/** Coarse tone from the record's source, which is a closed enum (types are not). */
function toneFor(node: ProjectGraphNode): string {
  return `pg-trails-tone-${node.source}`;
}

export function TrailsPrototype(props: PrototypeViewProps): JSX.Element {
  const { model, range, selectedAreaId, selectedNodeId } = props;
  const { onSelectArea, onSelectNode, onOpenNode, onNavigate, onResolveNode } = props;

  const index = useMemo(() => buildTrailsIndex(model), [model]);

  const [focusId, setFocusId] = useState<string | null>(selectedNodeId);
  const [trail, setTrail] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const [perLane, setPerLane] = useState<Record<string, number>>({});
  const [laneLimit, setLaneLimit] = useState(LANE_LIMIT);
  const [includePathDerived, setIncludePathDerived] = useState(true);
  const [scopeToArea, setScopeToArea] = useState(true);
  const [activeStart, setActiveStart] = useState(0);

  // The shell owns selection. When it changes the node under us the trail is a
  // new trail, not a continuation of the old one.
  const externalRef = useRef(selectedNodeId);
  useEffect(() => {
    if (selectedNodeId === externalRef.current) return;
    externalRef.current = selectedNodeId;
    setFocusId(selectedNodeId);
    setTrail([]);
    setInspectedKey(null);
    setPerLane({});
    setLaneLimit(LANE_LIMIT);
  }, [selectedNodeId]);

  const area = useMemo(
    () => model.areas.find(a => a.id === selectedAreaId) ?? null,
    [model.areas, selectedAreaId],
  );
  const areaNodeIds = useMemo(
    () => (area && scopeToArea ? new Set(area.nodeIds) : null),
    [area, scopeToArea],
  );

  const starting = useMemo(
    () => findStartingArtifacts(model, index, { query, areaNodeIds, limit: START_LIMIT, range }),
    [model, index, query, areaNodeIds, range],
  );

  const neighborhood = useMemo(
    () =>
      buildNeighborhood(model, index, focusId, range, {
        perLane: key => perLane[key] ?? LANE_PAGE,
        laneLimit,
        includePathDerived,
      }),
    [model, index, focusId, range, perLane, laneLimit, includePathDerived],
  );

  const inspected: NeighborRef | null = useMemo(() => {
    if (!inspectedKey) return null;
    for (const lane of neighborhood.lanes) {
      const hit = lane.neighbors.find(n => n.key === inspectedKey);
      if (hit) return hit;
    }
    return null;
  }, [inspectedKey, neighborhood]);

  const secondHop = useMemo(() => {
    if (!inspected || !focusId) return null;
    return buildSecondHop(model, index, inspected.node.id, focusId, range, SECOND_HOP_LIMIT);
  }, [model, index, inspected, focusId, range]);

  const gaps = useMemo(() => describeGaps(model, neighborhood), [model, neighborhood]);

  const recenter = useCallback(
    (id: string) => {
      setTrail(prev => (focusId && focusId !== id ? [...prev, focusId] : prev));
      externalRef.current = id;
      setFocusId(id);
      setInspectedKey(null);
      setPerLane({});
      setLaneLimit(LANE_LIMIT);
      onSelectNode(id);
    },
    [focusId, onSelectNode],
  );

  // Both of these rewind the trail rather than extending it, so they slice the
  // history outside the state updater -- an updater that called `onSelectNode`
  // would fire it twice under StrictMode's double invocation.
  const rewindTo = useCallback(
    (position: number) => {
      const target = trail[position];
      if (!target) return;
      setTrail(trail.slice(0, position));
      externalRef.current = target;
      setFocusId(target);
      setInspectedKey(null);
      setPerLane({});
      setLaneLimit(LANE_LIMIT);
      onSelectNode(target);
    },
    [trail, onSelectNode],
  );

  const goBack = useCallback(() => rewindTo(trail.length - 1), [rewindTo, trail.length]);

  const startItems = starting.items;
  const activeIndex = startItems.length === 0 ? -1 : Math.min(activeStart, startItems.length - 1);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-start-index="${activeIndex}"]`);
    // jsdom has no scrollIntoView; guard rather than depend on a global stub.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  // Scoped to the listbox: no document-level listener, and nothing the
  // surrounding application would otherwise act on. A held modifier means the
  // chord belongs to the app (Cmd+Arrow, Alt+Arrow, Ctrl+Enter), so bail before
  // any preventDefault rather than swallowing it inside the list.
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (startItems.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveStart(Math.min(activeIndex + 1, startItems.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveStart(Math.max(activeIndex - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveStart(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveStart(startItems.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const node = startItems[activeIndex];
      if (node) recenter(node.id);
    }
  };

  const focus = neighborhood.focus;
  const memberships = focus ? (model.memberships.get(focus.id) ?? []) : [];
  const focusEvent = focus ? latestEvent(index, focus.id) : null;
  const crumbs = trail.slice(-CRUMB_LIMIT);
  const crumbOffset = trail.length - crumbs.length;

  return (
    <div className="pg-trails">
      <section className="pg-trails-start" aria-label="Starting artifacts">
        <header className="pg-trails-start-head">
          <h2>Start from</h2>
          {area ? (
            <button
              type="button"
              className="pg-trails-toggle"
              aria-pressed={scopeToArea}
              onClick={() => setScopeToArea(v => !v)}
              title={area.basis}
            >
              {scopeToArea ? `Scoped to ${area.label}` : 'All records'}
            </button>
          ) : null}
        </header>
        <input
          type="search"
          className="pg-trails-search"
          placeholder="Search records"
          aria-label="Search starting artifacts"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setActiveStart(0);
          }}
          onKeyDown={e => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'ArrowDown' && startItems.length > 0) {
              e.preventDefault();
              setActiveStart(0);
              listRef.current?.focus();
            }
          }}
        />
        <p className="pg-trails-note">
          {formatCount(startItems.length, starting.total, 'match')}
          {area && scopeToArea ? ` in ${area.label} (${starting.scopeTotal} records)` : ` of ${starting.scopeTotal} records`}
          {starting.total > startItems.length ? ' · narrow the search to reach the rest' : ''}
        </p>
        <p className="pg-trails-note">
          {query.trim()
            ? 'Name matches first, then most recent event.'
            : 'Ranked by evidence in range, then artifacts ahead of directory rollups, then explicit links.'}
        </p>
        <div
          className="pg-trails-list"
          role="listbox"
          tabIndex={0}
          ref={listRef}
          aria-label="Starting artifacts"
          aria-activedescendant={activeIndex >= 0 ? `pg-trails-start-${activeIndex}` : undefined}
          onKeyDown={onListKeyDown}
        >
          {startItems.length === 0 ? (
            <p className="pg-trails-empty">No record matches this search in the current scope.</p>
          ) : null}
          {startItems.map((node, i) => {
            const linked = degreeOf(index, node.id);
            const explicit = explicitDegreeOf(model, index, node.id);
            return (
              <div
                key={node.id}
                id={`pg-trails-start-${i}`}
                data-start-index={i}
                role="option"
                aria-selected={node.id === focusId}
                className={`pg-trails-start-item ${i === activeIndex ? 'is-active' : ''} ${node.id === focusId ? 'is-focus' : ''}`}
                onClick={() => {
                  setActiveStart(i);
                  recenter(node.id);
                }}
              >
                <span className={`pg-trails-kind ${toneFor(node)}`}>{kindLabel(node)}</span>
                <span className="pg-trails-start-label">{node.label}</span>
                <span className="pg-trails-start-meta">
                  {linked === 0
                    ? 'no recorded connections'
                    : `${explicit} explicit of ${linked} connection${linked === 1 ? '' : 's'}`}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="pg-trails-canvas" aria-label="Evidence trail">
        <div className="pg-trails-crumbs">
          <button type="button" className="pg-trails-btn" onClick={goBack} disabled={trail.length === 0}>
            ← Back
          </button>
          {crumbOffset > 0 ? <span className="pg-trails-note">+{crumbOffset} earlier</span> : null}
          {crumbs.map((id, i) => (
            <button
              key={`${id}-${i}`}
              type="button"
              className="pg-trails-crumb"
              onClick={() => rewindTo(crumbOffset + i)}
            >
              {model.nodeById.get(id)?.label ?? id}
            </button>
          ))}
          {focus ? <span className="pg-trails-crumb is-current">{focus.label}</span> : null}
        </div>

        {!focus ? (
          <div className="pg-trails-blank">
            <h2>Pick a starting artifact</h2>
            <p>
              A trail starts from one record and shows only its recorded relations, one or two hops out. Search on the
              left, or take one of the suggestions there.
            </p>
            <p className="pg-trails-note">
              With no search, suggestions are ranked by evidence inside the current range, then named artifacts ahead
              of directory rollups, then explicitly linked connections, then the most recent recorded event. That is
              the whole rule — it is not a relevance model. Directories and records with no connections are ranked
              lower, never excluded: search by name reaches every record in scope.
            </p>
            <p className="pg-trails-note">
              Current range {formatRange(range)} highlights recent evidence. Older records stay reachable; nothing here
              is filtered out by date.
            </p>
          </div>
        ) : (
          <>
            <article className={`pg-trails-focus ${toneFor(focus)}`}>
              <div className="pg-trails-focus-head">
                <span className={`pg-trails-kind ${toneFor(focus)}`}>{kindLabel(focus)}</span>
                <span className="pg-trails-note">{focus.source} · {focus.visibility}</span>
                {focus.status ? <span className="pg-trails-status">{focus.status}</span> : null}
              </div>
              <h2 className="select-text">{focus.label}</h2>
              {focus.sublabel ? <p className="pg-trails-note select-text">{focus.sublabel}</p> : null}
              {/* Dates come from recorded events only. `node.createdAt` and
                  `node.closedAt` can be inferred (loader back-fills undated
                  nodes from a neighbor), so neither is printed as observed. */}
              <p className="pg-trails-note">
                {describeCreation(index, focus.id)} · {describeEvent(focusEvent)}
              </p>
              <div className="pg-trails-actions">
                <button type="button" className="pg-trails-btn" onClick={() => onOpenNode(focus)}>
                  Open source record
                </button>
                <button type="button" className="pg-trails-btn" onClick={() => onNavigate('atlas', focus.id, selectedAreaId ?? undefined)}>
                  Show in Atlas
                </button>
                <button type="button" className="pg-trails-btn" onClick={() => onNavigate('pulse', focus.id, selectedAreaId ?? undefined)}>
                  Show in Pulse
                </button>
              </div>
              {memberships.length > 0 ? (
                <div className="pg-trails-membership">
                  <span className="pg-trails-eyebrow">Area membership — a grouping, not a recorded relation</span>
                  <div className="pg-trails-chiprow">
                    {memberships.map(m => {
                      const label = model.areas.find(a => a.id === m.areaId)?.label ?? m.areaId;
                      return (
                        <button
                          key={m.areaId}
                          type="button"
                          className="pg-trails-chip"
                          title={m.basis}
                          onClick={() => onSelectArea(m.areaId)}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </article>

            <div className="pg-trails-summary">
              <span>
                {formatCount(neighborhood.connectionShown, neighborhood.connectionTotal, 'recorded connection')}
                {' shown'}
              </span>
              <span className="pg-trails-note">
                {neighborhood.inRangeTotal} with evidence in {formatRange(range)}
              </span>
              {neighborhood.census.resolved > 0 ? (
                <span className="pg-trails-note">
                  {neighborhood.census.explicit} explicit · {neighborhood.census.pathDerived} path containment
                </span>
              ) : null}
              <button
                type="button"
                className="pg-trails-toggle"
                aria-pressed={includePathDerived}
                onClick={() => setIncludePathDerived(v => !v)}
              >
                {includePathDerived
                  ? 'Path containment shown'
                  : `Path containment hidden (${neighborhood.hiddenPathDerived})`}
              </button>
            </div>

            {neighborhood.connectionTotal === 0 ? (
              <div className="pg-trails-unlinked">
                <h3>No links in the loaded snapshot</h3>
                <p>
                  Nothing in the loaded snapshot links this record to another one. Every source here is
                  bounded, so a record carrying a link to it may simply not have been loaded — this says
                  what was loaded, not what the sources hold.
                </p>
                <p className="pg-trails-note">
                  {memberships.length > 0
                    ? 'It does belong to an area above. Membership is a grouping rule, and suggests where to look next — it is not a relation between records.'
                    : 'It also has no area membership, so there is no grouping to suggest where to look next.'}
                </p>
              </div>
            ) : null}

            {neighborhood.unresolvedRefs.length > 0 ? (
              <section
                className="pg-trails-unresolved"
                aria-label={`Unresolved endpoints (${neighborhood.unresolved})`}
              >
                <header className="pg-trails-unresolved-head">
                  <span className="pg-trails-relation">Unresolved endpoints</span>
                  <span className="pg-trails-note">
                    {formatCount(neighborhood.unresolvedRefs.length, neighborhood.unresolved, 'link')}
                  </span>
                </header>
                <p className="pg-trails-note">
                  These links are recorded, but the record at the other end is not in this view — either
                  it was not indexed, or its type is filtered out here. The id is what the link names;
                  opening one shows whatever the sources hold for it.
                </p>
                <ul className="pg-trails-unresolved-list">
                  {neighborhood.unresolvedRefs.map(ref => (
                    <li key={ref.key} className="pg-trails-unresolved-row">
                      <span className="pg-trails-relation">
                        {ref.direction === 'out' ? '→' : '←'} {ref.descriptor.label}
                      </span>
                      <code className="pg-trails-unresolved-id">{ref.missingId}</code>
                      {onResolveNode ? (
                        <button
                          type="button"
                          className="pg-trails-btn"
                          onClick={() => onResolveNode(ref.missingId)}
                        >
                          Open this record
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="pg-trails-lanes">
              {neighborhood.lanes.map(lane => {
                const shown = lane.neighbors.length;
                return (
                  <section
                    key={lane.key}
                    className={`pg-trails-lane pg-trails-basis-${lane.descriptor.kind}`}
                    aria-label={`${lane.descriptor.label}, ${lane.direction === 'out' ? 'outgoing' : 'incoming'}, ${lane.total} connections`}
                  >
                    <header className="pg-trails-lane-head">
                      <span className="pg-trails-relation">
                        {lane.direction === 'out' ? '→' : '←'} {lane.descriptor.label}
                      </span>
                      <span className="pg-trails-basis-tag">{lane.descriptor.kind}</span>
                      <span className="pg-trails-note">{formatCount(shown, lane.total, 'record')}</span>
                      {lane.inRangeCount > 0 ? (
                        <span className="pg-trails-note">{lane.inRangeCount} recent</span>
                      ) : null}
                    </header>
                    <p className="pg-trails-note pg-trails-lane-basis">{lane.descriptor.basis}</p>
                    <div className="pg-trails-chiprow">
                      {lane.neighbors.map(ref => (
                        <button
                          key={ref.key}
                          type="button"
                          className={`pg-trails-node ${toneFor(ref.node)} ${ref.key === inspectedKey ? 'is-inspected' : ''}`}
                          aria-pressed={ref.key === inspectedKey}
                          onClick={() => setInspectedKey(ref.key === inspectedKey ? null : ref.key)}
                        >
                          <span className="pg-trails-node-kind">{kindLabel(ref.node)}</span>
                          <span className="pg-trails-node-label">{ref.node.label}</span>
                          <span className="pg-trails-node-meta">
                            {ref.inRange ? 'recent evidence · ' : ''}
                            {ref.degree} connection{ref.degree === 1 ? '' : 's'}
                          </span>
                        </button>
                      ))}
                    </div>
                    {shown < lane.total ? (
                      <button
                        type="button"
                        className="pg-trails-btn pg-trails-more"
                        onClick={() => setPerLane(prev => ({ ...prev, [lane.key]: shown + LANE_PAGE }))}
                      >
                        Show {Math.min(LANE_PAGE, lane.total - shown)} more of {lane.total}
                      </button>
                    ) : null}
                  </section>
                );
              })}
              {neighborhood.laneTotal > neighborhood.lanes.length ? (
                <button
                  type="button"
                  className="pg-trails-btn pg-trails-more"
                  onClick={() => setLaneLimit(neighborhood.laneTotal)}
                >
                  Show {neighborhood.laneTotal - neighborhood.lanes.length} more relation type
                  {neighborhood.laneTotal - neighborhood.lanes.length === 1 ? '' : 's'}
                </button>
              ) : null}
            </div>

            {gaps.length > 0 ? (
              <section className="pg-trails-gaps" aria-label="What this trail does not establish">
                <span className="pg-trails-eyebrow">What this trail does not establish</span>
                <ul>
                  {gaps.map(gap => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </section>

      <aside className="pg-trails-inspect" aria-label="Connection inspector">
        {inspected && focus ? (
          <>
            <span className="pg-trails-eyebrow">
              {focus.label} {inspected.direction === 'out' ? '→' : '←'} {inspected.descriptor.label}
            </span>
            <h2 className="select-text">{inspected.node.label}</h2>
            <p className="pg-trails-note select-text">
              {kindLabel(inspected.node)} · {inspected.node.source}
              {inspected.node.status ? ` · ${inspected.node.status}` : ''}
            </p>
            <div className="pg-trails-rule" />
            <h3>What supports this connection</h3>
            <p className={`pg-trails-basis-line pg-trails-basis-${inspected.descriptor.kind}`}>
              {inspected.descriptor.basis}
            </p>
            <p className="pg-trails-note">
              Recorded as <code>{inspected.edge.type}</code>
              {inspected.edge.strength != null ? ` · strength ${inspected.edge.strength}` : ''} ·{' '}
              {inspected.descriptor.kind === 'explicit'
                ? 'explicit link in the source'
                : inspected.descriptor.kind === 'derived'
                  ? 'derived by a stated rule'
                  : 'basis not stated by the source'}
            </p>
            <div className="pg-trails-rule" />
            <h3>This record</h3>
            <p className="pg-trails-note">
              {describeCreation(index, inspected.node.id)} · {describeEvent(inspected.latest)}
            </p>
            <p className="pg-trails-note">
              {inspected.inRange
                ? `Has evidence inside ${formatRange(range)}.`
                : `No evidence inside ${formatRange(range)}. It stays reachable as older context.`}
            </p>
            <div className="pg-trails-actions">
              <button type="button" className="pg-trails-btn" onClick={() => onOpenNode(inspected.node)}>
                Open source ↗
              </button>
              <button type="button" className="pg-trails-btn" onClick={() => recenter(inspected.node.id)}>
                Recenter trail
              </button>
            </div>
            <div className="pg-trails-rule" />
            <h3>
              From here{' '}
              <span className="pg-trails-note">
                {secondHop ? formatCount(secondHop.items.length, secondHop.total, 'further connection') : ''}
              </span>
            </h3>
            {secondHop && secondHop.total === 0 ? (
              <p className="pg-trails-note">Nothing beyond this trail is recorded for this record.</p>
            ) : null}
            {secondHop?.items.map(ref => (
              <button
                key={ref.key}
                type="button"
                className="pg-trails-hop"
                onClick={() => recenter(ref.node.id)}
              >
                <span className="pg-trails-relation">
                  {ref.direction === 'out' ? '→' : '←'} {ref.descriptor.label}
                </span>
                <span className="pg-trails-node-label">{ref.node.label}</span>
                <span className="pg-trails-node-meta">{kindLabel(ref.node)}</span>
              </button>
            ))}
          </>
        ) : (
          <>
            <span className="pg-trails-eyebrow">Inspector</span>
            <p>
              Select a record in a lane to see what supports its connection, where it leads next, and what the sources
              do not say.
            </p>
            <div className="pg-trails-rule" />
            <h3>How to read a lane</h3>
            <p className="pg-trails-note">
              Lane names are the snapshot's own relation names. <strong>Explicit</strong> means a link recorded in the
              source. <strong>Derived</strong> means a stated rule produced it — path containment, for instance, which
              says where a file is filed, not what it is about. <strong>Unknown</strong> means the source did not say.
            </p>
            <div className="pg-trails-rule" />
            <h3>Time scope</h3>
            <p className="pg-trails-note">
              {formatRange(range)} decides what is marked <em>recent evidence</em> and what sorts first. It never
              removes a connection: an older decision stays on the trail as context.
            </p>
            {model.source === 'sample' ? (
              <p className="pg-trails-note">Sample records — content and counts are illustrative.</p>
            ) : (
              <p className="pg-trails-note">
                Live records from this project's loaded snapshot, within the adapters' own bounds.
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

export default TrailsPrototype;
