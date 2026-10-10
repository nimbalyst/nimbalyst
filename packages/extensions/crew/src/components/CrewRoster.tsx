/** The left rail: the crew feed entry, one row per member, Hire, and pause-the-crew. */
import { MaterialSymbol } from '@nimbalyst/extension-sdk';
import type { CrewMemberSnapshot } from '../shared/types';
import { CrewAlphaBadge, CrewAvatar, CrewError } from './CrewBits';
import { useCrew, useCrewAction } from './CrewContext';
import { formatTokens } from './crewFormat';

function formatCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export function CrewRoster() {
  const { rosterState, roster, selectedSlug, select, setHireOpen, client, refresh } = useCrew();
  const { busy, error, run } = useCrewAction();
  const members = roster?.members ?? [];
  // A persisted selection for a member who has since left falls back to the feed.
  const selectedIsMember = selectedSlug !== null && members.some((m) => m.definition.slug === selectedSlug);
  const onShift = members.filter((m) => m.runtime.onShift).length;
  const unreadTotal = members.reduce((sum, m) => sum + m.runtime.unreadCount, 0);
  const usage = roster?.crewUsage;

  return (
    <aside className="crew-roster" aria-label="Crew roster" data-testid="crew-roster">
      <header className="crew-roster-header">
        <div className="crew-roster-title">Crew <CrewAlphaBadge /></div>
        {members.length > 0 && (
          <div className="crew-roster-subtitle">
            {members.length === 1 ? '1 member' : `${members.length} members`}
            {onShift > 0 ? `, ${onShift} on shift` : ''}
          </div>
        )}
      </header>

      <button
        type="button"
        className="crew-roster-feed-link"
        data-selected={!selectedIsMember}
        aria-current={selectedIsMember ? undefined : 'page'}
        onClick={() => select(null)}
      >
        <MaterialSymbol icon="view_agenda" size={16} />
        <span className="crew-grow">Crew feed</span>
        {unreadTotal > 0 && <span className="crew-roster-feed-count">{formatCount(unreadTotal)} waiting</span>}
      </button>

      <div className="crew-roster-body">
        {members.length > 0 && (
          <>
            <div className="crew-section-label">Members</div>
            <ul className="crew-roster-list" role="list">
              {members.map((member) => (
                <li key={member.definition.slug}>
                  <CrewRosterRow
                    member={member}
                    selected={member.definition.slug === selectedSlug}
                    onSelect={() => select(member.definition.slug)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        {rosterState.status === 'loading' && <div className="crew-muted-note" role="status">Loading crew...</div>}
        {rosterState.status === 'error' && (
          <div className="crew-roster-error" role="alert">
            <span>The crew could not be loaded.</span>
            <span className="crew-selectable crew-faint">{rosterState.error}</span>
            <button type="button" className="crew-btn crew-btn-secondary crew-btn-small" onClick={() => void refresh()}>Retry</button>
          </div>
        )}
      </div>

      <footer className="crew-roster-footer">
        {usage && usage.tokensPerWeekLimit > 0 && (
          <div className="crew-roster-usage" data-over={usage.overBudget}>
            Crew: {formatTokens(usage.tokensThisWeek)} / {formatTokens(usage.tokensPerWeekLimit)} tokens this week
          </div>
        )}
        {members.length > 0 && roster && (
          <button
            type="button"
            className="crew-btn crew-btn-secondary crew-btn-block"
            disabled={busy !== null}
            onClick={() => void run('pause', () => client.call('setCrewPaused', { paused: !roster.allPaused }))}
          >
            <MaterialSymbol icon={roster.allPaused ? 'play_arrow' : 'pause'} size={15} />
            {roster.allPaused ? 'Resume the crew' : 'Pause the crew'}
          </button>
        )}
        <button type="button" className="crew-btn crew-btn-secondary crew-btn-block" onClick={() => setHireOpen(true)} data-testid="crew-roster-hire">
          <MaterialSymbol icon="person_add" size={15} />
          Hire
        </button>
        <CrewError message={error} />
      </footer>
    </aside>
  );
}

function CrewRosterRow({ member, selected, onSelect }: { member: CrewMemberSnapshot; selected: boolean; onSelect: () => void }) {
  const { definition, runtime } = member;
  const unread = runtime.unreadCount;
  return (
    <button
      type="button"
      className="crew-roster-row"
      data-selected={selected}
      aria-current={selected ? 'page' : undefined}
      aria-label={`${definition.name}, ${definition.role}, ${runtime.statusDetail}${unread > 0 ? `, ${unread} waiting` : ''}`}
      onClick={onSelect}
      data-member-slug={definition.slug}
      data-status={runtime.status}
    >
      <CrewAvatar definition={definition} status={runtime.status} />
      <span className="crew-roster-row-text">
        <span className="crew-roster-row-name">
          <span className="crew-truncate">{definition.name}</span>
          <span className="crew-roster-row-role crew-truncate">{definition.role}</span>
        </span>
        <span className="crew-roster-row-status crew-truncate" data-status={runtime.status}>{runtime.statusDetail}</span>
      </span>
      {unread > 0 && <span className="crew-count-badge">{formatCount(unread)}</span>}
    </button>
  );
}
