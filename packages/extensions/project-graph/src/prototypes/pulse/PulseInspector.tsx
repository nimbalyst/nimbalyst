import React from 'react';
import type { PrototypeEvent, PrototypeModel, PrototypeViewProps } from '../contracts';
import type { PulseBucket } from './pulseBuckets';
import { bucketRangeLabel } from './pulseBuckets';
import type { PulseMatrix, PulseSelectionSummary, PulseStateItem } from './pulseModel';
import { openStateItems } from './pulseModel';
import { formatRelative, formatStamp } from './pulseFormat';

const MAX_EPISODES = 10;
const MAX_EVENTS_PER_EPISODE = 6;
const MAX_OPEN_ITEMS = 10;

const KIND_LABEL: Record<PrototypeEvent['kind'], string> = {
  created: 'Created',
  commit: 'Commit',
  status: 'Status',
  'last-activity': 'Last observed',
};

export { formatRelative, formatStamp } from './pulseFormat';

function StateList({
  items,
  nowMs,
  onSelectNode,
  onOpenNode,
}: {
  items: PulseStateItem[];
  nowMs: number;
  onSelectNode: PrototypeViewProps['onSelectNode'];
  onOpenNode: PrototypeViewProps['onOpenNode'];
}) {
  return (
    <ul className="pgp-open-list">
      {items.map((item) => (
        <li key={item.node.id}>
          <button
            type="button"
            className="pgp-link-btn"
            onClick={() => onSelectNode(item.node.id)}
            onDoubleClick={() => onOpenNode(item.node)}
          >
            <span className="pgp-open-status">{item.node.status}</span>
            <span className="pgp-open-label">{item.node.label}</span>
          </button>
          <span className="pgp-open-when">
            {item.lastEventAt === null
              ? 'no dated event'
              : formatRelative(item.lastEventAt, nowMs)}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  model: PrototypeModel;
  matrix: PulseMatrix;
  summary: PulseSelectionSummary | null;
  buckets: PulseBucket[];
  nowMs: number;
  onSelectNode: PrototypeViewProps['onSelectNode'];
  onOpenNode: PrototypeViewProps['onOpenNode'];
  onNavigate: PrototypeViewProps['onNavigate'];
  selectedNodeId: string | null;
}

export function PulseInspector({
  model,
  matrix,
  summary,
  buckets,
  nowMs,
  onSelectNode,
  onOpenNode,
  onNavigate,
  selectedNodeId,
}: Props) {
  const census = React.useMemo(
    () => openStateItems(model, matrix, MAX_OPEN_ITEMS),
    [model, matrix],
  );

  return (
    <aside className="pgp-inspector" aria-label="Pulse selection detail">
      {summary === null ? (
        <div className="pgp-inspector-empty">
          <h3>Nothing selected</h3>
          <p>
            Pick a cell to read the events behind it. Drag, or hold Shift with the arrow keys, to
            explain a wider period. An empty cell means no events were loaded for it, which is not
            evidence that nothing happened.
          </p>
        </div>
      ) : (
        <SelectionDetail
          summary={summary}
          buckets={buckets}
          model={model}
          nowMs={nowMs}
          onSelectNode={onSelectNode}
          onOpenNode={onOpenNode}
          onNavigate={onNavigate}
          selectedNodeId={selectedNodeId}
        />
      )}

      <section className="pgp-open-state" aria-label="Current state census">
        <div className="pgp-eyebrow">Open now · current state</div>
        <p className="pgp-note">
          A state census of the {census.scopeSize.toLocaleString()} records in scope, not activity.
          Nothing here is counted in any bucket above, and it says nothing about the selected window.
        </p>
        {census.openTotal === 0 ? (
          <p className="pgp-empty-line">
            No record in scope carries a status this view recognizes as non-terminal.
          </p>
        ) : (
          <>
            <StateList
              items={census.open}
              nowMs={nowMs}
              onSelectNode={onSelectNode}
              onOpenNode={onOpenNode}
            />
            <div className="pgp-count-line">
              Showing {census.open.length} of {census.openTotal} records in a recognized open state
            </div>
          </>
        )}

        {census.unrecognizedTotal > 0 && (
          <div className="pgp-unrecognized">
            <p className="pgp-note">
              {census.unrecognizedTotal} record{census.unrecognizedTotal === 1 ? '' : 's'} carry a
              status this prototype does not recognize
              {/* Examples, already clipped and bounded by the model: status is
                  free text and live data puts whole notes in the field. */}
              {census.unrecognizedStatuses.length > 0
                ? ` (${census.unrecognizedStatuses.join(', ')}${
                    census.unrecognizedStatusTotal > census.unrecognizedStatuses.length
                      ? ` and ${census.unrecognizedStatusTotal - census.unrecognizedStatuses.length} other value${
                          census.unrecognizedStatusTotal - census.unrecognizedStatuses.length === 1
                            ? ''
                            : 's'
                        }`
                      : ''
                  })`
                : ''}
              . They are listed separately because it cannot be shown whether they are unresolved.
            </p>
            <StateList
              items={census.unrecognized}
              nowMs={nowMs}
              onSelectNode={onSelectNode}
              onOpenNode={onOpenNode}
            />
            <div className="pgp-count-line">
              Showing {census.unrecognized.length} of {census.unrecognizedTotal} unrecognized-status
              records
            </div>
          </div>
        )}

        {census.archivedTotal > 0 && (
          <div className="pgp-archived">
            <p className="pgp-note">
              {census.archivedTotal} record{census.archivedTotal === 1 ? ' is' : 's are'} archived.
              Archiving is where a record is filed, not whether its work finished, so
              {census.archivedTotal === 1 ? ' it is' : ' they are'} listed here and counted in
              neither the open list nor the terminal count.
            </p>
            <StateList
              items={census.archived}
              nowMs={nowMs}
              onSelectNode={onSelectNode}
              onOpenNode={onOpenNode}
            />
            <div className="pgp-count-line">
              Showing {census.archived.length} of {census.archivedTotal} archived records
            </div>
          </div>
        )}

        <div className="pgp-count-line">
          {census.closedTotal} in a terminal state · {census.statuslessTotal} with no status
        </div>
        {census.closureConflicts > 0 && (
          <p className="pgp-note">
            {census.closureConflicts} record{census.closureConflicts === 1 ? '' : 's'} carry a close
            timestamp alongside a status this view reads as non-terminal. The status is taken as the
            stronger signal, so {census.closureConflicts === 1 ? 'it is' : 'they are'} counted as
            open.
          </p>
        )}
      </section>
    </aside>
  );
}

function SelectionDetail({
  summary,
  buckets,
  model,
  nowMs,
  onSelectNode,
  onOpenNode,
  onNavigate,
  selectedNodeId,
}: {
  summary: PulseSelectionSummary;
  buckets: PulseBucket[];
  model: PrototypeModel;
  nowMs: number;
  onSelectNode: PrototypeViewProps['onSelectNode'];
  onOpenNode: PrototypeViewProps['onOpenNode'];
  onNavigate: PrototypeViewProps['onNavigate'];
  selectedNodeId: string | null;
}) {
  const period = bucketRangeLabel(buckets, summary.colStart, summary.colEnd);
  const rowScope =
    summary.rowLabels.length === 1
      ? summary.rowLabels[0]
      : `${summary.rowLabels.length} rows`;
  const shownEpisodes = summary.episodes.slice(0, MAX_EPISODES);

  return (
    <section className="pgp-selection" aria-label="Selected period">
      <div className="pgp-eyebrow">
        {period} · {rowScope}
      </div>
      <h3 className="pgp-selection-heading">{summary.heading}</h3>
      <p className="pgp-note">
        Counted from source records. No summary is generated and no outcome is inferred.
      </p>

      {summary.rowsOutOfView > 0 && (
        <p className="pgp-warn-line">
          {summary.rowsOutOfView} of the {summary.rowsSelected} selected row
          {summary.rowsSelected === 1 ? '' : 's'} fell below the display cap after the rows were
          reordered, so their events are not counted here.
        </p>
      )}
      {summary.includesPartialBucket && (
        <p className="pgp-warn-line">
          The selection includes a bucket clipped by the toolbar range. Its totals cover only the
          part inside the range, so that column is not comparable with the full buckets beside it.
        </p>
      )}
      {summary.includesOutsideLoaded && (
        <p className="pgp-warn-line">
          Part of this selection predates the earliest event in the whole loaded model. That is one
          global bound, not per-source coverage: each adapter has its own caps and horizons, so
          other buckets may be just as unloaded without being marked.
        </p>
      )}
      {summary.lastObservedCount > 0 && (
        <p className="pgp-note">
          {summary.recordedCount} recorded event{summary.recordedCount === 1 ? '' : 's'} and{' '}
          {summary.lastObservedCount} last-observed timestamp
          {summary.lastObservedCount === 1 ? '' : 's'}. A last-observed timestamp is one
          observation, not a stretch of work.
        </p>
      )}

      {summary.episodes.length === 0 ? (
        <p className="pgp-empty-line">
          No events were loaded for this period. Nothing was filtered out here, and nothing here
          shows whether work occurred.
        </p>
      ) : (
        <>
          <div className="pgp-eyebrow pgp-eyebrow-sub">
            Grouped by artifact · not a causal story
          </div>
          <ul className="pgp-episodes">
            {shownEpisodes.map((episode) => {
              const node = model.nodeById.get(episode.nodeId);
              const isSelected = selectedNodeId === episode.nodeId;
              return (
                <li
                  key={episode.nodeId}
                  className={isSelected ? 'pgp-episode pgp-episode-selected' : 'pgp-episode'}
                >
                  <button
                    type="button"
                    className="pgp-episode-head"
                    onClick={() => onSelectNode(episode.nodeId)}
                  >
                    <span className="pgp-episode-title">{episode.label}</span>
                    <span className="pgp-episode-meta">
                      {episode.type} · {episode.events.length} event
                      {episode.events.length === 1 ? '' : 's'} ·{' '}
                      {formatRelative(episode.lastAt, nowMs)}
                    </span>
                  </button>
                  <ul className="pgp-episode-events">
                    {episode.events.slice(0, MAX_EVENTS_PER_EPISODE).map((event) => (
                      <li key={event.id}>
                        <span
                          className={
                            event.provenance === 'last-observed'
                              ? 'pgp-kind pgp-kind-observed'
                              : 'pgp-kind'
                          }
                        >
                          {KIND_LABEL[event.kind]}
                        </span>
                        <span className="pgp-event-label">{event.label}</span>
                        <span className="pgp-event-when">{formatStamp(event.at)}</span>
                      </li>
                    ))}
                  </ul>
                  {episode.events.length > MAX_EVENTS_PER_EPISODE && (
                    <div className="pgp-count-line">
                      Showing {MAX_EVENTS_PER_EPISODE} of {episode.events.length} events
                    </div>
                  )}
                  <div className="pgp-episode-actions">
                    {node && (
                      <button type="button" className="pgp-btn" onClick={() => onOpenNode(node)}>
                        Open source
                      </button>
                    )}
                    <button
                      type="button"
                      className="pgp-btn"
                      onClick={() => onNavigate('trails', episode.nodeId)}
                    >
                      Evidence trail
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="pgp-count-line">
            Showing {shownEpisodes.length} of {summary.episodes.length} artifacts ·{' '}
            {summary.eventCount} event{summary.eventCount === 1 ? '' : 's'} in selection
          </div>
        </>
      )}
    </section>
  );
}
