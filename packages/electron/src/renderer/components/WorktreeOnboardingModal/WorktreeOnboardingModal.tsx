import React from 'react';

export interface WorktreeOnboardingModalProps {
  isOpen: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

export const WorktreeOnboardingModal: React.FC<WorktreeOnboardingModalProps> = ({
  isOpen,
  onContinue,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="worktree-onboarding-overlay nim-overlay backdrop-blur-sm bg-black/60"
      onClick={onCancel}
    >
      <div
        className="worktree-onboarding-dialog nim-modal w-[90%] max-w-[480px] animate-[worktree-modal-appear_0.2s_ease]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="worktree-onboarding-header flex flex-col items-center text-center px-7 pt-7 pb-5 border-b border-nim">
          <span className="material-symbols-outlined worktree-onboarding-icon text-5xl text-nim-primary mb-4">
            account_tree
          </span>
          <h2 className="m-0 text-[22px] font-semibold text-nim">What is a Worktree?</h2>
        </div>

        <div className="worktree-onboarding-content px-7 py-6">
          <p className="worktree-onboarding-description m-0 mb-6 text-[15px] leading-relaxed text-nim-muted text-center [&_strong]:text-nim">
            Worktrees create a git branch in an <strong>isolated directory</strong>, separate from your main repository.
            This gives you a safe place to make changes without affecting the rest of your code.
          </p>

          <div className="worktree-onboarding-benefits flex flex-col gap-4">
            <div className="worktree-benefit flex items-start gap-3.5 p-3.5 px-4 bg-nim-secondary rounded-[10px] border border-nim">
              <span className="material-symbols-outlined benefit-icon text-2xl text-nim-primary shrink-0">shield</span>
              <div className="benefit-text flex flex-col gap-0.5">
                <strong className="text-sm font-semibold text-nim">Safe experimentation</strong>
                <span className="text-[13px] text-nim-muted">AI changes stay in a separate branch</span>
              </div>
            </div>
            <div className="worktree-benefit flex items-start gap-3.5 p-3.5 px-4 bg-nim-secondary rounded-[10px] border border-nim">
              <span className="material-symbols-outlined benefit-icon text-2xl text-nim-primary shrink-0">rate_review</span>
              <div className="benefit-text flex flex-col gap-0.5">
                <strong className="text-sm font-semibold text-nim">Easy review</strong>
                <span className="text-[13px] text-nim-muted">Review and merge changes when ready</span>
              </div>
            </div>
            <div className="worktree-benefit flex items-start gap-3.5 p-3.5 px-4 bg-nim-secondary rounded-[10px] border border-nim">
              <span className="material-symbols-outlined benefit-icon text-2xl text-nim-primary shrink-0">stacks</span>
              <div className="benefit-text flex flex-col gap-0.5">
                <strong className="text-sm font-semibold text-nim">Parallel work</strong>
                <span className="text-[13px] text-nim-muted">Run multiple experiments simultaneously</span>
              </div>
            </div>
          </div>
        </div>

        <div className="worktree-onboarding-footer flex justify-end gap-3 px-7 py-5 border-t border-nim">
          <button
            className="worktree-onboarding-secondary-button nim-btn-secondary px-5 py-2.5 text-sm font-medium rounded-lg"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="worktree-onboarding-primary-button nim-btn-primary px-6 py-2.5 text-sm font-semibold rounded-lg shadow-[0_2px_8px_rgba(88,166,255,0.2)] hover:shadow-[0_4px_12px_rgba(88,166,255,0.3)] hover:-translate-y-px active:translate-y-0 transition-all duration-150"
            onClick={onContinue}
          >
            Create Worktree
          </button>
        </div>
      </div>
    </div>
  );
};
