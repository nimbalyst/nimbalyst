import React from 'react';
import {
  getBuiltInProviderControlEntry,
  type ProviderControlDefinition,
  type ProviderControlValue,
} from '@nimbalyst/runtime/ai/server';

interface CatalogControlSelectorsProps {
  modelId?: string;
  values: Readonly<Record<string, ProviderControlValue | undefined>>;
  onChange: (settingId: string, value: ProviderControlValue) => void;
  disabled?: boolean;
  disabledTitle?: string;
}

function controlValue(
  control: ProviderControlDefinition,
  values: CatalogControlSelectorsProps['values'],
): ProviderControlValue {
  const candidate = values[control.settingId];
  if (control.type === 'boolean') {
    return typeof candidate === 'boolean' ? candidate : control.defaultValue;
  }
  if (control.type === 'number') {
    return typeof candidate === 'number'
      && Number.isFinite(candidate)
      && candidate >= control.minimum
      && candidate <= control.maximum
      ? candidate
      : control.defaultValue;
  }
  return typeof candidate === 'string' && control.allowedValues.includes(candidate)
    ? candidate
    : control.defaultValue;
}

export function CatalogControlSelectors({
  modelId,
  values,
  onChange,
  disabled = false,
  disabledTitle,
}: CatalogControlSelectorsProps) {
  const entry = getBuiltInProviderControlEntry(modelId);
  if (!entry) return null;

  return (
    <>
      {entry.controls.map((control) => {
        const value = controlValue(control, values);
        const title = disabled ? disabledTitle : control.helpText;
        if (control.type === 'boolean') {
          return (
            <button
              key={control.id}
              type="button"
              className="rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-[3px] text-[11px] text-[var(--nim-text-muted)] disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={control.label}
              aria-pressed={Boolean(value)}
              title={title}
              disabled={disabled}
              onClick={() => onChange(control.settingId, !value)}
            >
              {control.label}: {value ? 'On' : 'Off'}
            </button>
          );
        }
        if (control.type === 'number') {
          return (
            <label key={control.id} className="inline-flex items-center gap-1 text-[11px] text-[var(--nim-text-muted)]" title={title}>
              {control.label}
              <input
                aria-label={control.label}
                className="w-16 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-1 py-[2px]"
                type="number"
                value={Number(value)}
                min={control.minimum}
                max={control.maximum}
                step={control.step}
                disabled={disabled}
                onChange={(event) => onChange(control.settingId, Number(event.target.value))}
              />
            </label>
          );
        }
        return (
          <label key={control.id} className="inline-flex items-center gap-1 text-[11px] text-[var(--nim-text-muted)]" title={title}>
            {control.label}
            <select
              aria-label={control.label}
              className="rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-[3px] text-[11px] text-[var(--nim-text-muted)] disabled:cursor-not-allowed disabled:opacity-45"
              value={String(value)}
              disabled={disabled}
              onChange={(event) => onChange(control.settingId, event.target.value)}
            >
              {control.allowedValues.map((allowed) => (
                <option key={allowed} value={allowed}>{allowed}</option>
              ))}
            </select>
          </label>
        );
      })}
    </>
  );
}
