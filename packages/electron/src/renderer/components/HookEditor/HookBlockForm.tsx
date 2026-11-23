/**
 * The inline form for one hook. Each field saves when you leave it. A field
 * left empty is removed from the hook, except the fields the action needs.
 */

import { useEffect, useState } from 'react';

import { defaultTimeoutSeconds, eventRule } from '../../../shared/hookEditor/compatibility';
import type { HookBlock } from '../../../shared/hookEditor/hookDocument';
import type { HookEdit } from '../../../shared/hookEditor/hookEdits';
import { ACTION_HOOK_TYPE } from '../../../shared/hookEditor/sourceRules';
import type { HookSourceKind, JsonValue, ThenBlock } from '../../../shared/hookEditor/types';
import { BUTTON, DECISION_CHOICES, EVENT_NOTES, FIELD_LABELS, giveUpText, linesOfObject, objectOfLines } from './hookEditorText';

type EditableBlock = Exclude<HookBlock, { kind: 'opaque' }>;

const ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  runScript: ['command'],
  runCommand: ['command'],
  sendToWeb: ['url', 'headers', 'allowedEnvVars'],
  askAi: ['prompt', 'continueOnBlock'],
  runAgent: ['prompt'],
  callMcpTool: ['server', 'tool', 'input'],
};

const SESSION_START_MCP_NOTE = 'On SessionStart, an MCP tool skips launch and resume. It runs after /clear and after compaction.';

/**
 * One text box. It shows the file's value until you type. What you type is a
 * draft that lives only until you leave the box. Leaving the box sends the
 * draft up when it differs from the file, and then the draft is dropped. The
 * box then shows the file's value again: the new text if the edit went
 * through, the old text if it was refused or changed nothing. An undo shows
 * in the box at once, unless you are typing in it.
 */
function TextField({ name, label, value, lines, onCommit }: { name: string; label: string; value: string; lines?: boolean; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const props = {
    'data-testid': `hook-field-${name}`,
    className: 'w-full select-text rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 font-mono text-xs',
    value: draft ?? value,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => {
      if (draft !== null && draft !== value) onCommit(draft);
      setDraft(null);
    },
  };
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--nim-text-muted)]">{label}</span>
      {lines ? <textarea rows={3} {...props} /> : <input {...props} />}
    </label>
  );
}

/**
 * The time limit slider. It shows the value while you drag, and saves once
 * when you let go, so one drag is one undo step. A hook with no time limit
 * uses the default, so the file leaves the key out. Letting go on exactly
 * the default value removes the key again. The button does the same.
 */
