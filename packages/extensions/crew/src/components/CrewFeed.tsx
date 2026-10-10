/**
 * The crew feed: flags, standups, shift summaries and journal activity from
 * every member, read like a morning paper. Members waiting on an answer are
 * pinned above everything else.
 */
import { useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/extension-sdk';
import type { CrewFeedEntry, CrewMemberDefinition, CrewMemberSnapshot } from '../shared/types';
import { CrewAvatar, CrewEvidenceChips, CrewLevelChip } from './CrewBits';
import { useCrew } from './CrewContext';
import { describeTrigger } from './crewDeskModel';
import {
  buildCrewFeed,
  CREW_FEED_FILTERS,
  mergeFeedEntries,
  oldestFeedTimestamp,
  type CrewFeedFilter,
} from './crewFeedModel';
import { errorMessage, formatWhen } from './crewFormat';

const FEED_PAGE_SIZE = 100;

export function CrewFeed() {
  const { client, roster, revision } = useCrew();
  const [entries, setEntries] = useState<CrewFeedEntry[]>([]);
  const [load, setLoad] = useState<{ status: 'loading' | 'ready' } | { status: 'error'; error: string }>({ status: 'loading' });
  const [filter, setFilter] = useState<CrewFeedFilter>('all');
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'exhausted'>('idle');

  // The newest page, again on every backend revision.
  useEffect(() => {
    let cancelled = false;
    client.call('feed', { limit: FEED_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setEntries((current) => mergeFeedEntries(current, page));
        setLoad({ status: 'ready' });
      })
      .catch((err) => {
        if (cancelled) return;
        // Keep showing what loaded before; only an empty feed shows the error.
        setLoad((current) => (current.status === 'ready' ? current : { status: 'error', error: errorMessage(err) }));
      });
    return () => { cancelled = true; };
  }, [client, revision]);

  const loadOlder = async () => {
    setOlderState('loading');
    try {
      const page = await client.call('feed', { limit: FEED_PAGE_SIZE, before: oldestFeedTimestamp(entries) });
      setEntries((current) => mergeFeedEntries(current, page));
      setOlderState(page.length < FEED_PAGE_SIZE ? 'exhausted' : 'idle');
    } catch {
      setOlderState('idle');
    }
  };

  const members = roster?.members ?? [];
  const feed = useMemo(() => buildCrewFeed(entries, members, filter), [entries, members, filter]);
  const isEmpty = feed.waiting.length === 0 && feed.stream.length === 0;
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <section className="crew-feed" data-testid="crew-feed">
      <header className="crew-feed-header">
        <h2 className="crew-feed-title">Crew feed</h2>
        <span className="crew-faint">{today}</span>
        <div className="crew-segmented crew-push-right" role="tablist" aria-label="Filter the feed">
          {CREW_FEED_FILTERS.map(({ id, label }) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} data-selected={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="crew-feed-scroll">
        <div className="crew-feed-column">
          {load.status === 'loading' && <div className="crew-empty-note" role="status">Loading the feed...</div>}
          {load.status === 'error' && (
            <div className="crew-empty-note" role="alert">
              The feed could not be loaded.
              <span className="crew-selectable crew-faint">{load.error}</span>
            </div>
          )}
          {load.status === 'ready' && isEmpty && (
            <div className="crew-empty-note">
              {filter === 'all'
                ? 'Nothing from the crew yet. Flags, standups and shift summaries collect here.'
                : 'Nothing here under this filter.'}
            </div>
          )}

          {feed.waiting.length > 0 && (
            <>
              <div className="crew-section-label"><MaterialSymbol icon="push_pin" size={13} /> Waiting on you</div>
              {feed.waiting.map((member) => <CrewWaitingCard key={member.definition.slug} member={member} />)}
            </>
          )}
          {feed.stream.length > 0 && (
            <>
              {feed.waiting.length > 0 && <div className="crew-section-label">Latest</div>}
              {feed.stream.map((entry) => <CrewFeedCard key={entry.id} entry={entry} />)}
              {olderState !== 'exhausted' && entries.length >= FEED_PAGE_SIZE && (
                <button type="button" className="crew-link-button crew-feed-older" disabled={olderState === 'loading'} onClick={() => void loadOlder()}>
                  {olderState === 'loading' ? 'Loading...' : 'Show older'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Who a card is from. A member removed since keeps their slug on old cards. */
function useMemberIdentity(slug: string): Pick<CrewMemberDefinition, 'name' | 'role' | 'color'> {
  const { roster } = useCrew();
  const member = roster?.members.find((m) => m.definition.slug === slug);
  return member?.definition ?? { name: slug, role: '', color: 'var(--nim-text-faint)' };
}

/**
 * A member with a question open. The question itself is an interactive prompt
 * in one of their sessions; answering happens there, on the desk.
 */
function CrewWaitingCard({ member }: { member: CrewMemberSnapshot }) {
  const { viewSession } = useCrew();
  const { definition, runtime } = member;
  return (
    <article className="crew-card" data-tone="ask">
      <div className="crew-card-top">
        <CrewAvatar definition={definition} />
        <span className="crew-card-who">
          {definition.name}
          {definition.role && <span className="crew-faint"> {definition.role}</span>}
        </span>
        <CrewLevelChip level="ask" label="Waiting on you" />
      </div>
      <p className="crew-card-body crew-selectable">{runtime.statusDetail}</p>
      <div className="crew-card-actions">
        <button
          type="button"
          className="crew-btn crew-btn-primary crew-btn-small"
          onClick={() => viewSession(definition.slug, null)}
        >
          Answer on {definition.name}'s desk
        </button>
      </div>
    </article>
  );
}

function CrewFeedCard({ entry }: { entry: CrewFeedEntry }) {
  const { host, select, viewSession } = useCrew();
  const who = useMemberIdentity(entry.memberSlug);
  const tone = entry.kind === 'flag' && entry.level === 'page' ? 'page' : entry.kind === 'flag' && entry.level === 'flag' ? 'flag' : 'plain';
  const chip = entry.kind === 'flag'
    ? <CrewLevelChip level={entry.level ?? 'flag'} label={entry.level === 'note' ? 'Standup' : undefined} />
    : <CrewLevelChip level="note" label={KIND_LABEL[entry.kind]} />;

  return (
    <article className="crew-card" data-tone={tone} data-kind={entry.kind}>
      <div className="crew-card-top">
        <CrewAvatar definition={who} />
        <button type="button" className="crew-card-who crew-link-plain" onClick={() => select(entry.memberSlug)}>
          {who.name}
          {who.role && <span className="crew-faint"> {who.role}</span>}
        </button>
        {chip}
        <span className="crew-faint crew-push-right">{formatWhen(entry.at)}</span>
      </div>
      {entry.title && <h3 className="crew-card-title crew-selectable">{entry.title}</h3>}
      {entry.body && <p className="crew-card-body crew-selectable">{entry.body}</p>}
      {entry.trigger && entry.kind === 'shift' && <p className="crew-card-meta">{describeTrigger(entry.trigger)}</p>}
      <CrewEvidenceChips
        evidence={entry.evidence}
        onOpenSession={(sessionId) => viewSession(entry.memberSlug, sessionId)}
        onOpenFile={(path) => host.openFile(path)}
      />
      {entry.sessionId && (
        <div className="crew-card-actions">
          <button type="button" className="crew-btn crew-btn-ghost crew-btn-small" onClick={() => viewSession(entry.memberSlug, entry.sessionId ?? null)}>
            {entry.chapterIndex !== undefined ? `Read chapter ${entry.chapterIndex}` : 'Read the session'}
          </button>
        </div>
      )}
    </article>
  );
}

const KIND_LABEL: Record<CrewFeedEntry['kind'], string> = {
  shift: 'Shift',
  flag: 'Flag',
  journal: 'Journal',
  handoff: 'Handoff',
  'schedule-change': 'Schedule',
  budget: 'Budget',
  system: 'System',
};
