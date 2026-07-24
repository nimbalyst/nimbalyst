import React, { useCallback, useEffect, useMemo, useState } from 'react';

const CODEX_DOCS_URL = 'https://developers.openai.com/codex';

interface CodexLoginStatus {
  installed: boolean;
  isLoggedIn: boolean;
  authMethod?: 'chatgpt' | 'api-key' | 'unknown';
  message: string;
  error?: string;
}

const injectOpenAIAuthWidgetStyles = () => {
  const styleId = 'openai-auth-widget-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .openai-auth-widget {
      background-color: color-mix(in srgb, var(--nim-error) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--nim-error) 25%, transparent);
    }
    .openai-auth-widget.logged-in {
      background-color: color-mix(in srgb, var(--nim-success) 10%, transparent);
      border-color: color-mix(in srgb, var(--nim-success) 35%, transparent);
    }
  `;
  document.head.appendChild(style);
};

export const OpenAIAuthWidget: React.FC = () => {
  const [status, setStatus] = useState<CodexLoginStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    injectOpenAIAuthWidgetStyles();
  }, []);

  const handleCheckStatus = useCallback(async () => {
    setIsChecking(true);
    try {
      if (!window.electronAPI?.invoke) {
        setStatus({
          installed: false,
          isLoggedIn: false,
          message: 'Cannot access Electron API. Please restart the application.',
          error: 'Cannot access Electron API. Please restart the application.',
        });
        return;
      }

      const result = await window.electronAPI.invoke('openai-codex:check-login');
      setStatus(result);
    } catch (error: any) {
      setStatus({
        installed: false,
        isLoggedIn: false,
        message: 'Failed to check Codex login status.',
        error: error?.message || 'Failed to check Codex login status.',
      });
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void handleCheckStatus();
  }, [handleCheckStatus]);

  const handleLogin = useCallback(async () => {
    setIsLoggingIn(true);
    try {
      if (!window.electronAPI?.invoke) {
        setStatus({
          installed: false,
          isLoggedIn: false,
          message: 'Cannot access Electron API. Please restart the application.',
          error: 'Cannot access Electron API. Please restart the application.',
        });
        return;
      }

      const result = await window.electronAPI.invoke('openai-codex:login');
      setStatus({
        installed: true,
        isLoggedIn: false,
        message: result?.message || 'Started the Codex login flow.',
      });
    } catch (error: any) {
      setStatus({
        installed: false,
        isLoggedIn: false,
        message: 'Failed to start the Codex login flow.',
        error: error?.message || 'Failed to start the Codex login flow.',
      });
    } finally {
      setIsLoggingIn(false);
    }
  }, []);

  const handleOpenDocs = useCallback(() => {
    void window.electronAPI?.openExternal?.(CODEX_DOCS_URL);
  }, []);

  const title = useMemo(() => {
    if (status?.isLoggedIn) {
      return 'OpenAI Codex is logged in';
    }
    return 'OpenAI Codex authentication required';
  }, [status?.isLoggedIn]);

  const description = useMemo(() => {
    if (status?.isLoggedIn) {
      if (status.authMethod === 'chatgpt') {
        return 'Codex is authenticated with ChatGPT. Retry your prompt if this session was blocked earlier.';
      }
      if (status.authMethod === 'api-key') {
        return 'Codex is authenticated with an API key. Retry your prompt if this session was blocked earlier.';
      }
      return 'Codex is authenticated. Retry your prompt if this session was blocked earlier.';
    }

    return 'No ~/.codex/auth.json yet is normal before first login. Start the Codex login flow below, or use an API key in Settings if you prefer.';
  }, [status]);

  const statusBoxClassName = useMemo(() => {
    if (status?.isLoggedIn) {
      return 'border-[var(--nim-success)] text-[var(--nim-success)]';
    }
    if (status?.error) {
      return 'border-[var(--nim-error)] text-[var(--nim-error)]';
    }
    return 'border-[var(--nim-border)] text-[var(--nim-text-muted)]';
  }, [status]);

  return (
    <div className={`openai-auth-widget my-4 p-4 rounded-lg flex flex-col gap-3 ${status?.isLoggedIn ? 'logged-in' : ''}`}>
      <div className={`text-sm font-medium ${status?.isLoggedIn ? 'text-[var(--nim-success)]' : 'text-[var(--nim-text)]'}`}>
        {title}
      </div>
      <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
        {description}
      </p>

      {status && (
        <div className={`rounded-md border p-3 text-[13px] leading-relaxed ${statusBoxClassName}`}>
          {status.error || status.message}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleLogin}
          disabled={isLoggingIn}
          className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isLoggingIn ? 'Opening Login...' : status?.isLoggedIn ? 'Log In Again' : 'Log In'}
        </button>
        <button
          onClick={() => void handleCheckStatus()}
          disabled={isChecking}
          className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isChecking ? 'Checking...' : 'Check Status'}
        </button>
        <button
          onClick={handleOpenDocs}
          className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
        >
          Open Setup Docs
        </button>
      </div>
    </div>
  );
};
