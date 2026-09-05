import { useMemo, useRef, useState } from 'react';
import type { ProjectGraphNode } from '../../types';
import type { PrototypeArea, PrototypeEvent, PrototypeModel, PrototypeRange, PrototypeViewProps } from '../contracts';
import { eventsInRange } from '../contracts';
import {
  CONNECTION_FAMILY_LABEL,
  CONNECTION_FAMILY_SHORT,
  describeNode,
  formatRelationSummary,
  plural,
  type AreaActivity,
  type AreaConnection,
  type AreaIndex,
  type AreaStanding,
  type ConnectionFamily,
  type InternalEdgeCensus,
  type LinkFamily,
} from './atlasModel';

/**
 * "N edges stay inside this area" reads as recorded work, so the split by
 * provenance is stated rather than summed: a path-synthesized edge between two
 * records that happen to be filed together is not the same fact.
 */
function describeInternalEdges(census: InternalEdgeCensus): string {
  const parts = (Object.entries(census.byFamily) as Array<[LinkFamily, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([family, count]) => `${count} ${CONNECTION_FAMILY_SHORT[family]}`);
  return `${census.total.toLocaleString()} edge${census.total === 1 ? '' : 's'} stay inside this area (${parts.join(', ')})`;
}

export type RelationLens = 'all' | ConnectionFamily;
type DetailTab = 'connections' | 'activity' | 'records';

/** Every list in this panel is paged; nothing renders a 3,000-row detail view. */
const PAGE = 25;
const MAX_ROWS = 300;

export interface AreaDetailPanelProps {
  model: PrototypeModel;
  index: AreaIndex;
  area: PrototypeArea;
  standing: AreaStanding | undefined;
  activity: AreaActivity | undefined;
  range: PrototypeRange;
  connections: AreaConnection[];
  internalEdges: InternalEdgeCensus;
  lens: RelationLens;
  onLensChange: (lens: RelationLens) => void;
  openConnectionId: string | null;
  onOpenConnection: (id: string | null) => void;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  selectedNodeId: string | null;
  onSelectNode: PrototypeViewProps['onSelectNode'];
  onOpenNode: PrototypeViewProps['onOpenNode'];
  onNavigate: PrototypeViewProps['onNavigate'];
  onRenameArea: PrototypeViewProps['onRenameArea'];
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AreaDetailPanel(props: AreaDetailPanelProps) {
  const {
    model, index, area, standing, activity, range, connections, internalEdges,
    lens, onLensChange, openConnectionId, onOpenConnection, tab, onTabChange,
    selectedNodeId, onSelectNode, onOpenNode, onNavigate, onRenameArea,
  } = props;

  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [connectionRows, setConnectionRows] = useState(PAGE);
  const [evidenceRows, setEvidenceRows] = useState(PAGE);
  const [activityRows, setActivityRows] = useState(PAGE);
  const [recordRows, setRecordRows] = useState(PAGE);
  const renameInput = useRef<HTMLInputElement | null>(null);

  const visibleConnections = useMemo(
    () => (lens === 'all' ? connections : connections.filter((c) => c.family === lens)),
    [connections, lens],
  );
  const openConnection = visibleConnections.find((c) => c.id === openConnectionId) ?? null;
  // Lenses that match something here, plus whichever one is selected. Dropping
  // the selected family when it happens to be empty would leave the control
  // showing a value it does not offer, and would read as a missing control
  // rather than as an empty family.
  const presentFamilies = useMemo(() => {
    const seen: ConnectionFamily[] = [];
    for (const c of connections) if (!seen.includes(c.family)) seen.push(c.family);
    if (lens !== 'all' && !seen.includes(lens)) seen.push(lens);
    return seen;
  }, [connections, lens]);

  const areaEvents = useMemo(() => {
    const nodes = index.nodeSetByArea.get(area.id);
    if (!nodes) return [] as PrototypeEvent[];
    return eventsInRange(model, range)
      .filter((event) => nodes.has(event.nodeId))
      .sort((a, b) => b.at - a.at);
  }, [model, index, area.id, range]);

  const areaRecords = useMemo(() => {
    const out: ProjectGraphNode[] = [];
    for (const nodeId of index.nodeSetByArea.get(area.id) ?? []) {
      const node = model.nodeById.get(nodeId);
      if (node) out.push(node);
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [model, index, area.id]);

  const commitRename = () => {
    const next = (renameDraft ?? '').trim();
    if (next && next !== area.label) onRenameArea(area.id, next);
    setRenameDraft(null);
  };

  const selectEvidenceNode = (nodeId: string) => {
    onSelectNode(selectedNodeId === nodeId ? null : nodeId);
  };

  const renderRowActions = (node: ProjectGraphNode) => (
    <span className="pga-row-actions">
      <button
        type="button"
        className="pga-mini-btn"
        onClick={(e) => { e.stopPropagation(); onOpenNode(node); }}
      >
        Open
      </button>
      <button
        type="button"
        className="pga-mini-btn"
        onClick={(e) => { e.stopPropagation(); onNavigate('trails', node.id, area.id); }}
      >
        Trail
      </button>
    </span>
  );

  const shownCount = (shown: number, total: number, unit: string) =>
    `Showing ${Math.min(shown, total)} of ${total} ${unit}`;

  return (
    <aside className="pga-detail" aria-label={`Area detail: ${area.label}`}>
      <div className="pga-detail-head">
        <div className="pga-eyebrow">Selected area</div>
        {renameDraft === null ? (
          <div className="pga-detail-title-row">
            <h2 className="pga-detail-title">{area.label}</h2>
            <button
              type="button"
              className="pga-mini-btn"
              onClick={() => {
                setRenameDraft(area.label);
                window.requestAnimationFrame(() => renameInput.current?.select());
              }}
            >
              Rename
            </button>
          </div>
        ) : (
          <div className="pga-rename">
            <input
              ref={renameInput}
              className="pga-rename-input"
              aria-label="Area display name"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                // Scoped to this input only -- the view installs no global keys.
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenameDraft(null); }
              }}
            />
            <button type="button" className="pga-mini-btn" onClick={commitRename}>Save</button>
            <button type="button" className="pga-mini-btn" onClick={() => setRenameDraft(null)}>Cancel</button>
            <p className="pga-hint">Display name for this view only. Source tags and records are unchanged.</p>
          </div>
        )}
        <p className="pga-basis">{area.basis}</p>
        <p className="pga-detail-counts">
          {standing
            ? `${plural(standing.total, 'record')} all-time · ${standing.open.toLocaleString()} with no recorded close`
            : 'No standing computed'}
          {standing && standing.resolved < standing.total
            ? ` · ${(standing.total - standing.resolved).toLocaleString()} not resolvable in the loaded snapshot`
            : ''}
        </p>
        <p className="pga-detail-counts">
          {activity && activity.events > 0
            ? `In range: ${activity.touched.toLocaleString()} of ${activity.members.toLocaleString()} records active (${Math.round(activity.share * 100)}%) · ${activity.recorded.toLocaleString()} recorded events · ${activity.lastObserved.toLocaleString()} last-observed markers`
            : 'No activity recorded for this area in the selected range.'}
        </p>
        <div className="pga-detail-nav">
          <button type="button" className="pga-mini-btn" onClick={() => onNavigate('pulse', undefined, area.id)}>
            See this area in Pulse
          </button>
          <button type="button" className="pga-mini-btn" onClick={() => onNavigate('trails', undefined, area.id)}>
            Open a trail here
          </button>
        </div>
      </div>

      <div className="pga-tabs" role="tablist" aria-label="Area detail sections">
        {(['connections', 'activity', 'records'] as DetailTab[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls="pga-detail-body"
            className={tab === id ? 'pga-tab is-active' : 'pga-tab'}
            onClick={() => onTabChange(id)}
          >
            {id === 'connections' ? 'Connections' : id === 'activity' ? 'Activity' : 'Records'}
          </button>
        ))}
      </div>

      <div className="pga-detail-body" id="pga-detail-body" role="tabpanel">
        {tab === 'connections' && (
          <>
            <label className="pga-lens">
              <span>Relation lens</span>
              <select
                value={lens}
                onChange={(e) => { onLensChange(e.target.value as RelationLens); onOpenConnection(null); }}
              >
                <option value="all">All relations</option>
                {presentFamilies.map((family) => (
                  <option key={family} value={family}>
                    {CONNECTION_FAMILY_LABEL[family]} only
                  </option>
                ))}
              </select>
            </label>
            <p className="pga-hint">
              Only connections for the selected area are drawn. Recorded links, derived links, and shared membership
              stay separate families and are never summed into one weight.
            </p>
            {visibleConnections.length === 0 ? (
              <p className="pga-empty">
                No {lens === 'all' ? 'connections' : CONNECTION_FAMILY_LABEL[lens].toLowerCase()} between this area
                and any other area in the loaded snapshot.
              </p>
            ) : (
              <>
                <p className="pga-count-line">
                  {shownCount(connectionRows, visibleConnections.length, 'connections')}
                  {internalEdges.total > 0 ? ` · ${describeInternalEdges(internalEdges)}` : ''}
                </p>
                <ul className="pga-list">
                  {visibleConnections.slice(0, connectionRows).map((connection) => {
                    const isOpen = connection.id === openConnectionId;
                    return (
                      <li key={connection.id} className={isOpen ? 'pga-conn is-open' : 'pga-conn'}>
                        <button
                          type="button"
                          className="pga-conn-head"
                          aria-expanded={isOpen}
                          onClick={() => { onOpenConnection(isOpen ? null : connection.id); setEvidenceRows(PAGE); }}
                        >
                          <span className="pga-conn-title">
                            {area.label} ↔ {connection.otherAreaLabel}
                          </span>
                          <span className={`pga-family pga-family-${connection.family}`}>
                            {CONNECTION_FAMILY_LABEL[connection.family]}
                          </span>
                          <span className="pga-conn-count">{connection.count.toLocaleString()}</span>
                        </button>
                        <p className="pga-conn-why">{connection.explanation}</p>
                        {connection.relationCounts.length > 0 && (
                          <p className="pga-conn-relations">{formatRelationSummary(connection.relationCounts)}</p>
                        )}
                        {/* A family header can never stand in for per-relation
                            provenance: `part_of` and `fixes` are derived even
                            though both arrive as ordinary snapshot edges. */}
                        {connection.relationCounts.some((r) => r.note) && (
                          <ul className="pga-relation-notes">
                            {connection.relationCounts
                              .filter((r) => r.note)
                              .map((r) => (
                                <li key={r.relation}>
                                  <b>{r.relation}</b>
                                  <span>{r.note}</span>
                                </li>
                              ))}
                          </ul>
                        )}
                        {isOpen && (
                          <>
                            <p className="pga-count-line">
                              {shownCount(evidenceRows, connection.evidence.length, 'evidence rows')}
                              {connection.evidence.length < connection.count
                                ? ` · evidence capped at ${connection.evidence.length.toLocaleString()} of ${connection.count.toLocaleString()}`
                                : ''}
                            </p>
                            <ul className="pga-evidence-list">
                              {connection.evidence.slice(0, evidenceRows).map((row) => {
                                const node = model.nodeById.get(row.nodeId);
                                return (
                                  <li
                                    key={row.id}
                                    className={selectedNodeId === row.nodeId ? 'pga-evidence is-selected' : 'pga-evidence'}
                                  >
                                    <button
                                      type="button"
                                      className="pga-evidence-btn"
                                      onClick={() => selectEvidenceNode(row.nodeId)}
                                      onDoubleClick={() => node && onOpenNode(node)}
                                    >
                                      <span className="pga-evidence-label">{row.label}</span>
                                      <small>{row.detail}</small>
                                    </button>
                                    {node && renderRowActions(node)}
                                  </li>
                                );
                              })}
                            </ul>
                            {evidenceRows < Math.min(connection.evidence.length, MAX_ROWS) && (
                              <button
                                type="button"
                                className="pga-more"
                                onClick={() => setEvidenceRows((n) => Math.min(n + PAGE, MAX_ROWS))}
                              >
                                Show {PAGE} more
                              </button>
                            )}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {connectionRows < visibleConnections.length && (
                  <button type="button" className="pga-more" onClick={() => setConnectionRows((n) => n + PAGE)}>
                    Show {PAGE} more connections
                  </button>
                )}
              </>
            )}
          </>
        )}

        {tab === 'activity' && (
          areaEvents.length === 0 ? (
            <p className="pga-empty">No events recorded for this area in the selected range.</p>
          ) : (
            <>
              <p className="pga-count-line">{shownCount(activityRows, areaEvents.length, 'events')}</p>
              <ul className="pga-list">
                {areaEvents.slice(0, activityRows).map((event) => {
                  const node = model.nodeById.get(event.nodeId);
                  return (
                    <li
                      key={event.id}
                      className={selectedNodeId === event.nodeId ? 'pga-evidence is-selected' : 'pga-evidence'}
                    >
                      <button
                        type="button"
                        className="pga-evidence-btn"
                        onClick={() => selectEvidenceNode(event.nodeId)}
                        onDoubleClick={() => node && onOpenNode(node)}
                      >
                        <span className="pga-evidence-label">{event.label}</span>
                        <small>
                          {formatDay(event.at)} · {event.kind} ·{' '}
                          {event.provenance === 'last-observed'
                            ? 'last-observed marker (one observation, not an interval)'
                            : 'recorded event'}
                        </small>
                      </button>
                      {node && renderRowActions(node)}
                    </li>
                  );
                })}
              </ul>
              {activityRows < Math.min(areaEvents.length, MAX_ROWS) && (
                <button
                  type="button"
                  className="pga-more"
                  onClick={() => setActivityRows((n) => Math.min(n + PAGE, MAX_ROWS))}
                >
                  Show {PAGE} more
                </button>
              )}
            </>
          )
        )}

        {tab === 'records' && (
          areaRecords.length === 0 ? (
            <p className="pga-empty">No loaded records resolve for this area.</p>
          ) : (
            <>
              <p className="pga-count-line">{shownCount(recordRows, areaRecords.length, 'records')}</p>
              <ul className="pga-list">
                {areaRecords.slice(0, recordRows).map((node) => (
                  <li
                    key={node.id}
                    className={selectedNodeId === node.id ? 'pga-evidence is-selected' : 'pga-evidence'}
                  >
                    <button
                      type="button"
                      className="pga-evidence-btn"
                      onClick={() => selectEvidenceNode(node.id)}
                      onDoubleClick={() => onOpenNode(node)}
                    >
                      <span className="pga-evidence-label">{node.label}</span>
                      <small>
                        {describeNode(node)} ·{' '}
                        {model.memberships.get(node.id)?.find((m) => m.areaId === area.id)?.basis ??
                          'membership basis not recorded'}
                      </small>
                    </button>
                    {renderRowActions(node)}
                  </li>
                ))}
              </ul>
              {recordRows < Math.min(areaRecords.length, MAX_ROWS) && (
                <button
                  type="button"
                  className="pga-more"
                  onClick={() => setRecordRows((n) => Math.min(n + PAGE, MAX_ROWS))}
                >
                  Show {PAGE} more
                </button>
              )}
            </>
          )
        )}

        {openConnection && tab === 'connections' && (
          <p className="pga-callout">
            {openConnection.family === 'recorded-link'
              ? 'A recorded link evidences a relation a source record carries. It is not proof of a verified outcome.'
              : openConnection.family === 'derived-link'
                ? 'A derived link was produced by a loader rule, not asserted by any record. Treat it as a reason to look, not as a dependency.'
                : openConnection.family === 'unclassified-link'
                  ? 'This prototype cannot say how these links were produced. Check the source record before relying on them.'
                  : 'Shared membership is derived by a tag or path rule. It is a reason to look, not a dependency.'}
          </p>
        )}
      </div>
    </aside>
  );
}
