/** The desk's right panel: Inbox, Schedule, Delegated, Notes. */
import { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/extension-sdk';
import type { CrewDelegatedSession, CrewMemberDetail, CrewMemberSnapshot } from '../shared/types';
import { CrewError, CrewEvidenceChips, CrewLevelChip } from './CrewBits';
import { useCrew, useCrewQuery } from './CrewContext';
import { countLiveDelegated } from './crewDeskModel';
import { errorMessage, formatWhen } from './crewFormat';
import { CrewScheduleTab } from './CrewScheduleTab';

type PanelTab = 'inbox' | 'schedule' | 'delegated' | 'notes';

const TABS: ReadonlyArray<{ id: PanelTab; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'delegated', label: 'Delegated' },
  { id: 'notes', label: 'Notes' },
];

export function CrewDeskPanel({ member, detail }: { member: CrewMemberSnapshot; detail: CrewMemberDetail | null }) {
  const [tab, setTab] = useState<PanelTab>('inbox');
  const delegated = detail?.delegated ?? null;
  const counts: Partial<Record<PanelTab, number>> = {
    inbox: member.runtime.unreadCount,
    delegated: delegated ? countLiveDelegated(delegated) : 0,
  };

  return (
    <aside className="crew-desk-panel" aria-label={`${member.definition.name}'s desk`}>
      <div className="crew-tabs" role="tablist">
        {TABS.map(({ id, label }) => {
          const count = counts[id] ?? 0;
          return (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-selected={tab === id} onClick={() => setTab(id)}>
              {label}
              {count > 0 && <span className="crew-tab-count">{count}</span>}
            </button>
          );
        })}
      </div>
      <div className="crew-desk-panel-body">
        {tab === 'inbox' && <CrewInboxTab member={member} delegated={delegated} />}
        {tab === 'schedule' && <CrewScheduleTab member={member} />}
        {tab === 'delegated' && <CrewDelegatedTab member={member} sessions={delegated} />}
        {tab === 'notes' && <CrewNotesTab member={member} />}
      </div>
    </aside>
  );
}

/**
 * What is waiting: questions open in the member's sessions (answered in the
 * transcript), wakes held for the next shift, and the member's recent flags.
 */
function CrewInboxTab({ member, delegated }: { member: CrewMemberSnapshot; delegated: CrewDelegatedSession[] | null }) {
  const { client, host, viewSession } = useCrew();
  const { definition, runtime } = member;
  const slug = definition.slug;
  const flags = useCrewQuery(() => client.call('feed', { slug, kinds: ['flag'], limit: 20 }), [slug]);
  const pendingSessions = (delegated ?? []).filter((s) => s.hasPendingPrompt);
  const waitingInChapter = runtime.status === 'waiting-on-user';

  return (
    <div className="crew-stack">
      {waitingInChapter && (
        <div className="crew-inbox-row" data-tone="ask">
          <MaterialSymbol icon="help" size={15} />
          <span className="crew-grow">{definition.name} asked you something in the current chapter. Answer it in the transcript.</span>
        </div>
      )}
      {pendingSessions.map((session) => (
        <button key={session.sessionId} type="button" className="crew-inbox-row crew-inbox-row-button" data-tone="ask" onClick={() => viewSession(slug, session.sessionId)}>
          <MaterialSymbol icon="help" size={15} />
          <span className="crew-grow">"{session.name}" is waiting on you</span>
        </button>
      ))}
      {runtime.pendingInboxCount > 0 && (
        <div className="crew-inbox-row">
          <MaterialSymbol icon="inbox" size={15} />
          <span className="crew-grow">
            {runtime.pendingInboxCount === 1 ? '1 wake is' : `${runtime.pendingInboxCount} wakes are`} held for the next shift.
          </span>
        </div>
      )}

      <div className="crew-section-label">Recent flags</div>
      {flags.data === null ? (
        flags.error ? <CrewError message={flags.error} /> : <p className="crew-faint" role="status">Loading...</p>
      ) : flags.data.length === 0 ? (
        <p className="crew-faint">No flags yet. Anything {definition.name} flags shows here and in the crew feed.</p>
      ) : (
        flags.data.map((entry) => (
          <div key={entry.id} className="crew-inbox-flag">
            <div className="crew-row">
              <CrewLevelChip level={entry.level ?? 'flag'} label={entry.level === 'note' ? 'Standup' : undefined} />
              <span className="crew-grow crew-truncate crew-strong">{entry.title}</span>
              <span className="crew-faint">{formatWhen(entry.at)}</span>
            </div>
            {entry.body && <p className="crew-inbox-flag-body crew-selectable">{entry.body}</p>}
            <CrewEvidenceChips
              evidence={entry.evidence}
              onOpenSession={(sessionId) => viewSession(slug, sessionId)}
              onOpenFile={(path) => host.openFile(path)}
            />
          </div>
        ))
      )}
    </div>
  );
}

