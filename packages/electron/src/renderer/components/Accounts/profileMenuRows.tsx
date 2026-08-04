import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

/**
 * Row grammar for the bottom-left profile menus.
 *
 * Both windows put a profile button in the bottom-left corner and open a menu
 * built from the same rows: settings shortcuts, then the organization, then the
 * account. The class string and the row shape live here so the two menus cannot
 * drift apart (NIM-2322).
 *
 * `AccountInspectorPopover` still carries its own copy of this row; adopting
 * these helpers there is a follow-up, deliberately kept out of the wave that
 * converged the org window's menu so the project window's popover is untouched.
 */
export const PROFILE_MENU_ROW_CLASS =
  'profile-menu-row flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--nim-bg-hover)]';

export function ProfileMenuDivider() {
  return <div className="profile-menu-divider border-t border-[var(--nim-border)]" />;
}

/**
 * A settings-style row: icon, label, and — for rows that drill into another
 * surface — a chevron. Toggles pass `chevron={false}`; the chevron is the
 * menu's promise that something else opens.
 */
export function ProfileMenuRow({
  icon,
  label,
  testId,
  onClick,
  chevron = true,
  className = '',
}: {
  icon: string;
  label: string;
  testId: string;
  onClick: () => void;
  chevron?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`${PROFILE_MENU_ROW_CLASS} ${className}`.trim()}
      data-testid={testId}
      onClick={onClick}
    >
      <MaterialSymbol icon={icon} size={20} className="shrink-0 text-[var(--nim-text-muted)]" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {chevron && (
        <MaterialSymbol icon="chevron_right" size={18} className="text-[var(--nim-text-faint)]" />
      )}
    </button>
  );
}

/** The two-letter organization chip used by the organization row in both menus. */
export function ProfileMenuOrgChip({ name }: { name: string }) {
  return (
    <span className="profile-menu-org-chip flex h-6 w-6 shrink-0 items-center justify-center rounded bg-gradient-to-br from-[#60a5fa] to-[#a78bfa] text-[10px] font-semibold text-white">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
