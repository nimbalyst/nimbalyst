import React from 'react';

export interface ExtensionProjectIntroModalProps {
  isOpen: boolean;
  onContinue: () => void;
  onDontShowAgain: () => void;
  onCancel: () => void;
}

const capabilities = [
  { icon: 'edit_note', text: 'Custom editors for any file type, with native look and feel' },
  { icon: 'view_sidebar', text: 'Side panels and workspace views for dashboards and live status' },
  { icon: 'psychology', text: 'AI tools that Claude can use while working in your project' },
  { icon: 'deployed_code', text: 'In-app dev loop — build, install, and reload without leaving Nimbalyst' },
];

export const ExtensionProjectIntroModal: React.FC<ExtensionProjectIntroModalProps> = ({
  isOpen,
  onContinue,
  onDontShowAgain,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="nim-overlay backdrop-blur-sm bg-black/55"
      onClick={onCancel}
    >
      <div
        className="nim-modal w-[92%] max-w-[480px] border border-nim bg-nim shadow-[0_30px_100px_rgba(0,0,0,0.35)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-7 pt-7 pb-5">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[color:color-mix(in_srgb,var(--nim-primary)_32%,var(--nim-border))] bg-[color:color-mix(in_srgb,var(--nim-primary)_14%,transparent)] text-[var(--nim-primary)]">
            <span className="material-symbols-outlined text-[26px]">extension</span>
          </div>
          <h2 className="m-0 text-xl font-semibold tracking-[-0.02em] text-nim">
            Build with Extensions
          </h2>
          <p className="mt-2 text-[14px] leading-6 text-nim-muted">
            Extensions add custom editors, AI tools, commands, panels, and more.
            Nimbalyst loads your extension live while you develop.
          </p>
        </div>

        <div className="flex flex-col gap-2.5 px-7 pb-5">
          {capabilities.map((cap) => (
            <div key={cap.icon} className="flex items-start gap-3">
              <span className="material-symbols-outlined mt-0.5 text-[18px] text-[var(--nim-primary)]">
                {cap.icon}
              </span>
              <span className="text-[13px] leading-5 text-nim-muted">{cap.text}</span>
            </div>
          ))}
        </div>

        <div className="mx-7 mb-5 rounded-lg bg-nim-secondary px-4 py-3">
          <span className="text-[13px] leading-5 text-nim-muted">
            Describe what you want to the agent, and it will scaffold, build, and install the extension for you.
          </span>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-nim px-7 py-4">
          <button
            className="nim-btn-secondary rounded-lg px-4 py-2 text-sm font-medium"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="rounded-lg border border-nim bg-transparent px-4 py-2 text-sm font-medium text-nim-muted transition-colors hover:bg-nim-secondary hover:text-nim"
            onClick={onDontShowAgain}
          >
            Don&apos;t Show Again
          </button>
          <button
            className="nim-btn-primary rounded-lg px-5 py-2 text-sm font-semibold"
            onClick={onContinue}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};
