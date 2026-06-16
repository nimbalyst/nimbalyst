import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { permissionsChangedVersionAtom } from '../../store/atoms/permissions';

interface ProjectTrustToastProps {
  workspacePath: string | null;
  onOpenSettings?: () => void;
  /** Force the toast to show (e.g., when user wants to change permission mode) */
  forceShow?: boolean;
  /** Callback when toast is dismissed without making a choice */
  onDismiss?: () => void;
}

type TrustChoice = 'ask' | 'allow-all' | 'bypass-all';

/**
 * One-time toast that appears when an untrusted project is opened.
 * The user must choose a permission mode before the agent can operate.
 */
export const ProjectTrustToast: React.FC<ProjectTrustToastProps> = ({
  workspacePath,
  onOpenSettings,
  forceShow = false,
  onDismiss,
}) => {
  const posthog = usePostHog();
  const [isVisible, setIsVisible] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isChangingMode, setIsChangingMode] = useState(false);
  const [selectedMode, setSelectedMode] = useState<TrustChoice>('allow-all');
  const [allowAllUsesClassifier, setAllowAllUsesClassifier] = useState(false);
  const toastRef = useRef<HTMLDivElement>(null);
  const justSavedRef = useRef(false);
  const permissionChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectName = workspacePath?.split(/[\\/]/).pop() || 'this project';

  const releasePermissionChangeSuppression = useCallback(() => {
    if (permissionChangeTimeoutRef.current) {
      clearTimeout(permissionChangeTimeoutRef.current);
      permissionChangeTimeoutRef.current = null;
    }
    justSavedRef.current = false;
  }, [permissionChangeTimeoutRef, justSavedRef]);

  const suppressPermissionChangeEvents = useCallback(() => {
    releasePermissionChangeSuppression();
    justSavedRef.current = true;
    permissionChangeTimeoutRef.current = setTimeout(() => {
      justSavedRef.current = false;
      permissionChangeTimeoutRef.current = null;
    }, 500);
  }, [permissionChangeTimeoutRef, releasePermissionChangeSuppression, justSavedRef]);

  useEffect(() => {
    return () => {
      releasePermissionChangeSuppression();
    };
  }, [releasePermissionChangeSuppression]);

  // Handle forceShow prop - show toast when parent wants to change mode
  useEffect(() => {
    if (forceShow && workspacePath) {
      setIsChangingMode(true);
      setIsVisible(true);
      // Fetch current permission mode to pre-select it
      window.electronAPI.invoke('permissions:getWorkspacePermissions', workspacePath)
        .then((status) => {
          if (status.permissionMode) {
            setSelectedMode(status.permissionMode as TrustChoice);
          }
          setAllowAllUsesClassifier(status.allowAllUsesClassifier === true);
        })
        .catch((error) => {
          console.error('[ProjectTrustToast] Failed to fetch current permission mode:', error);
        });
    }
  }, [forceShow, workspacePath]);

  // Check trust status when workspace changes
  useEffect(() => {
    if (!workspacePath) {
      setIsVisible(false);
      return;
    }

    const checkTrustStatus = async () => {
      try {
        const status = await window.electronAPI.invoke('permissions:getWorkspacePermissions', workspacePath);
        console.log('[ProjectTrustToast] Trust status for', workspacePath, ':', status);
        // Show toast if workspace is not trusted yet (but not if we're in change mode)
        // Trusted = permissionMode is not null
        if (status.permissionMode === null && !isChangingMode) {
          setIsVisible(true);
        }
      } catch (error) {
        console.error('[ProjectTrustToast] Failed to check trust status:', error);
      }
    };

    checkTrustStatus();
  }, [workspacePath, isChangingMode]);

  // React to external trust changes (settings, TrustIndicator) by depending on
  // permissionsChangedVersionAtom (incremented by store/listeners/permissionListeners.ts).
  // Skip the initial mount value -- the prior useEffect handles initial fetch.
  const permissionsVersion = useAtomValue(permissionsChangedVersionAtom);
  const initialPermissionsVersionRef = useRef(permissionsVersion);
  useEffect(() => {
    if (permissionsVersion === initialPermissionsVersionRef.current) {
      return;
    }
    if (!workspacePath) return;
    if (justSavedRef.current) return;

    let cancelled = false;
    (async () => {
      try {
        const status = await window.electronAPI.invoke('permissions:getWorkspacePermissions', workspacePath);
        if (cancelled) return;
        setIsVisible(status.permissionMode === null);
      } catch (error) {
        console.error('[ProjectTrustToast] Failed to check trust status on change:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [permissionsVersion, workspacePath]);

  // Handle dismissing the toast without making a choice
  const handleDismiss = useCallback(() => {
    setIsVisible(false);
    setIsChangingMode(false);
    onDismiss?.();
  }, [onDismiss]);

  // Handle escape key to dismiss without changing settings
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleDismiss();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isVisible, handleDismiss]);


  const handleSave = useCallback(async () => {
    if (!workspacePath || isSubmitting) return;

    setIsSubmitting(true);
    // Temporarily ignore permission change broadcasts triggered by this save
    suppressPermissionChangeEvents();

    try {
      // Set the permission mode directly - this also trusts the workspace
      // (any non-null mode means trusted)
      await window.electronAPI.invoke('permissions:setPermissionMode', workspacePath, selectedMode);

      // Persist the "Allow All" classifier opt-in (issue #628). Only relevant
      // for bypass-all; for other modes force it off so a later switch to
      // Allow All doesn't inherit a stale opt-in.
      await window.electronAPI.invoke(
        'permissions:setAllowAllUsesClassifier',
        workspacePath,
        selectedMode === 'bypass-all' ? allowAllUsesClassifier : false,
      );

      // Track trust dialog completion
      posthog?.capture('trust_dialog_saved', {
        permissionMode: selectedMode,
        isChangingMode,
        allowAllUsesClassifier: selectedMode === 'bypass-all' ? allowAllUsesClassifier : false,
      });

      setIsVisible(false);
      setIsChangingMode(false);
      // Reset parent's forceShow state
      onDismiss?.();
    } catch (error) {
      console.error('[ProjectTrustToast] Failed to set trust:', error);
      // Allow future permission change events if this attempt failed
      releasePermissionChangeSuppression();
    } finally {
      setIsSubmitting(false);
    }
  }, [
    workspacePath,
    isSubmitting,
    selectedMode,
    allowAllUsesClassifier,
    onDismiss,
    posthog,
    isChangingMode,
    suppressPermissionChangeEvents,
    releasePermissionChangeSuppression,
  ]);

  const handleDontTrust = useCallback(async () => {
    if (!workspacePath || isSubmitting) return;

    const confirmed = window.confirm(
      `Stop trusting "${projectName}"?\n\nThe AI agent won't run any tools in this workspace until you trust it again.`
    );
    if (!confirmed) {
      return;
    }

    setIsSubmitting(true);
    suppressPermissionChangeEvents();
    setIsVisible(false);
    setIsChangingMode(false);
    onDismiss?.();

    try {
      await window.electronAPI.invoke('permissions:revokeWorkspaceTrust', workspacePath);
      posthog?.capture('permission_setting_changed', { action: 'revoke_trust', source: 'trust_toast' });
    } catch (error) {
      console.error('[ProjectTrustToast] Failed to revoke trust:', error);
      releasePermissionChangeSuppression();
    } finally {
      setIsSubmitting(false);
    }
  }, [
    workspacePath,
    isSubmitting,
    projectName,
    suppressPermissionChangeEvents,
    onDismiss,
    posthog,
    releasePermissionChangeSuppression,
  ]);

  const handleOpenSettings = useCallback(() => {
    setIsVisible(false);
    setIsChangingMode(false);
    onDismiss?.();
    onOpenSettings?.();
  }, [onOpenSettings, onDismiss]);

  if (!isVisible || !workspacePath) {
    return null;
  }

  return (
    <div className="project-trust-toast-overlay nim-overlay">
      <div
        className="project-trust-toast p-6 rounded-xl max-w-[540px] w-[calc(100%-32px)] bg-nim border border-nim shadow-[0_16px_48px_rgba(0,0,0,0.3)]"
        ref={toastRef}
      >
        {/* Header with Don't Trust button */}
        <div className="project-trust-toast-header flex items-start gap-4 mb-4">
          <span
            className="project-trust-toast-icon flex items-center justify-center w-12 h-12 rounded-xl shrink-0 bg-[color-mix(in_srgb,var(--nim-primary)_15%,transparent)] text-nim-primary"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <div className="project-trust-toast-header-text flex-1">
            <h2
              className="project-trust-toast-title text-lg font-semibold m-0 mb-1 text-nim"
            >
              Trust "{projectName}"?
            </h2>
            <p
              className="project-trust-toast-subtitle text-sm m-0 text-nim-muted"
            >
              This project wants to use the AI agent
            </p>
          </div>
          <button
            className="project-trust-toast-dont-trust text-[13px] font-medium px-3 py-1.5 rounded-md cursor-pointer shrink-0 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed bg-transparent border border-nim text-nim-muted"
            onClick={handleDontTrust}
            disabled={isSubmitting}
          >
            Don't Trust
          </button>
        </div>

        {/* Warning */}
        <div
          className="project-trust-toast-warning flex items-start gap-2.5 p-3 rounded-lg mb-4 text-[13px] leading-relaxed bg-[color-mix(in_srgb,#f59e0b_10%,transparent)] border border-[color-mix(in_srgb,#f59e0b_30%,transparent)] text-nim-muted"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="shrink-0 mt-px text-[#f59e0b]"
          >
            <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
          <span>
            Untrusted projects can contain malicious code. Only trust projects from sources you know.
          </span>
        </div>

        {/* Description */}
        <p
          className="project-trust-toast-description text-sm m-0 mb-3 text-nim-muted"
        >
          Choose how the agent handles tool calls in this project:
        </p>

        {/* Mode Toggle Buttons */}
        <div className="project-trust-toast-mode-toggle flex gap-2 mb-4">
          <button
            className={`project-trust-toast-mode-btn flex-1 grid grid-rows-[1fr_auto] items-center justify-items-center px-4 pt-3 pb-2 min-h-16 rounded-lg cursor-pointer transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed ${
              selectedMode === 'ask'
                ? 'project-trust-toast-mode-btn--selected border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)]'
                : 'border border-nim bg-nim-secondary'
            }`}
            onClick={() => setSelectedMode('ask')}
            disabled={isSubmitting}
          >
            <span
              className="project-trust-toast-mode-label text-sm font-semibold text-nim"
            >
              Ask
            </span>
          </button>
          <button
            className={`project-trust-toast-mode-btn flex-1 grid grid-rows-[1fr_auto] items-center justify-items-center px-4 pt-3 pb-2 min-h-16 rounded-lg cursor-pointer transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed ${
              selectedMode === 'allow-all'
                ? 'project-trust-toast-mode-btn--selected border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)]'
                : 'border border-nim bg-nim-secondary'
            }`}
            onClick={() => setSelectedMode('allow-all')}
            disabled={isSubmitting}
          >
            <span
              className="project-trust-toast-mode-label text-sm font-semibold text-nim"
            >
              Allow Edits
            </span>
            <span
              className="project-trust-toast-mode-badge text-[11px] font-medium px-2 py-0.5 rounded whitespace-nowrap row-start-2 bg-[color-mix(in_srgb,var(--nim-primary)_15%,transparent)] text-nim-primary"
            >
              Recommended
            </span>
          </button>
          <button
            className={`project-trust-toast-mode-btn flex-1 grid grid-rows-[1fr_auto] items-center justify-items-center px-4 pt-3 pb-2 min-h-16 rounded-lg cursor-pointer transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed ${
              selectedMode === 'bypass-all'
                ? 'project-trust-toast-mode-btn--selected border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)]'
                : 'border border-nim bg-nim-secondary'
            }`}
            onClick={() => setSelectedMode('bypass-all')}
            disabled={isSubmitting}
          >
            <span
              className="project-trust-toast-mode-label text-sm font-semibold text-nim"
            >
              Allow All
            </span>
          </button>
        </div>

        {/* Mode Details */}
        <div
          className="project-trust-toast-mode-details rounded-lg p-4 mb-4 bg-nim-secondary"
        >
          {selectedMode === 'ask' ? (
            <>
              <p
                className="project-trust-toast-mode-summary text-[13px] m-0 mb-3 leading-normal text-nim-muted"
              >
                The agent will ask for permission before running commands. When you approve, your choices are saved to <code>.claude/settings.local.json</code> for future sessions.
              </p>
              <ul className="project-trust-toast-features-list list-none m-0 p-0 flex flex-col gap-2">
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-nim-primary"
                  >
                    <path d="M13.5 4.5l-7 7-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span><strong className="font-medium text-nim">Approve once</strong> or <strong className="font-medium text-nim">always</strong> for each tool pattern</span>
                </li>
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-nim-primary"
                  >
                    <path d="M13.5 4.5l-7 7-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span><strong className="font-medium text-nim">Fine-grained control</strong> - allow "npm test" but block "rm -rf"</span>
                </li>
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-nim-primary"
                  >
                    <path d="M13.5 4.5l-7 7-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span><strong className="font-medium text-nim">Permissions shared</strong> with Claude Code CLI in this project</span>
                </li>
              </ul>
            </>
          ) : selectedMode === 'allow-all' ? (
            <>
              <p
                className="project-trust-toast-mode-summary text-[13px] m-0 mb-3 leading-normal text-[#f59e0b]"
              >
                The agent will run all file and edit operations without asking. Shell commands and web requests may still require approval.
              </p>
              <ul className="project-trust-toast-features-list list-none m-0 p-0 flex flex-col gap-2">
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-[#f59e0b]"
                  >
                    <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span>All file read/write/edit operations are automatically approved</span>
                </li>
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-[#f59e0b]"
                  >
                    <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span>Bash commands and web fetches follow Claude Code's settings</span>
                </li>
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-[#f59e0b]"
                  >
                    <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span>Only use with projects you fully trust</span>
                </li>
              </ul>
            </>
          ) : (
            <>
              <p
                className="project-trust-toast-mode-summary text-[13px] m-0 mb-3 leading-normal text-[#f59e0b]"
              >
                The agent will run all operations without permission prompts, including shell commands, file operations, and web requests.
              </p>
              <ul className="project-trust-toast-features-list list-none m-0 p-0 flex flex-col gap-2">
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-[#f59e0b]"
                  >
                    <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span>All tool calls are automatically approved</span>
                </li>
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-[#f59e0b]"
                  >
                    <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span>Uses Nimbalyst permissions instead of Claude Code settings</span>
                </li>
                <li
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-nim-muted"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 mt-0.5 text-[#f59e0b]"
                  >
                    <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span>Best for development and testing workflows</span>
                </li>
              </ul>
              <label className="project-trust-toast-classifier-toggle flex items-start gap-2 mt-3 pt-3 border-t border-nim cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowAllUsesClassifier}
                  onChange={(e) => setAllowAllUsesClassifier(e.target.checked)}
                  disabled={isSubmitting}
                  className="mt-0.5"
                />
                <span className="text-[13px] leading-relaxed text-nim-muted">
                  <strong className="font-medium text-nim">Run an AI safety classifier (Claude Code)</strong> — review risky operations like deploys and prompt for confirmation instead of running them silently.
                </span>
              </label>
            </>
          )}
        </div>

        {/* Footer with Save/Cancel buttons */}
        <div className="project-trust-toast-footer flex items-center justify-between">
          <button
            className="project-trust-toast-settings-link text-[13px] p-1 px-2 rounded cursor-pointer transition-colors duration-150 hover:underline bg-transparent border-none text-nim-faint"
            onClick={handleOpenSettings}
          >
            Advanced settings
          </button>
          <div className="project-trust-toast-actions flex gap-2">
            <button
              className="project-trust-toast-cancel text-sm font-medium px-4 py-2 rounded-md cursor-pointer transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed bg-transparent border border-nim text-nim-muted"
              onClick={handleDismiss}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              className="project-trust-toast-save text-sm font-medium px-4 py-2 rounded-md cursor-pointer transition-all duration-150 disabled:opacity-70 disabled:cursor-not-allowed hover:brightness-110 bg-nim-primary border-none text-nim-on-primary"
              onClick={handleSave}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
