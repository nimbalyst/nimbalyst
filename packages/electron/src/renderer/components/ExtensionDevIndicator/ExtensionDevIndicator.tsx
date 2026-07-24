import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { ExtensionErrorConsole } from './ExtensionErrorConsole';
import { extensionDevToolsEnabledAtom } from '../../store/atoms/appSettings';
import { HelpTooltip } from '../../help';

/**
 * Format a timestamp as a relative time string (e.g., "5m ago", "2h ago")
 */
function formatRelativeTime(startTime: number): string {
  const now = Date.now();
  const diffMs = now - startTime;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays}d ago`;
  } else if (diffHours > 0) {
    return `${diffHours}h ago`;
  } else if (diffMinutes > 0) {
    return `${diffMinutes}m ago`;
  } else {
    return 'just now';
  }
}

interface InstalledExtension {
  id: string;
  path: string;
  manifest: any;
  name: string;
  enabled: boolean;
}

interface ExtensionDevIndicatorProps {
  onOpenSettings?: () => void;
}

export const ExtensionDevIndicator: React.FC<ExtensionDevIndicatorProps> = ({
  onOpenSettings,
}) => {
  const isEnabled = useAtomValue(extensionDevToolsEnabledAtom);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rebuildSubmenuOpen, setRebuildSubmenuOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [processStartTime, setProcessStartTime] = useState<number | null>(null);
  const [relativeTime, setRelativeTime] = useState<string>('');
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [rebuildingExtension, setRebuildingExtension] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rebuildSubmenuRef = useRef<HTMLDivElement>(null);

  // Check for errors periodically
  const checkErrors = useCallback(async () => {
    if (!isEnabled) return;
    try {
      const result = await window.electronAPI.extensionDevTools.getLogs({
        logLevel: 'error',
        lastSeconds: 300, // 5 minutes
      });
      setErrorCount(result.logs.length);
    } catch (error) {
      // Ignore errors during check
    }
  }, [isEnabled]);

  useEffect(() => {
    checkErrors();
    const interval = setInterval(checkErrors, 5000);
    return () => clearInterval(interval);
  }, [checkErrors]);

  // Get process info when enabled
  useEffect(() => {
    if (!isEnabled) {
      setProcessStartTime(null);
      setRelativeTime('');
      return;
    }

    const fetchProcessInfo = async () => {
      try {
        const processInfo = await window.electronAPI.extensionDevTools.getProcessInfo();
        setProcessStartTime(processInfo.startTime);
        setRelativeTime(formatRelativeTime(processInfo.startTime));
      } catch (error) {
        console.error('[ExtensionDevIndicator] Failed to get process info:', error);
      }
    };

    fetchProcessInfo();
  }, [isEnabled]);

  // Update the relative time display every minute
  useEffect(() => {
    if (!processStartTime) return;

    const updateRelativeTime = () => {
      setRelativeTime(formatRelativeTime(processStartTime));
    };

    // Update every minute
    const interval = setInterval(updateRelativeTime, 60000);
    return () => clearInterval(interval);
  }, [processStartTime]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuOpen &&
        menuRef.current &&
        buttonRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        !buttonRef.current.contains(event.target as Node) &&
        !rebuildSubmenuRef.current?.contains(event.target as Node)
      ) {
        setMenuOpen(false);
        setRebuildSubmenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Fetch installed extensions when menu opens
  useEffect(() => {
    if (!menuOpen) {
      setRebuildSubmenuOpen(false);
      return;
    }

    const fetchExtensions = async () => {
      try {
        const installed = await window.electronAPI.extensions.listInstalled();
        // Filter to only extensions with a build script (have a path in packages/extensions)
        // and normalize to ensure we have a name
        const buildableExtensions = installed
          .filter(ext =>
            ext.path.includes('packages/extensions') || ext.path.includes('extensions/')
          )
          .map(ext => ({
            ...ext,
            // Get name from manifest if not provided directly
            name: ext.name || ext.manifest?.name || ext.id,
          }))
          .sort((a, b) => {
            const nameComparison = a.name.localeCompare(b.name, undefined, {
              sensitivity: 'base',
            });
            return nameComparison !== 0 ? nameComparison : a.id.localeCompare(b.id);
          });
        setExtensions(buildableExtensions);
      } catch (error) {
        console.error('[ExtensionDevIndicator] Failed to fetch extensions:', error);
      }
    };

    fetchExtensions();
  }, [menuOpen]);

  // Position the rebuild submenu to stay on screen
  useEffect(() => {
    if (!rebuildSubmenuOpen || !rebuildSubmenuRef.current || !menuRef.current) return;

    const submenu = rebuildSubmenuRef.current;
    const parentMenu = menuRef.current;
    const parentRect = parentMenu.getBoundingClientRect();
    const submenuWidth = 224; // w-56 = 14rem = 224px
    const gap = 4;

    // Calculate ideal position (to the right of parent menu)
    let left = parentRect.right + gap;
    let top = parentRect.top;

    // Check if submenu would go off the right edge
    if (left + submenuWidth > window.innerWidth - 16) {
      // Position to the left of parent menu instead
      left = parentRect.left - submenuWidth - gap;
    }

    // Check if submenu would go off the bottom edge
    const submenuHeight = submenu.offsetHeight;
    if (top + submenuHeight > window.innerHeight - 16) {
      // Align bottom of submenu with bottom of viewport (with padding)
      top = window.innerHeight - submenuHeight - 16;
    }

    // Ensure it doesn't go above the viewport
    if (top < 16) {
      top = 16;
    }

    submenu.style.left = `${left}px`;
    submenu.style.top = `${top}px`;
  }, [rebuildSubmenuOpen, extensions]);

  // Don't render if not enabled
  if (!isEnabled) {
    return null;
  }

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      await window.electronAPI.invoke('app:restart');
    } catch (error) {
      console.error('[ExtensionDevIndicator] Failed to restart:', error);
      setIsRestarting(false);
    }
  };

  const handleOpenSettings = () => {
    setMenuOpen(false);
    onOpenSettings?.();
  };

  const handleOpenConsole = () => {
    setMenuOpen(false);
    setConsoleOpen(true);
  };

  const handleRebuildExtension = async (extension: InstalledExtension) => {
    setRebuildingExtension(extension.id);
    try {
      const result = await window.electronAPI.extensions.devReload(extension.id, extension.path);
      if (!result.success) {
        console.error(`[ExtensionDevIndicator] Failed to rebuild ${extension.name}:`, result.error);
      }
    } catch (error) {
      console.error(`[ExtensionDevIndicator] Failed to rebuild ${extension.name}:`, error);
    } finally {
      setRebuildingExtension(null);
    }
  };

  const handleRebuildAll = async () => {
    setRebuildingExtension('all');
    try {
      for (const ext of extensions) {
        const result = await window.electronAPI.extensions.devReload(ext.id, ext.path);
        if (!result.success) {
          console.error(`[ExtensionDevIndicator] Failed to rebuild ${ext.name}:`, result.error);
        }
      }
    } catch (error) {
      console.error('[ExtensionDevIndicator] Failed to rebuild extensions:', error);
    } finally {
      setRebuildingExtension(null);
      setRebuildSubmenuOpen(false);
      setMenuOpen(false);
    }
  };

  return (
    <>
      <ExtensionErrorConsole
        isOpen={consoleOpen}
        onClose={() => {
          setConsoleOpen(false);
          checkErrors(); // Refresh error count after closing
        }}
      />
    <div className="extension-dev-indicator-container relative">
      <HelpTooltip testId="gutter-extension-dev-button" placement="right">
        <button
          ref={buttonRef}
          className="extension-dev-indicator nav-button relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 text-nim-muted hover:text-nim"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Extension Development Mode"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          data-testid="gutter-extension-dev-button"
        >
          <MaterialSymbol icon="developer_mode" size={20} />
          <span className="extension-dev-indicator-dot absolute bottom-1 right-1 w-2 h-2 rounded-full border-2 border-[var(--nim-bg-secondary)] bg-purple-500" />
        </button>
      </HelpTooltip>

      {menuOpen && (
        <div
          ref={menuRef}
          className="extension-dev-menu absolute bottom-0 left-[calc(100%+8px)] w-60 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg shadow-lg z-[100] animate-[extension-dev-menu-appear_0.15s_ease-out]"
          role="menu"
        >
          <div className="extension-dev-menu-header flex items-center justify-between pt-3 px-3 pb-2">
            <span className="extension-dev-menu-title text-[13px] font-semibold text-[var(--nim-text)]">Extension Dev Mode</span>
          </div>

          <div className="extension-dev-menu-status flex items-center gap-2 mx-3 mb-2 py-2 px-2.5 rounded-md bg-purple-500/10 border border-purple-500/30 text-xs text-[var(--nim-text-muted)] [&_.material-symbols-outlined]:text-purple-500">
            <MaterialSymbol icon="check_circle" size={16} />
            <span>Development tools active</span>
          </div>

          {relativeTime && (
            <div className="extension-dev-menu-uptime flex items-center gap-2 mx-3 mb-2 text-xs text-[var(--nim-text-faint)] [&_.material-symbols-outlined]:text-[var(--nim-text-faint)]">
              <MaterialSymbol icon="schedule" size={16} />
              <span>Started {relativeTime}</span>
            </div>
          )}

          <div className="extension-dev-menu-divider h-px bg-[var(--nim-border)] my-1" />

          <div className="extension-dev-menu-actions p-1">
            <button
              className="extension-dev-menu-action flex items-center gap-2 w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:bg-[var(--nim-bg-hover)] [&_.material-symbols-outlined]:text-[var(--nim-text-muted)]"
              onClick={handleOpenConsole}
              role="menuitem"
            >
              <MaterialSymbol icon="terminal" size={18} />
              <span>
                View Logs
                {errorCount > 0 && (
                  <span className="extension-dev-error-badge inline-flex items-center justify-center min-w-[18px] h-[18px] px-[5px] ml-2 rounded-full bg-[var(--nim-error)] text-white text-[11px] font-semibold">{errorCount}</span>
                )}
              </span>
            </button>

            {onOpenSettings && (
              <button
                className="extension-dev-menu-action flex items-center gap-2 w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:bg-[var(--nim-bg-hover)] [&_.material-symbols-outlined]:text-[var(--nim-text-muted)]"
                onClick={handleOpenSettings}
                role="menuitem"
              >
                <MaterialSymbol icon="settings" size={18} />
                <span>Extension Settings</span>
              </button>
            )}

            {/* Rebuild Extensions submenu */}
            <div className="relative">
              <button
                className="extension-dev-menu-action flex items-center justify-between w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:bg-[var(--nim-bg-hover)] [&_.material-symbols-outlined]:text-[var(--nim-text-muted)]"
                onClick={() => setRebuildSubmenuOpen(!rebuildSubmenuOpen)}
                role="menuitem"
                aria-expanded={rebuildSubmenuOpen}
                aria-haspopup="menu"
              >
                <span className="flex items-center gap-2">
                  <MaterialSymbol icon="build" size={18} />
                  <span>{rebuildingExtension ? 'Rebuilding...' : 'Rebuild Extensions'}</span>
                </span>
                <MaterialSymbol icon="chevron_right" size={18} />
              </button>

              {rebuildSubmenuOpen && (
                <div
                  ref={rebuildSubmenuRef}
                  className="fixed w-56 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg shadow-lg z-[101] animate-[extension-dev-menu-appear_0.1s_ease-out]"
                  role="menu"
                  style={{
                    // Position will be calculated by useEffect
                    maxHeight: 'calc(100vh - 32px)',
                  }}
                >
                  <div className="p-1 max-h-[calc(100vh-48px)] overflow-y-auto">
                    <button
                      className="extension-dev-menu-action flex items-center gap-2 w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:enabled:bg-[var(--nim-bg-hover)] disabled:text-[var(--nim-text-faint)] disabled:cursor-not-allowed [&_.material-symbols-outlined]:text-[var(--nim-text-muted)]"
                      onClick={handleRebuildAll}
                      disabled={rebuildingExtension !== null}
                      role="menuitem"
                    >
                      <MaterialSymbol icon="select_all" size={18} />
                      <span>{rebuildingExtension === 'all' ? 'Rebuilding all...' : 'All Extensions'}</span>
                    </button>

                    {extensions.length > 0 && (
                      <div className="h-px bg-[var(--nim-border)] my-1" />
                    )}

                    {extensions.map((ext) => (
                      <button
                        key={ext.id}
                        className="extension-dev-menu-action flex items-center gap-2 w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:enabled:bg-[var(--nim-bg-hover)] disabled:text-[var(--nim-text-faint)] disabled:cursor-not-allowed [&_.material-symbols-outlined]:text-[var(--nim-text-muted)]"
                        onClick={() => handleRebuildExtension(ext)}
                        disabled={rebuildingExtension !== null}
                        role="menuitem"
                      >
                        <MaterialSymbol icon="extension" size={18} />
                        <span className="truncate">
                          {rebuildingExtension === ext.id ? 'Rebuilding...' : ext.name}
                        </span>
                      </button>
                    ))}

                    {extensions.length === 0 && (
                      <div className="px-2 py-1 text-xs text-[var(--nim-text-faint)]">
                        No buildable extensions found
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              className="extension-dev-menu-action flex items-center gap-2 w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:enabled:bg-[var(--nim-bg-hover)] disabled:text-[var(--nim-text-faint)] disabled:cursor-not-allowed [&_.material-symbols-outlined]:text-[var(--nim-text-muted)] [&:disabled_.material-symbols-outlined]:text-[var(--nim-text-faint)]"
              onClick={handleRestart}
              disabled={isRestarting}
              role="menuitem"
            >
              <MaterialSymbol icon="refresh" size={18} />
              <span>{isRestarting ? 'Restarting...' : 'Restart Nimbalyst'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  );
};
