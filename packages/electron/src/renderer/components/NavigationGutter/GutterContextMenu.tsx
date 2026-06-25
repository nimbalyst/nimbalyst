import React, { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';
import {
  type HideableGutterButton,
  hiddenGutterButtonsAtom,
  toggleGutterButtonHiddenAtom,
  showAllGutterButtonsAtom,
} from '../../store/atoms/projectState';

/** Human-readable labels and icons for hideable gutter buttons */
const BUTTON_META: Record<HideableGutterButton, { label: string; icon: string }> = {
  'voice-mode':     { label: 'Voice Mode',     icon: 'mic' },
  'trust-indicator': { label: 'Permissions',    icon: 'verified_user' },
  'sync-status':    { label: 'Sync Status',    icon: 'sync' },
  'theme-toggle':   { label: 'Theme Toggle',   icon: 'dark_mode' },
  'feedback':       { label: 'Feedback',       icon: 'feedback' },
  'claude-usage':   { label: 'Claude Usage',   icon: 'speed' },
  'codex-usage':    { label: 'Codex Usage',    icon: 'speed' },
  'gemini-usage':   { label: 'Gemini Usage',   icon: 'gemini' },
  'fugu-usage':     { label: 'Fugu Usage',     icon: 'speed' },
  'extension-dev':  { label: 'Extension Dev',  icon: 'extension' },
};

interface GutterContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  /** When set, show "Hide <button>" as the primary action */
  targetButton?: HideableGutterButton;
  workspacePath: string;
}

export function GutterContextMenu({ x, y, onClose, targetButton, workspacePath }: GutterContextMenuProps) {
  const hiddenButtons = useAtomValue(hiddenGutterButtonsAtom);
  const toggleHidden = useSetAtom(toggleGutterButtonHiddenAtom);
  const showAll = useSetAtom(showAllGutterButtonsAtom);

  const vRef = useMemo(() => virtualElement(x, y), [x, y]);

  const menu = useFloatingMenu({
    placement: 'right-start',
    reference: vRef,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  const hasHidden = hiddenButtons.length > 0;

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="gutter-context-menu p-1 min-w-[180px] rounded-md z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)] overflow-hidden bg-nim border border-nim"
        data-testid="gutter-context-menu"
      >
        {/* If right-clicked on a specific button, show hide option */}
        {targetButton && !hiddenButtons.includes(targetButton) && (
          <>
            <button
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-nim hover:bg-nim-tertiary cursor-pointer border-none bg-transparent text-left rounded-sm transition-colors duration-75"
              onClick={() => {
                toggleHidden({ buttonId: targetButton, workspacePath });
                onClose();
              }}
            >
              <MaterialSymbol icon="visibility_off" size={16} className="text-nim-muted" />
              <span>Hide {BUTTON_META[targetButton].label}</span>
            </button>
            {hasHidden && <div className="my-1 border-t border-nim" />}
          </>
        )}

        {/* Show hidden buttons that can be restored */}
        {hasHidden && (
          <>
            {hiddenButtons.map((id) => (
              <button
                key={id}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-nim hover:bg-nim-tertiary cursor-pointer border-none bg-transparent text-left rounded-sm transition-colors duration-75"
                onClick={() => {
                  toggleHidden({ buttonId: id, workspacePath });
                  onClose();
                }}
              >
                <MaterialSymbol icon="visibility" size={16} className="text-nim-muted" />
                <span>Show {BUTTON_META[id].label}</span>
              </button>
            ))}
            <div className="my-1 border-t border-nim" />
            <button
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-nim hover:bg-nim-tertiary cursor-pointer border-none bg-transparent text-left rounded-sm transition-colors duration-75"
              onClick={() => {
                showAll(workspacePath);
                onClose();
              }}
            >
              <MaterialSymbol icon="restart_alt" size={16} className="text-nim-muted" />
              <span>Show All</span>
            </button>
          </>
        )}

        {/* If nothing to show (no target, nothing hidden) */}
        {!targetButton && !hasHidden && (
          <div className="px-2.5 py-1.5 text-nim-muted text-center">
            Right-click buttons to hide them
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}
