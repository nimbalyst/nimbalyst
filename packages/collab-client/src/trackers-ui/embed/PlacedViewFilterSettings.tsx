import { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { PlacedViewSettingsProps } from './PlacedViewSettings';

const INPUT = 'min-w-0 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim';
const OPERATORS: Record<string, string> = { '=': 'is', '!': 'is not', '>': 'is greater than', '<': 'is less than', '>=': 'is at least', '<=': 'is at most', empty: 'is empty', '!empty': 'is not empty' };

export function PlacedViewFilterSettings({ attrs, fields, onChange }: Pick<PlacedViewSettingsProps, 'attrs' | 'fields' | 'onChange'>) {
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? 'title');
  const [operator, setOperator] = useState('=');
  const [value, setValue] = useState('');
  const field = fields.find(candidate => candidate.id === fieldId);
  const comparisons = ['number', 'date', 'datetime'].includes(field?.type ?? '');
  const unary = operator.endsWith('empty');
  const clauses = (attrs.filter || '').split(',').filter(Boolean);
  const describe = (clause: string) => {
    const colon = clause.indexOf(':');
    const id = clause.slice(0, colon);
    const raw = clause.slice(colon + 1);
    const op = raw === 'empty' || raw === '!empty' ? raw : /^(>=|<=|>|<|!|=)/.exec(raw)?.[0] || '=';
    const operand = op.endsWith('empty') ? '' : raw.slice(raw.startsWith(op) ? op.length : 0);
    const definition = fields.find(candidate => candidate.id === id);
    try {
      return `${definition?.label || id} ${OPERATORS[op]} ${operand.split('|').map(part => { const decoded = decodeURIComponent(part); return definition?.options?.find(option => option.value === decoded)?.label || decoded; }).join(' or ')}`;
    } catch { return clause; }
  };
  return <div className="placed-view-filter-settings space-y-3 px-3">
    <label className="flex items-center justify-between gap-2 text-xs text-nim-muted">Items
      <select aria-label="Items" className={INPUT} value={attrs.scope || 'all'} onChange={event => onChange({ scope: event.target.value })}><option value="all">All states</option><option value="open">Open only</option></select>
    </label>
    <p className="text-[11px] text-nim-muted">Show items matching all conditions</p>
    {clauses.map((clause, index) => <div key={`${index}:${clause}`} className="flex items-start gap-2 rounded bg-nim-tertiary px-2 py-1.5 text-xs">
      <span className="min-w-0 flex-1 break-words">{describe(clause)}</span>
      <button type="button" className="shrink-0 text-nim-muted hover:text-nim" aria-label={`Remove filter ${clause}`} onClick={() => onChange({ filter: clauses.filter((_, i) => i !== index).join(',') || null })}><MaterialSymbol icon="close" size={16} /></button>
    </div>)}
    <div className="space-y-2 rounded border border-nim p-2">
      <div className="flex gap-2">
        <select aria-label="Filter field" className={`${INPUT} flex-1`} value={fieldId} onChange={event => { setFieldId(event.target.value); setOperator('='); setValue(''); }}>{fields.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select>
        <select aria-label="Filter operator" className={`${INPUT} flex-1`} value={operator} onChange={event => setOperator(event.target.value)}>{Object.entries(OPERATORS).filter(([op]) => comparisons || !['>', '<', '>=', '<='].includes(op)).map(([op, label]) => <option key={op} value={op}>{label}</option>)}</select>
      </div>
      {!unary && (field?.options?.length || field?.type === 'boolean' ? <select aria-label="Filter value" className={`${INPUT} w-full`} value={value} onChange={event => setValue(event.target.value)}>
        <option value="">Choose a value…</option>{(field?.options?.length ? field.options : [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input aria-label="Filter value" className={`${INPUT} w-full`} type={field?.type === 'number' ? 'number' : 'text'} placeholder={['date', 'datetime'].includes(field?.type ?? '') ? 'Date, today or +7d' : 'Value'} value={value} onChange={event => setValue(event.target.value)} />)}
      <button type="button" className="flex items-center gap-1 rounded px-1 py-1 text-xs text-nim-muted hover:bg-nim-hover disabled:opacity-40" disabled={!unary && !value.trim()} onClick={() => onChange({ filter: [...clauses, `${fieldId}:${operator}${unary ? '' : encodeURIComponent(value)}`].join(',') })}><MaterialSymbol icon="add" size={16} />Add filter</button>
    </div>
  </div>;
}
