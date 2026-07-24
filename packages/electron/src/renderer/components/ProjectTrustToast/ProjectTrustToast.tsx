import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { permissionsChangedVersionAtom } from '../../store/atoms/permissions';
import {
  DEFAULT_PROJECT_TRUST_CHOICE,
  PROJECT_TRUST_CHOICE_DESCRIPTIONS,
  PROJECT_TRUST_CHOICE_LABELS,
  getProjectTrustChoice,
  persistProjectTrustChoice,
  type ProjectTrustChoice,
} from './projectTrustChoices';

interface ProjectTrustToastProps {
  workspacePath: string | null;
  onOpenSettings?: () => void;
  /** Force the toast to show (e.g., when user wants to change permission mode) */
  forceShow?: boolean;
  /** Callback when toast is dismissed without making a choice */
  onDismiss?: () => void;
}

const PROJECT_TRUST_CHOICES: ProjectTrustChoice[] = [
  'agent-verified',
  'allow-everything',
  'allow-edits-only',
  'ask-every-time',
];

/**
 * One-time dialog that appears when an untrusted project is opened.
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
  const [selectedChoice, setSelectedChoice] = useState<ProjectTrustChoice>(
    DEFAULT_PROJECT_TRUST_CHOICE
  );
  const toastRef = useRef<HTMLDivElement>(null);
  const justSavedRef = useRef(false);
  const permissionChangeTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
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
  }, [
    permissionChangeTimeoutRef,
    releasePermissionChangeSuppression,
    justSavedRef,
  ]);

  useEffect(() => {
    return () => {
      releasePermissionChangeSuppression();
    };
  }, [releasePermissionChangeSuppression]);

  // Handle forceShow prop - show the dialog when the user wants to change mode.
  useEffect(() => {
    if (forceShow && workspacePath) {
      setIsChangingMode(true);
      setIsVisible(true);
      window.electronAPI
        .invoke('permissions:getWorkspacePermissions', workspacePath)
        .then((status) => {
          if (status.permissionMode) {
            setSelectedChoice(
              getProjectTrustChoice(
                status.permissionMode,
                status.allowAllUsesClassifier === true
              )
            );
          }
        })
        .catch((error) => {
          console.error(
            '[ProjectTrustToast] Failed to fetch current permission mode:',
            error
          );
        });
    }
  }, [forceShow, workspacePath]);

  // Check trust status when the workspace changes.
  useEffect(() => {
    if (!workspacePath) {
      setIsVisible(false);
      return;
    }

    const checkTrustStatus = async () => {
      try {
        const status = await window.electronAPI.invoke(
          'permissions:getWorkspacePermissions',
          workspacePath
        );
        console.log(
          '[ProjectTrustToast] Trust status for',
          workspacePath,
          ':',
          status
        );
        if (status.permissionMode === null && !isChangingMode) {
          setSelectedChoice(DEFAULT_PROJECT_TRUST_CHOICE);
          setIsVisible(true);
        }
      } catch (error) {
        console.error(
          '[ProjectTrustToast] Failed to check trust status:',
          error
        );
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
        const status = await window.electronAPI.invoke(
          'permissions:getWorkspacePermissions',
          workspacePath
        );
        if (cancelled) return;
        setIsVisible(status.permissionMode === null);
      } catch (error) {
        console.error(
          '[ProjectTrustToast] Failed to check trust status on change:',
          error
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [permissionsVersion, workspacePath]);

  const handleDismiss = useCallback(() => {
    setIsVisible(false);
    setIsChangingMode(false);
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
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
    suppressPermissionChangeEvents();

    try {
      const settings = await persistProjectTrustChoice(
        (channel, path, value) =>
          window.electronAPI.invoke(channel, path, value),
        workspacePath,
        selectedChoice
      );

      posthog?.capture('trust_dialog_saved', {
        permissionMode: settings.permissionMode,
        isChangingMode,
        allowAllUsesClassifier: settings.allowAllUsesClassifier,
      });

      setIsVisible(false);
      setIsChangingMode(false);
      onDismiss?.();
    } catch (error) {
      console.error('[ProjectTrustToast] Failed to set trust:', error);
      releasePermissionChangeSuppression();
    } finally {
      setIsSubmitting(false);
    }
  }, [
    workspacePath,
    isSubmitting,
    selectedChoice,
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
      await window.electronAPI.invoke(
        'permissions:revokeWorkspaceTrust',
        workspacePath
      );
      posthog?.capture('permission_setting_changed', {
        action: 'revoke_trust',
        source: 'trust_toast',
      });
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
        className="project-trust-toast w-[calc(100%_-_32px)] max-w-[520px] rounded-xl border border-nim bg-nim p-6 shadow-[0_16px_48px_rgba(0,0,0,0.3)]"
        ref={toastRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-toast-title"
        aria-describedby="project-trust-toast-subtitle"
        data-component="ProjectTrustToast"
        data-source="packages/electron/src/renderer/components/ProjectTrustToast/ProjectTrustToast.tsx"
      >
        <div className="project-trust-toast-header mb-5 flex items-start gap-3.5">
          <span className="project-trust-toast-icon flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] bg-[color-mix(in_srgb,var(--nim-primary)_15%,transparent)] text-nim-primary">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M9 12l2 2 4-4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="project-trust-toast-header-text min-w-0 flex-1">
            <h2
              id="project-trust-toast-title"
              className="project-trust-toast-title m-0 mb-[3px] text-[17px] font-semibold text-nim"
            >
              Set up agents for "{projectName}"
            </h2>
            <p
              id="project-trust-toast-subtitle"
              className="project-trust-toast-subtitle m-0 text-[13px] leading-[1.45] text-nim-muted"
            >
              Choose how much your coding agents can do on their own. You can
              change this anytime.
            </p>
          </div>
        </div>

        <div className="project-trust-toast-options mb-4 flex flex-col gap-2">
          {PROJECT_TRUST_CHOICES.map((choice) => {
            const isSelected = selectedChoice === choice;
            const isSecondaryChoice =
              choice === 'allow-edits-only' || choice === 'ask-every-time';

            return (
              <label
                key={choice}
                className={`project-trust-toast-option flex cursor-pointer items-start rounded-[10px] border transition-colors duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--nim-primary)] ${
                  isSecondaryChoice
                    ? 'project-trust-toast-option--secondary gap-2.5 px-3.5 py-2'
                    : 'gap-3 px-3.5 py-3'
                } ${
                  isSelected
                    ? 'project-trust-toast-option--selected border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_8%,transparent)]'
                    : isSecondaryChoice
                    ? 'border-transparent bg-transparent hover:bg-nim-hover'
                    : 'border-nim bg-nim-secondary hover:bg-nim-hover'
                } ${isSubmitting ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name="projectTrustChoice"
                  value={choice}
                  checked={isSelected}
                  onChange={() => setSelectedChoice(choice)}
                  disabled={isSubmitting}
                  className="sr-only"
                />
                <span
                  className={`project-trust-toast-radio mt-px flex shrink-0 items-center justify-center rounded-full border-2 ${
                    isSecondaryChoice ? 'h-4 w-4' : 'h-[18px] w-[18px]'
                  } ${
                    isSelected
                      ? 'border-[var(--nim-primary)]'
                      : 'border-[var(--nim-text-faint)]'
                  }`}
                  aria-hidden="true"
                >
                  {isSelected && (
                    <span
                      className={`project-trust-toast-radio-dot rounded-full bg-nim-primary ${
                        isSecondaryChoice ? 'h-2 w-2' : 'h-2.5 w-2.5'
                      }`}
                    />
                  )}
                </span>
                <span className="project-trust-toast-option-body min-w-0 flex-1">
                  <span className="project-trust-toast-option-title-row mb-0.5 flex items-center gap-2">
                    <span
                      className={`project-trust-toast-option-title ${
                        isSecondaryChoice
                          ? `text-[13px] font-medium ${
                              isSelected ? 'text-nim' : 'text-nim-muted'
                            }`
                          : 'text-sm font-semibold text-nim'
                      }`}
                    >
                      {PROJECT_TRUST_CHOICE_LABELS[choice]}
                    </span>
                    {choice === 'agent-verified' && (
                      <span className="project-trust-toast-option-badge rounded-full bg-[color-mix(in_srgb,var(--nim-success)_15%,transparent)] px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.02em] text-nim-success">
                        Recommended
                      </span>
                    )}
                  </span>
                  <span
                    className={`project-trust-toast-option-description block leading-[1.45] ${
                      isSecondaryChoice
                        ? `text-[11.5px] ${
                            isSelected ? 'text-nim-muted' : 'text-nim-faint'
                          }`
                        : 'text-[12.5px] text-nim-muted'
                    }`}
                  >
                    {choice === 'agent-verified' ? (
                      <>
                        Works without interrupting you;{' '}
                        <strong className="font-medium text-nim">
                          risky actions
                        </strong>{' '}
                        like deploys and destructive commands{' '}
                        <strong className="font-medium text-nim">
                          pause for your OK
                        </strong>
                        .
                      </>
                    ) : (
                      PROJECT_TRUST_CHOICE_DESCRIPTIONS[choice]
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="project-trust-toast-footnote mb-5 flex items-start gap-2 px-0.5 text-xs leading-[1.5] text-nim-faint">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="project-trust-toast-footnote-icon mt-0.5 shrink-0"
            aria-hidden="true"
          >
            <path
              d="M8 5.5v3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M8 11h.01"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          <span>
            Agents can run this project's code. If you don't recognize where
            this project came from,{' '}
            <button
              type="button"
              className="project-trust-toast-revoke-link cursor-pointer border-none bg-transparent p-0 font-inherit text-nim-muted underline disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleDontTrust}
              disabled={isSubmitting}
            >
              don't trust it
            </button>
            .
          </span>
        </div>

        <div className="project-trust-toast-footer flex items-center justify-between">
          <button
            type="button"
            className="project-trust-toast-settings-link cursor-pointer rounded border-none bg-transparent px-0.5 py-1 text-[13px] text-nim-faint transition-colors duration-150 hover:underline"
            onClick={handleOpenSettings}
          >
            Advanced settings
          </button>
          <div className="project-trust-toast-actions flex gap-2">
            <button
              type="button"
              className="project-trust-toast-not-now cursor-pointer rounded-[7px] border border-nim bg-transparent px-4 py-2 text-[13.5px] font-medium text-nim-muted transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleDismiss}
              disabled={isSubmitting}
            >
              Not now
            </button>
            <button
              type="button"
              className="project-trust-toast-start-working cursor-pointer rounded-[7px] border-none bg-nim-primary px-4 py-2 text-[13.5px] font-medium text-nim-on-primary transition-all duration-150 hover:bg-nim-primary-hover disabled:cursor-not-allowed disabled:opacity-70"
              onClick={handleSave}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : 'Start working'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
