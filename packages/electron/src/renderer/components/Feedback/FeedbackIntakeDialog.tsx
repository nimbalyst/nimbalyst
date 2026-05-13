import React, { useCallback, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '@nimbalyst/runtime';

export type FeedbackKind = 'bug' | 'feature';

export interface FeedbackDraftOptions {
  mayGatherLogs?: boolean;
  shouldCreateMockup?: boolean;
}

export interface FeedbackIntakeLaunchOptions {
  kind: FeedbackKind;
  mayGatherLogs?: boolean;
  shouldCreateMockup?: boolean;
}

export interface FeedbackIntakeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLaunch: (options: FeedbackIntakeLaunchOptions) => void;
}

const ISSUES_URL = 'https://github.com/nimbalyst/nimbalyst/issues';
const DISCUSSIONS_URL = 'https://github.com/nimbalyst/nimbalyst/discussions';
const SUPPORT_EMAIL_URL = 'mailto:support@nimbalyst.com';

export const FeedbackIntakeDialog: React.FC<FeedbackIntakeDialogProps> = ({
  isOpen,
  onClose,
  onLaunch,
}) => {
  const posthog = usePostHog();
  const [selectedKind, setSelectedKind] = useState<FeedbackKind | null>(null);
  const [mayGatherLogs, setMayGatherLogs] = useState(true);
  const [shouldCreateMockup, setShouldCreateMockup] = useState(false);

  const handleLaunch = useCallback(() => {
    if (!selectedKind) return;

    const launchOptions =
      selectedKind === 'bug'
        ? { kind: selectedKind, mayGatherLogs }
        : { kind: selectedKind, shouldCreateMockup };

    posthog?.capture('feedback_intake_launched', launchOptions);
    onLaunch(launchOptions);
    onClose();
  }, [mayGatherLogs, onClose, onLaunch, posthog, selectedKind, shouldCreateMockup]);

  const handleSelectKind = useCallback(
    (kind: FeedbackKind) => {
      setSelectedKind(kind);
      const launchOptions =
        kind === 'bug'
          ? { kind, mayGatherLogs }
          : { kind, shouldCreateMockup };

      posthog?.capture('feedback_intake_type_selected', launchOptions);
    },
    [mayGatherLogs, posthog, shouldCreateMockup],
  );

  const handleOpenExternal = useCallback(
    (url: string, target: 'issues' | 'discussions' | 'email') => {
      posthog?.capture('feedback_external_link_clicked', { target });
      window.electronAPI?.invoke('open-external', url);
      onClose();
    },
    [posthog, onClose],
  );

  if (!isOpen) return null;

  return (
    <div
      className="feedback-intake-overlay nim-overlay nim-animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="feedback-intake-overlay"
    >
      <div
        className="feedback-intake-dialog nim-animate-slide-up relative max-h-[90vh] w-[520px] max-w-[90vw] overflow-y-auto rounded-2xl border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="feedback-intake-title"
        data-testid="feedback-intake-dialog"
      >
        <button
          type="button"
          className="absolute top-3.5 right-3.5 z-[1] flex h-8 w-8 items-center justify-center rounded-md border-none bg-transparent text-[var(--nim-text-muted)] transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
          onClick={onClose}
          aria-label="Close"
          data-testid="feedback-intake-close"
        >
          <MaterialSymbol icon="close" size={20} />
        </button>

        <div className="px-6 pt-6 pb-6">
          <div className="feedback-intake-hero mb-5 overflow-hidden rounded-[24px] border border-[var(--nim-border)] bg-[linear-gradient(135deg,rgba(56,189,248,0.10),rgba(251,191,36,0.08),rgba(255,255,255,0.02))] px-6 py-5">
            <h2
              id="feedback-intake-title"
              className="m-0 text-[24px] font-semibold leading-[1.1] text-[var(--nim-text)]"
            >
              Send better feedback with your Agent
            </h2>
            <p className="mt-2 max-w-[42ch] text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
              Use your Agent to improve your bug reports and feature requests. Your agent will help draft it, and you
              approve everything before GitHub opens.
            </p>
          </div>

          <div className="feedback-intake-options flex flex-col gap-4">
            <div className="feedback-intake-kind-grid grid grid-cols-2 gap-3">
              <button
                type="button"
                className={`feedback-intake-kind-card rounded-[18px] border px-4 py-3 text-left transition-all duration-150 ${
                  selectedKind === 'bug'
                    ? 'border-[var(--nim-primary)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]'
                    : 'border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text-muted)] hover:border-[var(--nim-primary)] hover:bg-[var(--nim-bg-secondary)] hover:text-[var(--nim-text)]'
                }`}
                onClick={() => handleSelectKind('bug')}
                data-testid="feedback-intake-select-bug"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[rgba(239,68,68,0.12)] text-[var(--nim-error)]">
                    <MaterialSymbol icon="bug_report" size={20} />
                  </span>
                  <span className="text-[14px] font-semibold leading-none">Bug report</span>
                </div>
                <p className="m-0 text-[12px] leading-relaxed">
                  Broken behavior, crashes, sync issues, or regressions.
                </p>
              </button>

              <button
                type="button"
                className={`feedback-intake-kind-card rounded-[18px] border px-4 py-3 text-left transition-all duration-150 ${
                  selectedKind === 'feature'
                    ? 'border-[var(--nim-primary)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]'
                    : 'border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text-muted)] hover:border-[var(--nim-primary)] hover:bg-[var(--nim-bg-secondary)] hover:text-[var(--nim-text)]'
                }`}
                onClick={() => handleSelectKind('feature')}
                data-testid="feedback-intake-select-feature"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[rgba(245,158,11,0.14)] text-[var(--nim-warning)]">
                    <MaterialSymbol icon="lightbulb" size={20} />
                  </span>
                  <span className="text-[14px] font-semibold leading-none">Feature request</span>
                </div>
                <p className="m-0 text-[12px] leading-relaxed">
                  Missing capabilities, workflow improvements, or UX changes.
                </p>
              </button>
            </div>

            {selectedKind ? (
              <div className="feedback-intake-detail rounded-[20px] border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-4 py-4">
                {selectedKind === 'bug' ? (
                  <label
                    htmlFor="feedback-may-gather-logs"
                    className="block cursor-pointer rounded-2xl border border-[var(--nim-border)] bg-[var(--nim-bg)] px-4 py-3 transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)]"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        id="feedback-may-gather-logs"
                        type="checkbox"
                        checked={mayGatherLogs}
                        onChange={(e) => setMayGatherLogs(e.target.checked)}
                        className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer appearance-none rounded border-2 border-[var(--nim-border)] bg-[var(--nim-bg)] checked:border-[var(--nim-primary)] checked:bg-[var(--nim-primary)] checked:bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27white%27%3E%3Cpath%20d=%27M9%2016.17L4.83%2012l-1.42%201.41L9%2019%2021%207l-1.41-1.41L9%2016.17z%27/%3E%3C/svg%3E')] checked:bg-[length:14px] checked:bg-center checked:bg-no-repeat"
                        data-testid="feedback-intake-consent"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="m-0 text-[13px] font-medium leading-snug text-[var(--nim-text)]">
                          Include logs and environment details
                        </p>
                        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                          Logs may include file paths, workspace names, and error details. The
                          assistant anonymizes them first, and you review the final report before it
                          is posted.
                        </p>
                      </div>
                    </div>
                  </label>
                ) : null}

                {selectedKind === 'feature' ? (
                  <label
                    htmlFor="feedback-should-create-mockup"
                    className="block cursor-pointer rounded-2xl border border-[var(--nim-border)] bg-[var(--nim-bg)] px-4 py-3 transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)]"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        id="feedback-should-create-mockup"
                        type="checkbox"
                        checked={shouldCreateMockup}
                        onChange={(e) => setShouldCreateMockup(e.target.checked)}
                        className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer appearance-none rounded border-2 border-[var(--nim-border)] bg-[var(--nim-bg)] checked:border-[var(--nim-primary)] checked:bg-[var(--nim-primary)] checked:bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27white%27%3E%3Cpath%20d=%27M9%2016.17L4.83%2012l-1.42%201.41L9%2019%2021%207l-1.41-1.41L9%2016.17z%27/%3E%3C/svg%3E')] checked:bg-[length:14px] checked:bg-center checked:bg-no-repeat"
                        data-testid="feedback-intake-mockup"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="m-0 text-[13px] font-medium leading-snug text-[var(--nim-text)]">
                          Explore the idea with a UX mockup first
                        </p>
                        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                          Best for interface or workflow changes. The assistant can sketch a mockup,
                          refine it with you, and include that visual direction in the request.
                        </p>
                      </div>
                    </div>
                  </label>
                ) : null}
              </div>
            ) : null}

            <button
              type="button"
              className={`feedback-intake-start-button flex w-full items-center justify-between rounded-[18px] px-4 py-3 text-left text-[13px] font-semibold transition-all duration-150 ${
                selectedKind
                  ? 'border border-[var(--nim-primary)] bg-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)]'
                  : 'border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text-disabled)]'
              }`}
              onClick={handleLaunch}
              disabled={!selectedKind}
              data-testid="feedback-intake-start"
            >
              <span>
                {selectedKind === 'bug'
                  ? 'Start bug report'
                  : selectedKind === 'feature'
                    ? 'Start feature request'
                    : 'Choose a type to continue'}
              </span>
              <MaterialSymbol
                icon="arrow_forward"
                size={18}
                className={selectedKind ? 'text-white' : 'text-[var(--nim-text-faint)]'}
              />
            </button>
          </div>
        </div>

        <div className="border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-8 pt-4 pb-4.5">
          <p className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-faint)]">
            Other ways to reach us
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            <li>
              <button
                type="button"
                className="group -ml-1.5 inline-flex cursor-pointer items-center gap-2 rounded-md bg-transparent px-1.5 py-1 text-[13px] text-[var(--nim-text-muted)] transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
                onClick={() => handleOpenExternal(ISSUES_URL, 'issues')}
                data-testid="feedback-intake-issues-link"
              >
                <MaterialSymbol
                  icon="search"
                  size={16}
                  className="text-[var(--nim-text-faint)] group-hover:text-[var(--nim-primary)]"
                />
                Browse existing issues on GitHub
              </button>
            </li>
            <li>
              <button
                type="button"
                className="group -ml-1.5 inline-flex cursor-pointer items-center gap-2 rounded-md bg-transparent px-1.5 py-1 text-[13px] text-[var(--nim-text-muted)] transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
                onClick={() => handleOpenExternal(DISCUSSIONS_URL, 'discussions')}
                data-testid="feedback-intake-discussions-link"
              >
                <MaterialSymbol
                  icon="forum"
                  size={16}
                  className="text-[var(--nim-text-faint)] group-hover:text-[var(--nim-primary)]"
                />
                Discuss an idea on GitHub Discussions
              </button>
            </li>
            <li>
              <button
                type="button"
                className="group -ml-1.5 inline-flex cursor-pointer items-center gap-2 rounded-md bg-transparent px-1.5 py-1 text-[13px] text-[var(--nim-text-muted)] transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
                onClick={() => handleOpenExternal(SUPPORT_EMAIL_URL, 'email')}
                data-testid="feedback-intake-email-link"
              >
                <MaterialSymbol
                  icon="mail"
                  size={16}
                  className="text-[var(--nim-text-faint)] group-hover:text-[var(--nim-primary)]"
                />
                Email private feedback to support@nimbalyst.com
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export function buildFeedbackInitialDraft(
  kind: FeedbackKind,
  options: FeedbackDraftOptions = {},
): string {
  const command =
    kind === 'bug'
      ? '/feedback:bug-report'
      : '/feedback:feature-request';

  if (kind === 'bug') {
    const consent = options.mayGatherLogs ? 'allowed' : 'not allowed';
    return `${command}\n\nLog gathering: ${consent}`;
  }

  const mockup = options.shouldCreateMockup ? 'requested' : 'not requested';
  return `${command}\n\nUX mockup: ${mockup}`;
}
