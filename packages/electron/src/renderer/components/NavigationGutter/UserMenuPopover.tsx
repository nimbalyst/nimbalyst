import React, { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { SettingsCategory } from '../Settings/SettingsSidebar';
import type { SettingsScope } from '../Settings/SettingsView';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';
import { stytchAuthAtom } from '../../store/atoms/stytchAuth';

interface UserMenuPopoverProps {
  onNavigateSettings: (scope: SettingsScope, category?: SettingsCategory) => void;
  onClose: () => void;
  /** Whether the user has a team or mobile sync configured for this workspace */
  isProjectConnected?: boolean;
  /** The anchor element to position the popover relative to */
  anchorEl: HTMLElement | null;
}

export function UserMenuPopover({ onNavigateSettings, onClose, isProjectConnected = false, anchorEl }: UserMenuPopoverProps) {
  const authState = useAtomValue(stytchAuthAtom);

  const menu = useFloatingMenu({
    placement: 'right-end',
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  // Set the anchor element as the position reference
  useEffect(() => {
    if (anchorEl) {
      menu.refs.setReference(anchorEl);
    }
  }, [anchorEl, menu.refs]);

  const email = authState?.user?.emails?.[0]?.email;
  const isSignedIn = authState?.isAuthenticated ?? false;

  const menuItems = [
    {
      label: 'Application Settings',
      icon: 'person' as const,
      onClick: () => {
        onNavigateSettings('user');
        onClose();
      },
    },
    {
      label: 'Project Settings',
      icon: 'folder' as const,
      onClick: () => {
        onNavigateSettings('project');
        onClose();
      },
    },
    // Show Team Settings when the workspace has a team / sync connection.
    ...(isProjectConnected ? [{
      label: 'Team Settings',
      icon: 'group' as const,
      onClick: () => {
        onNavigateSettings('project', 'team');
        onClose();
      },
    }] : []),
    // Sync Settings -- always available (login and mobile sync are GA features)
    {
      label: 'Sync Settings',
      icon: 'sync' as const,
      onClick: () => {
        onNavigateSettings('user', 'sync');
        onClose();
      },
    },
  ];

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="w-56 bg-nim-secondary border border-nim rounded-lg shadow-lg z-50 overflow-hidden"
        data-testid="user-menu-popover"
      >
        {/* Navigation links */}
        <div className="py-1">
          {menuItems.map((item) => (
            <button
              key={item.label}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-nim hover:bg-nim-tertiary cursor-pointer border-none bg-transparent text-left transition-colors duration-100"
              onClick={item.onClick}
              data-testid={`user-menu-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <MaterialSymbol icon={item.icon} size={18} className="text-nim-muted shrink-0" />
              <span className="flex-1">{item.label}</span>
            </button>
          ))}
        </div>

        {/* Identity row - always shown for login and mobile sync access */}
        <div className="border-t border-nim" />
        <button
          className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-nim-tertiary cursor-pointer border-none bg-transparent text-left transition-colors duration-100"
          onClick={() => {
            onNavigateSettings('user', 'sync');
            onClose();
          }}
          data-testid="user-menu-identity"
        >
          <div className="w-7 h-7 rounded-full bg-nim-primary flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-white leading-none">
              {email ? email[0].toUpperCase() : '?'}
            </span>
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm text-nim truncate">
              {email ?? 'No account'}
            </span>
            <span className="text-xs text-nim-muted">
              {isSignedIn ? 'Signed in' : 'Not signed in'}
            </span>
          </div>
        </button>
      </div>
    </FloatingPortal>
  );
}