function CrewDelegatedTab({ member, sessions }: { member: CrewMemberSnapshot; sessions: CrewDelegatedSession[] | null }) {
  const { viewSession } = useCrew();
  if (sessions === null) return <p className="crew-faint" role="status">Loading...</p>;
  if (sessions.length === 0) {
    return <p className="crew-faint">{member.definition.name} has not started any sessions.</p>;
  }
  return (
    <ul className="crew-stack" role="list">
      {sessions.map((session) => (
        <li key={session.sessionId}>
          <button
            type="button"
            className="crew-delegated-row"
            onClick={() => viewSession(member.definition.slug, session.sessionId)}
            data-session-id={session.sessionId}
          >
            <span className="crew-truncate crew-strong">{session.name || 'Untitled session'}</span>
            <span className="crew-row crew-small">
              <span className="crew-session-status" data-status={session.hasPendingPrompt ? 'waiting' : session.status}>
                {session.hasPendingPrompt ? 'waiting on you' : session.status.replace(/_/g, ' ')}
              </span>
              {session.createdAt && <span className="crew-faint crew-push-right">{formatWhen(session.createdAt)}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Notes are the member's long-term memory and yours to correct; the journal
 * is its own append-only log and is read-only here.
 */
function CrewNotesTab({ member }: { member: CrewMemberSnapshot }) {
  const { client, revision } = useCrew();
  const slug = member.definition.slug;
  const [view, setView] = useState<'notes' | 'journal'>('notes');
  // `base` is the text the draft started from, which the save sends as
  // `expected`. `saved` follows the file, so a member update while you edit
  // surfaces as a refused save rather than a silent overwrite.
  const [notes, setNotes] = useState<{ saved: string | null; base: string | null; draft: string }>({ saved: null, base: null, draft: '' });
  const [journal, setJournal] = useState<string | null>(null);
  const [status, setStatus] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  const { saved, base, draft } = notes;
  const dirty = base !== null && draft !== base;

  useEffect(() => {
    let cancelled = false;
    client.call('readMemory', { slug })
      .then((memory) => {
        if (cancelled) return;
        // Never clobber an edit in progress when the member updates its notes.
        setNotes((current) => (current.base === null || current.draft === current.base
          ? { saved: memory.notes, base: memory.notes, draft: memory.notes }
          : { ...current, saved: memory.notes }));
        setJournal(memory.journal);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus((current) => ({ ...current, error: errorMessage(err) }));
      });
    return () => { cancelled = true; };
  }, [client, slug, revision]);

  const save = async () => {
    setStatus({ saving: true, error: null });
    try {
      await client.call('writeNotes', { slug, content: draft, expected: base ?? '' });
      setNotes({ saved: draft, base: draft, draft });
      setStatus({ saving: false, error: null });
    } catch (err) {
      setStatus({ saving: false, error: errorMessage(err) });
    }
  };

  return (
    <div className="crew-notes-tab">
      <div className="crew-segmented crew-segmented-small" role="tablist">
        {(['notes', 'journal'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} data-selected={view === id} onClick={() => setView(id)}>
            {id === 'notes' ? 'Notes' : 'Journal'}
          </button>
        ))}
      </div>
      {view === 'notes' ? (
        <>
          <p className="crew-faint crew-small">
            {member.definition.name} reads these at the start of every chapter. Edit them to correct what it has learned.
          </p>
          <textarea
            className="crew-input crew-notes-editor"
            value={draft}
            onChange={(e) => setNotes((current) => ({ ...current, draft: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 's' && (e.metaKey || e.ctrlKey) && dirty) {
                e.preventDefault();
                void save();
              }
            }}
            disabled={saved === null}
            placeholder={saved === null ? 'Loading...' : 'No notes yet.'}
            aria-label="Notes"
          />
          {saved !== null && base !== null && saved !== base && (
            <p className="crew-faint crew-small">{member.definition.name} changed these notes while you were editing. Saving will be refused; revert to see the new version.</p>
          )}
          <div className="crew-row">
            <span className="crew-grow"><CrewError message={status.error} /></span>
            <button
              type="button"
              className="crew-btn crew-btn-ghost crew-btn-small"
              disabled={!dirty && saved === base}
              onClick={() => setNotes((current) => ({ saved: current.saved, base: current.saved, draft: current.saved ?? '' }))}
            >
              Revert
            </button>
            <button type="button" className="crew-btn crew-btn-primary crew-btn-small" disabled={!dirty || status.saving} onClick={() => void save()}>
              Save
            </button>
          </div>
        </>
      ) : journal === null ? (
        <p className="crew-faint" role="status">Loading...</p>
      ) : journal.trim() ? (
        <pre className="crew-journal crew-selectable">{journal}</pre>
      ) : (
        <p className="crew-faint">The journal gets an entry at the end of every shift.</p>
      )}
    </div>
  );
}
