import React from 'react';

interface ClaudeCommandsLearnMoreDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

interface CommandInfo {
  name: string;
  description: string;
}

interface CommandGroup {
  title: string;
  packageName: string;
  commands: CommandInfo[];
}

const COMMAND_GROUPS: CommandGroup[] = [
  {
    title: 'Core',
    packageName: 'Essential for all workflows',
    commands: [
      {
        name: '/track',
        description: 'Log bugs, ideas, tasks, and decisions with unique IDs',
      },
      {
        name: '/mockup',
        description: 'Create visual UI mockups you can draw on',
      },
    ],
  },
  {
    title: 'Developer',
    packageName: 'For software development',
    commands: [
      {
        name: '/analyze-code',
        description: 'Analyze code quality and suggest improvements',
      },
      {
        name: '/write-tests',
        description: 'Generate comprehensive tests for code',
      },
    ],
  },
  {
    title: 'Product Manager',
    packageName: 'For product planning',
    commands: [
      {
        name: '/roadmap',
        description: 'Generate product roadmap from plans and features',
      },
      {
        name: '/user-research',
        description: 'Document user research findings',
      },
    ],
  },
];

export function ClaudeCommandsLearnMoreDialog({
  isOpen,
  onClose,
  onOpenSettings,
}: ClaudeCommandsLearnMoreDialogProps): React.ReactElement | null {
  if (!isOpen) return null;

  return (
    <div
      className="claude-commands-learn-more-overlay nim-overlay z-[10001] backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div
        className="claude-commands-learn-more-dialog nim-modal w-[90%] max-w-[640px] max-h-[85vh] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="claude-commands-learn-more-header flex items-center justify-between px-6 py-5 border-b border-[var(--nim-border)]">
          <h2 className="m-0 text-lg font-semibold text-[var(--nim-text)]">
            Claude Commands for Nimbalyst
          </h2>
          <button
            className="claude-commands-learn-more-close nim-btn-icon w-8 h-8 text-[28px] leading-none rounded transition-all duration-200"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="claude-commands-learn-more-content overflow-y-auto p-6 flex flex-col gap-6">
          {/* Introduction */}
          <section className="claude-commands-learn-more-section">
            <p className="claude-commands-learn-more-intro m-0 text-sm text-[var(--nim-text)]">
              Installing Claude Commands adds slash commands that help Claude
              work better with Nimbalyst. These commands enable structured
              planning, visual mockups, issue tracking, and more.
            </p>
          </section>

          {/* nimbalyst-local folder */}
          <section className="claude-commands-learn-more-section">
            <h3 className="m-0 mb-1 text-sm font-semibold text-[var(--nim-text)]">
              The nimbalyst-local Folder
            </h3>
            <p className="m-0 mb-3 text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
              A{' '}
              <code className="bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded px-1.5 py-0.5 font-mono text-xs text-[var(--nim-text)]">
                nimbalyst-local
              </code>{' '}
              folder will be created in your project root to store working
              documents:
            </p>
            <div className="claude-commands-folder-structure bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg px-4 py-3 my-3">
              <pre className="m-0 font-mono text-xs leading-relaxed text-[var(--nim-text-muted)] whitespace-pre">
                {`nimbalyst-local/
├── plans/        # Plan documents (.md)
├── tracker/      # Bugs, ideas, tasks (.md)
├── mockups/      # UI mockups (.mockup.html)
└── existing-screens/  # UI references`}
              </pre>
            </div>
            <p className="claude-commands-learn-more-note m-0 text-xs italic text-[var(--nim-text-faint)]">
              This folder is automatically added to{' '}
              <code className="bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded px-1.5 py-0.5 font-mono text-xs text-[var(--nim-text)]">
                .gitignore
              </code>{' '}
              to keep your repository clean and avoid merge conflicts.
            </p>
          </section>

          {/* Slash Commands by Group */}
          {COMMAND_GROUPS.map((group) => (
            <section
              key={group.title}
              className="claude-commands-learn-more-section"
            >
              <h3 className="m-0 mb-1 text-sm font-semibold text-[var(--nim-text)]">
                {group.title}
              </h3>
              <p className="claude-commands-group-subtitle m-0 mb-3 text-xs text-[var(--nim-text-faint)]">
                {group.packageName}
              </p>
              <div className="claude-commands-list flex flex-col gap-3">
                {group.commands.map((cmd) => (
                  <div
                    key={cmd.name}
                    className="claude-commands-item bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg px-3.5 py-3"
                  >
                    <div className="claude-commands-item-header mb-1.5">
                      <code className="claude-commands-item-name text-[13px] font-semibold text-[var(--nim-primary)]">
                        {cmd.name}
                      </code>
                    </div>
                    <p className="claude-commands-item-description m-0 text-xs text-[var(--nim-text-muted)]">
                      {cmd.description}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/* Additional info */}
          <section className="claude-commands-learn-more-section">
            <p className="claude-commands-learn-more-note m-0 text-xs italic text-[var(--nim-text-faint)]">
              Commands work with Claude Code (the agentic coding feature). You
              can manage installed packages in{' '}
              <button
                className="claude-commands-learn-more-link bg-transparent border-none p-0 text-inherit font-inherit italic text-[var(--nim-primary)] cursor-pointer underline transition-colors duration-200 hover:text-[var(--nim-primary-hover)]"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
              >
                Project Settings
              </button>
              .
            </p>
          </section>
        </div>

        <div className="claude-commands-learn-more-footer flex justify-end px-6 py-4 border-t border-[var(--nim-border)]">
          <button
            className="claude-commands-learn-more-btn nim-btn-primary px-5 py-2.5 rounded-md text-sm font-medium"
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
