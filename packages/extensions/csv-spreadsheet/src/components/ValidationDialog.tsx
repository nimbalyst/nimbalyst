/**
 * Data validation for the selection: a dropdown list (with chip colors), a
 * checkbox, a number or date range, or a text length, and whether an invalid
 * entry is rejected or only marked.
 */

import { useEffect, useState } from 'react';
import type { CellColor } from '../types';
import type { ListOption, ValidationMode, ValidationRule } from '../validation/types';
import { parseListOptions } from '../validation/entry';

type Kind = ValidationRule['kind'];

const KINDS: readonly { kind: Kind; label: string }[] = [
  { kind: 'list', label: 'Dropdown' },
  { kind: 'checkbox', label: 'Checkbox' },
  { kind: 'numberRange', label: 'Number between' },
  { kind: 'dateRange', label: 'Date between' },
  { kind: 'textLength', label: 'Text length' },
];
const CHIP_COLORS: readonly CellColor[] = ['default', 'green', 'blue', 'yellow', 'orange', 'red', 'purple', 'gray'];

const FIELD = 'px-2 py-1.5 text-[13px] bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)]';
const LABEL = 'text-[12px] font-medium text-nim-muted';

function numberOrUndefined(text: string): number | undefined {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value) ? undefined : value;
}

export function ValidationDialog({ isOpen, rangeLabel, current, onSave, onClose }: {
  isOpen: boolean;
  rangeLabel: string;
  current: ValidationRule | null;
  onSave: (rule: ValidationRule | null) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>('list');
  const [mode, setMode] = useState<ValidationMode>('warn');
  const [optionsText, setOptionsText] = useState('');
  const [colors, setColors] = useState<Record<string, CellColor>>({});
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const rule = current;
    setKind(rule?.kind ?? 'list');
    setMode(rule?.mode ?? 'warn');
    setMessage(rule?.message ?? '');
    setOptionsText(rule?.kind === 'list' ? rule.options.map((o) => o.value).join('\n') : '');
    setColors(rule?.kind === 'list' ? Object.fromEntries(rule.options.map((o) => [o.value, o.color ?? 'default'])) : {});
    setMin(rule && 'min' in rule && rule.min !== undefined ? String(rule.min) : '');
    setMax(rule && 'max' in rule && rule.max !== undefined ? String(rule.max) : '');
  }, [isOpen, current]);

  if (!isOpen) return null;
  const options = parseListOptions(optionsText);

  const build = (): ValidationRule | null => {
    const base = { mode, ...(message.trim() ? { message: message.trim() } : {}) };
    switch (kind) {
      case 'list': {
        if (options.length === 0) return null;
        const list: ListOption[] = options.map((value) => {
          const color = colors[value];
          return color && color !== 'default' ? { value, color } : { value };
        });
        return { ...base, kind, options: list };
      }
      case 'checkbox': return { ...base, kind };
      case 'numberRange': return { ...base, kind, min: numberOrUndefined(min), max: numberOrUndefined(max) };
      case 'textLength': return { ...base, kind, min: numberOrUndefined(min), max: numberOrUndefined(max) };
      case 'dateRange': return { ...base, kind, ...(min ? { min } : {}), ...(max ? { max } : {}) };
    }
  };
  const rule = build();

  return (
    <div className="csv-validation-dialog fixed inset-0 bg-black/40 flex items-center justify-center z-[2000]" onClick={onClose}>
      <div
        className="bg-nim border border-nim rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.24)] w-[380px]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-nim">
          <h3 className="m-0 text-base font-semibold text-nim">Data validation {rangeLabel}</h3>
          <button className="bg-none border-none text-xl text-nim-muted cursor-pointer p-0 leading-none hover:text-nim" onClick={onClose}>&times;</button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Criteria</span>
            <select className={FIELD} value={kind} onChange={(event) => setKind(event.target.value as Kind)} data-validation-field="kind">
              {KINDS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
            </select>
          </label>
          {kind === 'list' && (
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Options, one per line</span>
              <textarea className={`${FIELD} min-h-[80px] font-mono`} value={optionsText} data-validation-field="options"
                onChange={(event) => setOptionsText(event.target.value)} />
              {options.length > 0 && (
                <div className="flex flex-col gap-1 max-h-[140px] overflow-y-auto">
                  {options.map((value) => (
                    <div key={value} className="flex items-center justify-between gap-2 text-[12px] text-nim">
                      <span className="truncate">{value}</span>
                      <select className={FIELD} value={colors[value] ?? 'default'} aria-label={`Color for ${value}`}
                        onChange={(event) => setColors((prev) => ({ ...prev, [value]: event.target.value as CellColor }))}>
                        {CHIP_COLORS.map((color) => <option key={color} value={color}>{color === 'default' ? 'Neutral' : color}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </label>
          )}
          {(kind === 'numberRange' || kind === 'textLength' || kind === 'dateRange') && (
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 flex-1">
                <span className={LABEL}>{kind === 'textLength' ? 'Min length' : 'Min'}</span>
                <input className={FIELD} type={kind === 'dateRange' ? 'date' : 'number'} value={min} onChange={(event) => setMin(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1 flex-1">
                <span className={LABEL}>{kind === 'textLength' ? 'Max length' : 'Max'}</span>
                <input className={FIELD} type={kind === 'dateRange' ? 'date' : 'number'} value={max} onChange={(event) => setMax(event.target.value)} />
              </label>
            </div>
          )}
          <fieldset className="flex flex-col gap-1 border-none p-0 m-0">
            <span className={LABEL}>If the data is invalid</span>
            <label className="flex items-center gap-2 text-[13px] text-nim">
              <input type="radio" checked={mode === 'warn'} onChange={() => setMode('warn')} /> Show a warning
            </label>
            <label className="flex items-center gap-2 text-[13px] text-nim">
              <input type="radio" checked={mode === 'reject'} onChange={() => setMode('reject')} data-validation-field="reject" /> Reject the input
            </label>
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Help text (optional)</span>
            <input className={FIELD} value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
        </div>
        <div className="flex justify-between gap-2 px-5 py-4 border-t border-nim">
          <button className="px-3 py-2 text-sm rounded cursor-pointer bg-transparent border border-nim text-nim-muted hover:bg-nim-hover disabled:opacity-40"
            disabled={!current} onClick={() => { onSave(null); onClose(); }}>Remove rule</button>
          <div className="flex gap-2">
            <button className="px-4 py-2 text-sm font-medium rounded cursor-pointer bg-nim-secondary border border-nim text-nim hover:bg-nim-hover" onClick={onClose}>Cancel</button>
            <button className="px-4 py-2 text-sm font-medium rounded cursor-pointer bg-[var(--nim-primary)] border border-[var(--nim-primary)] text-white hover:opacity-90 disabled:opacity-40"
              disabled={!rule} data-validation-field="save" onClick={() => { onSave(rule); onClose(); }}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
