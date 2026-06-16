import React from 'react';

/**
 * Notice shown in a `claude-code-cli` session when the genuine `claude` CLI
 * isn't installed (NIM-852). Detection runs in main (`claude-cli:is-installed`);
 * the transcript renders this instead of spawning a bare `claude` that would
 * yield a cryptic `command not found`.
 *
 * Two variants share the same copy + install link:
 *   - `banner`: compact strip at the top of the transcript.
 *   - `panel`:  larger centered block in place of the raw-terminal drawer.
 */

/** Official Claude Code setup / install docs. */
export const CLAUDE_CODE_INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code/setup';

export interface ClaudeCliNotInstalledNoticeProps {
  variant: 'banner' | 'panel';
}

const openInstallDocs = () => {
  void window.electronAPI.openExternal(CLAUDE_CODE_INSTALL_URL);
};

export const ClaudeCliNotInstalledNotice: React.FC<ClaudeCliNotInstalledNoticeProps> = ({
  variant,
}) => {
  const installButton = (
    <button
      type="button"
      className="claude-cli-not-installed-notice-install"
      onClick={openInstallDocs}
      style={{
        flexShrink: 0,
        padding: '6px 12px',
        backgroundColor: 'var(--nim-primary)',
        border: 'none',
        borderRadius: '4px',
        color: 'var(--nim-on-primary, #fff)',
        fontSize: '12px',
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      Install Claude Code
    </button>
  );

  if (variant === 'banner') {
    return (
      <div
        className="claude-cli-not-installed-notice claude-cli-not-installed-notice--banner"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          margin: '8px',
          padding: '8px 12px',
          backgroundColor: 'var(--nim-bg-secondary)',
          border: '1px solid var(--nim-border)',
          borderRadius: '6px',
          color: 'var(--nim-text)',
          fontSize: '13px',
        }}
      >
        <span>
          <strong>Claude Code CLI isn&apos;t installed.</strong>{' '}
          <span style={{ color: 'var(--nim-text-muted)' }}>
            Install it to run this session.
          </span>
        </span>
        {installButton}
      </div>
    );
  }

  return (
    <div
      className="claude-cli-not-installed-notice claude-cli-not-installed-notice--panel"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        padding: '24px',
        textAlign: 'center',
        color: 'var(--nim-text)',
      }}
    >
      <div style={{ fontSize: '14px', fontWeight: 600 }}>
        Claude Code CLI isn&apos;t installed
      </div>
      <div style={{ fontSize: '12px', color: 'var(--nim-text-muted)', maxWidth: 360 }}>
        This session runs the genuine <code>claude</code> command-line tool, which
        wasn&apos;t found on your system. Install it, then reopen this session.
      </div>
      {installButton}
    </div>
  );
};

export default ClaudeCliNotInstalledNotice;
