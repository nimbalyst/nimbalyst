import React from 'react';

/**
 * iOS-style toggle switch for settings panels.
 *
 * Two variants:
 * - **inline** (default): Label + description on the left, toggle on the right.
 *   Used for on/off settings within a section.
 * - **enable**: Larger "Enable X" row with bottom border, used as the
 *   primary provider enable toggle at the top of a panel.
 */
export function SettingsToggle({
  checked,
  onChange,
  name,
  description,
  disabled,
  variant = 'inline',
  testId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  name: string;
  description?: string;
  disabled?: boolean;
  /** 'inline' for compact rows, 'enable' for the primary provider toggle */
  variant?: 'inline' | 'enable';
  testId?: string;
}) {
  if (variant === 'enable') {
    return (
      <div data-testid={testId} className="provider-enable flex items-center justify-between gap-4 py-4 mb-4 border-b border-[var(--nim-border)]">
        <div>
          <span className="provider-enable-label text-sm font-medium text-[var(--nim-text)]">{name}</span>
          {description && (
            <p className="text-xs text-[var(--nim-text-muted)] mt-1">{description}</p>
          )}
        </div>
        <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <span className="text-sm font-medium text-[var(--nim-text)]">{name}</span>
        {description && (
          <p className="text-xs text-[var(--nim-text-muted)] mt-0.5">{description}</p>
        )}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/** The raw toggle switch control without any label/layout. */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`relative inline-block w-11 h-6 shrink-0 ${disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="hidden peer"
      />
      <span className="absolute cursor-pointer inset-0 rounded-full transition-all bg-[var(--nim-bg-tertiary)] before:absolute before:content-[''] before:h-5 before:w-5 before:left-0.5 before:bottom-0.5 before:rounded-full before:transition-all before:bg-white before:shadow-sm peer-checked:bg-[var(--nim-primary)] peer-checked:before:translate-x-5" />
    </label>
  );
}
