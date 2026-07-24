/**
 * ViewportSelector - Responsive viewport preset buttons
 *
 * Allows users to preview mockups at different device widths.
 * The iframe width changes but the mockup source stays the same.
 */

import { memo } from 'react';

export interface ViewportPreset {
  label: string;
  width: number | null; // null = full width (responsive)
  icon: string;
}

const PRESETS: ViewportPreset[] = [
  { label: 'Full', width: null, icon: 'monitor' },
  { label: 'Desktop', width: 1440, icon: 'desktop' },
  { label: 'Laptop', width: 1024, icon: 'laptop' },
  { label: 'Tablet', width: 768, icon: 'tablet' },
  { label: 'Mobile', width: 375, icon: 'mobile' },
];

interface ViewportSelectorProps {
  activeWidth: number | null;
  onSelect: (width: number | null) => void;
}

export const ViewportSelector = memo(function ViewportSelector({
  activeWidth,
  onSelect,
}: ViewportSelectorProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {PRESETS.map((preset) => {
        const isActive = activeWidth === preset.width;
        return (
          <button
            key={preset.label}
            onClick={() => onSelect(preset.width)}
            title={preset.width ? `${preset.label} (${preset.width}px)` : 'Full width'}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              fontWeight: isActive ? 600 : 400,
              background: isActive ? 'var(--nim-bg-active, #4a4a4a)' : 'transparent',
              color: isActive ? 'var(--nim-text, #e5e5e5)' : 'var(--nim-text-faint, #808080)',
              border: '1px solid',
              borderColor: isActive ? 'var(--nim-border, #4a4a4a)' : 'transparent',
              borderRadius: 4,
              cursor: 'pointer',
              whiteSpace: 'nowrap' as const,
            }}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
});
