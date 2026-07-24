import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { themeIdAtom } from '@nimbalyst/runtime/store';
import {
  getAllAvailableThemesAsync,
} from '../../hooks/useTheme';
import { themeListChangedVersionAtom } from '../../store/atoms/themeList';
import { HelpTooltip } from '../../help';

type BuiltInTheme = 'light' | 'dark';

interface ThemeToggleButtonProps {
  className?: string;
}

export const ThemeToggleButton: React.FC<ThemeToggleButtonProps> = ({ className = '' }) => {
  // Theme state lives in themeIdAtom; updated by store/listeners/themeListeners.ts
  const currentTheme = useAtomValue(themeIdAtom) as string;

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [availableThemes, setAvailableThemes] = useState<Array<{
    id: string;
    name: string;
    isDark: boolean;
  }>>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Load available themes; refresh when extensions register/unregister
  // themes. The IPC event is handled centrally in
  // store/listeners/themeListeners.ts and surfaced via
  // themeListChangedVersionAtom -- using it as a dep re-runs this effect on
  // every bump.
  const themeListVersion = useAtomValue(themeListChangedVersionAtom);
  useEffect(() => {
    let cancelled = false;
    const loadThemes = async () => {
      const themes = await getAllAvailableThemesAsync();
      if (!cancelled) setAvailableThemes(themes);
    };

    loadThemes();

    return () => {
      cancelled = true;
    };
  }, [themeListVersion]);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  const selectTheme = useCallback((themeId: string) => {
    setIsMenuOpen(false);

    // Find the theme to get its isDark property
    const theme = availableThemes.find(t => t.id === themeId);
    const isDark = theme?.isDark ?? false;

    // Send theme change to main process for persistence and cross-window sync.
    // Main process broadcasts back via theme-change, picked up by themeListeners,
    // which updates themeIdAtom and re-renders this component.
    if (window.electronAPI?.send) {
      window.electronAPI.send('set-theme', themeId, isDark);
    }
  }, [availableThemes]);

  const getThemeIcon = (themeId: string, isDark: boolean): string => {
    switch (themeId) {
      case 'light':
        return 'light_mode';
      case 'dark':
        return 'dark_mode';
      case 'crystal-dark':
        return 'bedtime';
      default:
        return 'palette';
    }
  };

  const getCurrentThemeIcon = (): string => {
    const theme = availableThemes.find(t => t.id === currentTheme);
    if (theme) {
      return getThemeIcon(theme.id, theme.isDark);
    }
    // Fallback for built-in themes
    switch (currentTheme) {
      case 'light':
        return 'light_mode';
      case 'dark':
        return 'dark_mode';
      case 'crystal-dark':
        return 'bedtime';
      default:
        return 'light_mode';
    }
  };

  return (
    <div className="relative">
      <HelpTooltip testId="gutter-theme-button" placement="right">
        <button
          ref={buttonRef}
          className={`theme-toggle-button nav-button relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md text-nim-muted cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary hover:text-nim active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${className}`}
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          aria-label="Change theme"
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          data-testid="gutter-theme-button"
        >
          <MaterialSymbol icon="palette" size={20} />
        </button>
      </HelpTooltip>

      {isMenuOpen && (
        <div
          ref={menuRef}
          className="theme-menu absolute bottom-0 left-full ml-2 bg-nim-secondary border border-nim rounded-md p-1 min-w-[200px] shadow-lg z-[1000]"
          role="menu"
          aria-label="Theme selection"
        >
          {availableThemes.map(theme => (
            <button
              key={theme.id}
              className="theme-menu-item flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-nim text-[13px] text-left cursor-pointer rounded transition-colors duration-100 hover:bg-nim-hover"
              onClick={() => selectTheme(theme.id)}
              role="menuitem"
            >
              <span className="theme-icon w-5 flex justify-center flex-shrink-0">
                <MaterialSymbol icon={getThemeIcon(theme.id, theme.isDark)} size={18} />
              </span>
              <span className="theme-name flex-1 whitespace-nowrap">{theme.name}</span>
              {currentTheme === theme.id && (
                <span className="theme-check w-4 flex justify-center flex-shrink-0">
                  <MaterialSymbol icon="check" size={16} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
