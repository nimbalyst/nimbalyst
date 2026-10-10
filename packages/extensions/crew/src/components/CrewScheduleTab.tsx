/**
 * The member's schedule: every entry, editable, with entries the member wrote
 * for itself marked as such. Saves replace the whole list, which is how the
 * backend stores it (the definition file's frontmatter).
 */
import { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/extension-sdk';
import type { CrewMemberSnapshot, CrewScheduleSpec, CrewWeekday } from '../shared/types';
import { CrewError, CrewToggle } from './CrewBits';
import { useCrew, useCrewAction, useCrewQuery } from './CrewContext';
import { formatScheduleTiming, formatTokens, formatWhen, WEEKDAYS } from './crewFormat';

type Editing = { index: number | null; spec: CrewScheduleSpec } | null;

export function CrewScheduleTab({ member }: { member: CrewMemberSnapshot }) {
  const { client } = useCrew();
  const { definition, runtime } = member;
  const slug = definition.slug;
  const schedule = useCrewQuery(() => client.call('scheduleGet', { slug }), [slug]);
  const { busy, error, run } = useCrewAction();
  const [editing, setEditing] = useState<Editing>(null);
  const entries = schedule.data?.entries ?? null;
  const specs = entries?.map((e) => e.spec) ?? [];

  /** Save a whole new list; returns whether it stuck. */
  const save = async (next: CrewScheduleSpec[]) => {
    const result = await run('schedule', () => client.call('scheduleSet', { slug, schedule: next }));
    if (result) schedule.reload();
    return result !== undefined;
  };

  // A user edit to an entry the member wrote makes it the user's.
  const asUsers = (spec: CrewScheduleSpec): CrewScheduleSpec => ({ ...spec, createdBy: 'user' });

  return (
    <div className="crew-stack crew-schedule-tab">
      <section>
        <div className="crew-section-label crew-row">
          <span className="crew-grow">Schedule</span>
          {!editing && (
            <button type="button" className="crew-link-button" onClick={() => setEditing({ index: null, spec: { daily: '09:00', prompt: '' } })}>
              Add
            </button>
          )}
        </div>
        {editing && editing.index === null && (
          <CrewScheduleEditor
            initial={editing.spec}
            busy={busy !== null}
            onCancel={() => setEditing(null)}
            onSave={async (spec) => { if (await save([...specs, asUsers(spec)])) setEditing(null); }}
          />
        )}
        {entries === null ? (
          schedule.error ? <CrewError message={schedule.error} /> : <p className="crew-faint" role="status">Loading...</p>
        ) : entries.length === 0 && !editing ? (
          <p className="crew-faint">No schedule. {definition.name} only works when you start a shift or it wakes itself.</p>
        ) : (
          <div className="crew-stack">
            {entries.map((entry) => editing?.index === entry.index ? (
              <CrewScheduleEditor
                key={entry.index}
                initial={entry.spec}
                busy={busy !== null}
                onCancel={() => setEditing(null)}
                onSave={async (spec) => {
                  if (await save(specs.map((s, i) => (i === entry.index ? asUsers(spec) : s)))) setEditing(null);
                }}
              />
            ) : (
              <div key={entry.index} className="crew-schedule-row" data-enabled={entry.spec.enabled !== false}>
                <div className="crew-row">
                  <MaterialSymbol icon={entry.spec.at ? 'event' : 'schedule'} size={14} />
                  <span className="crew-grow crew-truncate crew-mono">{entry.description || formatScheduleTiming(entry.spec)}</span>
                  <CrewToggle
                    label="Enabled"
                    checked={entry.spec.enabled !== false}
                    disabled={busy !== null}
                    onChange={(enabled) => void save(specs.map((s, i) => (i === entry.index ? { ...s, enabled } : s)))}
                  />
                  <button type="button" className="crew-icon-button" aria-label="Edit schedule entry" onClick={() => setEditing({ index: entry.index, spec: entry.spec })}>
                    <MaterialSymbol icon="edit" size={14} />
                  </button>
                  <button
                    type="button"
                    className="crew-icon-button"
                    aria-label="Remove schedule entry"
                    disabled={busy !== null}
                    onClick={() => void save(specs.filter((_, i) => i !== entry.index))}
                  >
                    <MaterialSymbol icon="delete" size={14} />
                  </button>
                </div>
                {entry.spec.prompt && <p className="crew-schedule-prompt crew-selectable">{entry.spec.prompt}</p>}
                <div className="crew-row crew-small">
                  {entry.nextRunAt && entry.spec.enabled !== false && <span className="crew-faint">Next {formatWhen(entry.nextRunAt)}</span>}
                  {entry.spec.createdBy === 'member' && (
                    <span className="crew-self-made" title={`${definition.name} added or changed this entry itself`}>
                      Set by {definition.name}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <CrewError message={error} />
      </section>

      <section>
        <div className="crew-section-label">Limits</div>
        <dl className="crew-limits">
          <dt>Shifts today</dt>
          <dd>{runtime.usage.shiftsToday} of {runtime.usage.shiftsPerDayLimit}</dd>
          <dt>Tokens today</dt>
          <dd>{formatTokens(runtime.usage.tokensToday)} of {formatTokens(runtime.usage.dailyCeiling)}</dd>
          <dt>Quiet hours</dt>
          <dd>{schedule.data?.quietHours ?? definition.notify.quietHours ?? 'None'}</dd>
          <dt>Loudest level</dt>
          <dd>{definition.notify.maxLevel}</dd>
        </dl>
        <p className="crew-faint crew-small">Limits live in the definition file.</p>
      </section>
    </div>
  );
}

type EditorKind = 'daily' | 'weekly' | 'interval' | 'at';

function kindOf(spec: CrewScheduleSpec): EditorKind {
  if (spec.weekly) return 'weekly';
  if (spec.interval) return 'interval';
  if (spec.at) return 'at';
  return 'daily';
}

/** Local datetime-input value for an ISO time. */
function toLocalInput(iso: string | undefined): string {
  const date = iso ? new Date(iso) : new Date(Date.now() + 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function CrewScheduleEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: CrewScheduleSpec;
  busy: boolean;
  onSave: (spec: CrewScheduleSpec) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<EditorKind>(kindOf(initial));
  const [time, setTime] = useState(initial.daily ?? initial.weekly?.time ?? '09:00');
  const [days, setDays] = useState<CrewWeekday[]>(initial.weekly?.days ?? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
  const [minutes, setMinutes] = useState(initial.interval?.minutes ?? 60);
  const [at, setAt] = useState(toLocalInput(initial.at));
  const [prompt, setPrompt] = useState(initial.prompt);

  const base = { prompt: prompt.trim(), ...(initial.enabled !== undefined ? { enabled: initial.enabled } : {}) };
  const spec: CrewScheduleSpec | null =
    kind === 'daily' ? (time ? { ...base, daily: time } : null)
      : kind === 'weekly' ? (time && days.length > 0 ? { ...base, weekly: { days, time } } : null)
        : kind === 'interval' ? (minutes >= 5 ? { ...base, interval: { minutes } } : null)
          : (at ? { ...base, at: new Date(at).toISOString() } : null);
  const valid = spec !== null && base.prompt.length > 0;

  return (
    <div className="crew-schedule-editor">
      <div className="crew-row">
        <select className="crew-input crew-grow" value={kind} onChange={(e) => setKind(e.target.value as EditorKind)} aria-label="Repeat">
          <option value="daily">Every day</option>
          <option value="weekly">On days</option>
          <option value="interval">Every N minutes</option>
          <option value="at">Once</option>
        </select>
        {(kind === 'daily' || kind === 'weekly') && (
          <input type="time" className="crew-input crew-input-time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
        )}
        {kind === 'interval' && (
          <input type="number" min={5} className="crew-input crew-input-number" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Minutes" />
        )}
        {kind === 'at' && (
          <input type="datetime-local" className="crew-input crew-grow" value={at} onChange={(e) => setAt(e.target.value)} aria-label="When" />
        )}
      </div>
      {kind === 'weekly' && (
        <div className="crew-day-picker" role="group" aria-label="Days">
          {WEEKDAYS.map((day) => {
            const on = days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                data-on={on}
                onClick={() => setDays(on ? days.filter((d) => d !== day) : WEEKDAYS.filter((d) => d === day || days.includes(d)))}
              >
                {day.slice(0, 2).replace(/^./, (c) => c.toUpperCase())}
              </button>
            );
          })}
        </div>
      )}
      <textarea className="crew-input crew-textarea-small" placeholder="What should this run do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="crew-row crew-row-end">
        <button type="button" className="crew-btn crew-btn-ghost crew-btn-small" onClick={onCancel}>Cancel</button>
        <button type="button" className="crew-btn crew-btn-primary crew-btn-small" disabled={!valid || busy} onClick={() => spec && onSave(spec)}>
          Save
        </button>
      </div>
    </div>
  );
}
