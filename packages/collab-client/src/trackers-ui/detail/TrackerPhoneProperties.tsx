import React from 'react';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { TrackerFieldEditor, type TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';

export function TrackerPhoneProperties({ fields, values, editing, onChange, teamMembers = [] }: {
  fields: FieldDefinition[];
  values: Record<string, unknown>;
  editing: boolean;
  onChange?: (name: string, value: unknown) => void | Promise<unknown>;
  teamMembers?: TeamMemberOption[];
}) {
  return <div className="tracker-phone-properties">
    {fields.map(field => {
      const value = values[field.name];
      const label = field.name.replace(/([A-Z])/g, ' $1').replace(/^./, text => text.toUpperCase());
      const change = (next: unknown) => { void Promise.resolve(onChange?.(field.name, next)).catch(() => {}); };
      if (!editing || field.readOnly) {
        const display = field.options?.find(option => option.value === value)?.label ??
          (value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value));
        return <div className="tracker-phone-property-value" key={field.name}><span>{label}</span><span>{display}</span></div>;
      }
      if (field.type === 'select' || field.type === 'user') {
        const options = field.type === 'user' ? teamMembers.map(member => ({ value: member.email, label: member.name || member.email })) : field.options ?? [];
        return <label key={field.name}>{label}<select aria-label={label} value={String(value ?? '')} onChange={event => change(event.target.value)}>
          <option value="">Choose…</option>
          {value && !options.some(option => option.value === value) ? <option value={String(value)}>{String(value)}</option> : null}
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>;
      }
      // Preserve the shared schema editor for structured and relationship fields.
      return <TrackerFieldEditor key={field.name} field={field} value={value} onChange={change} layout="vertical" teamMembers={teamMembers} />;
    })}
  </div>;
}