function TimeoutSlider({
  shown,
  isDefault,
  defaultSeconds,
  note,
  onCommit,
}: {
  shown: number;
  isDefault: boolean;
  defaultSeconds: number;
  note: string;
  onCommit: (seconds: number | undefined) => void;
}) {
  const [seconds, setSeconds] = useState(shown);
  // The file's value wins when it changes from outside, for example after an undo.
  useEffect(() => setSeconds(shown), [shown]);
  const commit = () => seconds !== shown && onCommit(seconds === defaultSeconds ? undefined : seconds);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-[var(--nim-text-muted)]">
          Time limit: {seconds} s{isDefault && seconds === shown ? ' (the default, so the file leaves it out)' : ''}
        </span>
        {!isDefault && (
          <button type="button" data-testid="hook-timeout-default" className={`${BUTTON.ghost} ${BUTTON.small}`} onClick={() => onCommit(undefined)}>
            Use the default
          </button>
        )}
      </div>
      <input
        type="range"
        min={1}
        max={600}
        value={seconds}
        aria-label="Time limit in seconds"
        data-testid="hook-field-timeout"
        onChange={(event) => setSeconds(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span className="text-[var(--nim-text-faint)]">{note}</span>
    </div>
  );
}

export function HookBlockForm({ block, source, onEdit }: { block: EditableBlock; source: HookSourceKind; onEdit: (edit: HookEdit) => void }) {
  const { key, entry } = block;
  const setField = (name: string, value: JsonValue | undefined) => onEdit({ kind: 'setField', key, name, value });
  const text = (name: string) => (typeof entry[name] === 'string' ? (entry[name] as string) : '');
  const rule = eventRule(key.event);

  if (block.kind === 'then') {
    const then = block.then;
    const setThen = (next: ThenBlock) => onEdit({ kind: 'setThen', key, then: next });
    return (
      <div className="hook-block-form flex flex-col gap-2 p-2">
        {then.answer === 'permission' && (
          <select
            data-testid="hook-field-decision"
            value={then.decision}
            onChange={(event) => setThen({ ...then, decision: event.target.value as 'allow' | 'deny' | 'ask' })}
          >
            {DECISION_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        )}
        {then.answer === 'watchFiles' ? (
          <TextField
            name="paths"
            label={FIELD_LABELS.paths}
            lines
            value={then.paths.join('\n')}
            onCommit={(value) => setThen({ answer: 'watchFiles', paths: value.split('\n').map((path) => path.trim()).filter(Boolean) })}
          />
        ) : (
          <TextField name="message" label={FIELD_LABELS.message} lines value={then.message} onCommit={(message) => setThen({ ...then, message })} />
        )}
        {/* A settings file keeps the Then block as a plain command. If that command crashes, Claude Code carries on, so say so. */}
        {source !== 'hookPackDraft' && (
          <p className="select-text text-xs text-[var(--nim-text-muted)]" data-testid="hook-fails-open-note">
            In a settings file this check fails open: if it crashes, Claude Code goes on as if the check was not there.
          </p>
        )}
      </div>
    );
  }

  const type = ACTION_HOOK_TYPE[block.action];
  const timeout = typeof entry.timeout === 'number' ? entry.timeout : defaultTimeoutSeconds(key.event, type);
  return (
    <div className="hook-block-form flex flex-col gap-2 p-2">
      {ACTION_FIELDS[block.action].map((name) => {
        if (name === 'headers' || name === 'input') {
          return (
            <TextField
              key={name}
              name={name}
              label={name === 'headers' ? 'Headers, one "name: value" on each line' : 'Tool input, one "name: value" on each line'}
              lines
              value={linesOfObject(entry[name])}
              onCommit={(value) => setField(name, value.trim() === '' ? undefined : objectOfLines(value))}
            />
          );
        }
        if (name === 'allowedEnvVars') {
          const list = Array.isArray(entry.allowedEnvVars) ? (entry.allowedEnvVars as string[]) : [];
          return (
            <div key={name}>
              <TextField
                name={name}
                label="Environment variables the headers may use, comma between"
                value={list.join(', ')}
                onCommit={(value) => setField(name, value.trim() === '' ? undefined : value.split(',').map((item) => item.trim()).filter(Boolean))}
              />
              <p className="select-text text-xs text-[var(--nim-text-faint)]">Variables not in this list become empty.</p>
            </div>
          );
        }
        if (name === 'continueOnBlock') {
          return (
            <label key={name} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="hook-field-continueOnBlock"
                checked={entry.continueOnBlock === true}
                onChange={(event) => setField(name, event.target.checked ? true : undefined)}
              />
              Let Claude carry on after this blocks
            </label>
          );
        }
        return <TextField key={name} name={name} label={FIELD_LABELS[name] ?? name} lines={name === 'prompt'} value={text(name)} onCommit={(value) => setField(name, value)} />;
      })}
      {(block.action === 'askAi' || block.action === 'runAgent') && <p className="select-text text-xs text-[var(--nim-warning)]">Uses AI tokens each time it runs.</p>}
      {block.action === 'askAi' && (
        <p className="select-text text-xs text-[var(--nim-text-muted)]">
          The AI answers "ok", or "not ok" with a reason. Write the prompt as a question it can answer that way.
        </p>
      )}
      {key.event === 'SessionStart' && block.action === 'callMcpTool' && <p className="select-text text-xs text-[var(--nim-text-muted)]">{SESSION_START_MCP_NOTE}</p>}
      <TimeoutSlider
        shown={timeout}
        isDefault={entry.timeout === undefined}
        defaultSeconds={defaultTimeoutSeconds(key.event, type)}
        note={giveUpText(key.event)}
        onCommit={(seconds) => setField('timeout', seconds)}
      />
      {rule?.ifRuns && <TextField name="if" label="Narrow to, for example Bash(git *)" value={text('if')} onCommit={(value) => setField('if', value.trim() === '' ? undefined : value)} />}
      <TextField name="statusMessage" label="Message while it runs" value={text('statusMessage')} onCommit={(value) => setField('statusMessage', value.trim() === '' ? undefined : value)} />
      {EVENT_NOTES[key.event as keyof typeof EVENT_NOTES] !== undefined && (
        <p className="select-text text-xs text-[var(--nim-text-muted)]">{EVENT_NOTES[key.event as keyof typeof EVENT_NOTES]}</p>
      )}
    </div>
  );
}
