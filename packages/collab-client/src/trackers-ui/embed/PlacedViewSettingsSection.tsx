import { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { DisplayViewSettings } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/DisplayViewSettings';
import { DisplayOptionsColumnList } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/DisplayOptionsColumnList';
import type { PlacedViewSettingsProps } from './PlacedViewSettings';
import { PlacedViewFilterSettings } from './PlacedViewFilterSettings';

export type ViewSettingsSection = 'layout' | 'properties' | 'filter' | 'sort' | 'group';
export const VIEW_LAYOUTS = [
  { value: 'table', label: 'Table', icon: 'table_chart' },
  { value: 'board', label: 'Board', icon: 'view_kanban' },
  { value: 'list', label: 'List', icon: 'view_list' },
  { value: 'timeline', label: 'Timeline', icon: 'timeline' },
  { value: '2x2', label: '2×2', icon: 'grid_view' },
];
export const SETTINGS_INPUT = 'min-w-0 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim';
const OPTION = 'flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-nim-hover';

export function PlacedViewSettingsSection({ section, attrs, fields, availableColumns, defaultColumns, onChange }: PlacedViewSettingsProps & { section: ViewSettingsSection }) {
  const [search, setSearch] = useState('');
  const selected = attrs.cols ? attrs.cols.split(',') : [...(defaultColumns ?? ['title'])];
  const sorts = (attrs.sort || '').split(',').filter(Boolean);
  const setSort = (index: number, value: string | null) => onChange({ sort: sorts.map((sort, i) => i === index ? value : sort).filter(Boolean).join(',') || null });
  if (section === 'layout') return <div className="placed-view-layout-settings">
    <DisplayViewSettings availableColumns={availableColumns} viewModes={VIEW_LAYOUTS} viewMode={attrs.mode || 'table'} onViewModeChange={mode => onChange({ mode })} />
    {attrs.mode === 'timeline' && <div className="space-y-2 px-3 py-3">
      {['start', 'end'].map(key => <label key={key} className="flex items-center justify-between gap-3 text-xs text-nim-muted">{key === 'start' ? 'Start date' : 'End date'}
        <select aria-label={`Timeline ${key}`} className={SETTINGS_INPUT} value={attrs[key] || ''} onChange={event => onChange({ [key]: event.target.value || null })}>
          <option value="">{attrs.start || attrs.end ? 'Not selected' : 'Automatic'}</option>
          {fields.filter(field => !field.multiValue && ['date', 'datetime'].includes(field.type ?? '')).map(field => <option key={field.id} value={field.id}>{field.label}</option>)}
        </select>
      </label>)}
    </div>}
    {attrs.mode === '2x2' && <div className="space-y-2 px-3 py-3">{['x', 'y'].map(axis => <label key={axis} className="flex items-center justify-between gap-3 text-xs text-nim-muted">{axis.toUpperCase()} axis
      <select aria-label={`${axis.toUpperCase()} axis`} className={SETTINGS_INPUT} value={attrs[axis] || ''} onChange={event => onChange({ [axis]: event.target.value })}>
        <option value="">Choose field</option>{fields.filter(field => field.type === 'number').map(field => <option key={field.id} value={field.id}>{field.label}</option>)}
      </select>
    </label>)}</div>}
  </div>;
  if (section === 'properties') return <DisplayOptionsColumnList availableColumns={availableColumns} config={{ visibleColumns: selected, columnWidths: {} }} onConfigChange={config => onChange({ cols: config.visibleColumns.join(',') })} />;
  if (section === 'filter') return <PlacedViewFilterSettings attrs={attrs} fields={fields} onChange={onChange} />;
  if (section === 'sort') return <div className="placed-view-sort-settings space-y-2 px-3">
    {!sorts.length && <p className="py-2 text-xs text-nim-muted">Choose a property to sort by.</p>}
    {sorts.map((sort, index) => {
      const [field, direction = 'desc'] = sort.split(':');
      return <div key={index} className="flex items-center gap-1.5">
        <select aria-label={`Sort field ${index + 1}`} className={`${SETTINGS_INPUT} flex-1`} value={field} onChange={event => setSort(index, `${event.target.value}:${direction}`)}>{fields.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select>
        <select aria-label={`Sort direction ${index + 1}`} className={SETTINGS_INPUT} value={direction} onChange={event => setSort(index, `${field}:${event.target.value}`)}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
        <button type="button" className="rounded p-1 text-nim-muted hover:bg-nim-hover" aria-label={`Remove sort ${index + 1}`} onClick={() => setSort(index, null)}><MaterialSymbol icon="close" size={16} /></button>
      </div>;
    })}
    <button type="button" className={`${OPTION} text-nim-muted`} onClick={() => onChange({ sort: [...sorts, `${fields.find(field => !sorts.some(sort => sort.split(':')[0] === field.id))?.id || 'title'}:asc`].join(',') })}><MaterialSymbol icon="add" size={16} />Add sort</button>
  </div>;
  const group = attrs.group || (attrs.mode === 'board' ? 'status' : 'none');
  const groups = [...new Set(['none', 'status', 'priority', 'assignee', 'type', 'tag', 'milestone', 'goal', ...fields.filter(field => !field.multiValue && ['select', 'boolean', 'user', 'relationship'].includes(field.type ?? '')).map(field => field.id)])];
  return <div className="placed-view-group-settings px-2">
    <input aria-label="Find grouping property" placeholder="Find a property…" className={`${SETTINGS_INPUT} mb-2 w-full`} value={search} onChange={event => setSearch(event.target.value)} />
    {groups.map(id => ({ id, label: id === 'none' ? 'No grouping' : fields.find(field => field.id === id)?.label || id.charAt(0).toUpperCase() + id.slice(1) })).filter(option => option.label.toLowerCase().includes(search.toLowerCase())).map(option => <button key={option.id} type="button" className={OPTION} aria-pressed={option.id === group} onClick={() => onChange({ group: option.id })}>
      <span className="flex-1">{option.label}</span>{option.id === group && <MaterialSymbol icon="check" size={16} className="text-nim-link" />}
    </button>)}
  </div>;
}
