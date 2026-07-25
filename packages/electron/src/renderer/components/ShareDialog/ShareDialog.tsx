import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, copyToClipboard } from '@nimbalyst/runtime';
import {
  addSessionShareAtom,
  sessionShareAtom,
  shareKeysAtom,
  buildShareUrl,
} from '../../store/atoms/sessionShares';
import { ShareAccountPicker, type ShareAccountOption } from './ShareAccountPicker';
import { AccountLoginForm } from '../Accounts/AccountLoginForm';
import { stytchAuthAtom } from '../../store/atoms/stytchAuth';

export interface ShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  contentType: 'session' | 'file';
  sessionId?: string;
  filePath?: string;
  title?: string;
}

type ExpirationOption = {
  label: string;
  value: number;
};

const EXPIRATION_OPTIONS: ExpirationOption[] = [
  { label: '1 day', value: 1 },
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
];

type ShareState = 'ready' | 'sharing' | 'success' | 'error';

export const ShareDialog: React.FC<ShareDialogProps> = ({
  isOpen,
  onClose,
  contentType,
  sessionId,
  filePath,
  title,
}) => {
  const [shareState, setShareState] = useState<ShareState>('ready');
  const [errorMessage, setErrorMessage] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [expirationDays, setExpirationDays] = useState<number>(7);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [accounts, setAccounts] = useState<ShareAccountOption[]>([]);
  const [selectedPersonalOrgId, setSelectedPersonalOrgId] = useState('');
  const [defaultAccountSource, setDefaultAccountSource] = useState<'workspace-binding' | 'sync-account' | 'only-account'>('sync-account');
  const urlInputRef = useRef<HTMLInputElement>(null);

  const authState = useAtomValue(stytchAuthAtom);

  // Check if session is already shared
  const existingShare = useAtomValue(sessionShareAtom(sessionId ?? ''));
  const shareKeys = useAtomValue(shareKeysAtom);
  const addShare = useSetAtom(addSessionShareAtom);

  useEffect(() => {
    if (!isOpen) return;
    void window.electronAPI?.getShareAccountOptions?.({ contentType, sessionId, filePath })
      .then((result) => {
        if (!result?.success) return;
        const available = result.accounts ?? [];
        setAccounts(available);
        setSelectedPersonalOrgId(result.defaultPersonalOrgId ?? available[0]?.personalOrgId ?? '');
        setDefaultAccountSource(result.defaultSource ?? 'sync-account');
      });
  }, [contentType, filePath, isOpen, sessionId]);

  // Load saved expiration preference
  useEffect(() => {
    if (!isOpen || preferenceLoaded) return;
    (async () => {
      try {
        const pref = await window.electronAPI?.getShareExpirationPreference?.();
        if (pref !== undefined && pref !== null) {
          setExpirationDays(pref);
        }
      } catch {
        // Use default
      }
      setPreferenceLoaded(true);
    })();
  }, [isOpen, preferenceLoaded]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setShareState('ready');
      setErrorMessage('');
      setShareUrl('');
      setUrlCopied(false);

      // If already shared, show the existing URL
      if (existingShare) {
        const key = shareKeys.get(sessionId ?? '');
        const url = buildShareUrl(existingShare.shareId, key);
        setShareUrl(url);
      }
    } else {
      setPreferenceLoaded(false);
    }
  }, [isOpen, existingShare, shareKeys, sessionId]);

  const handleShare = useCallback(async () => {
    setShareState('sharing');
    setErrorMessage('');

    // Save preference
    try {
      await window.electronAPI?.setShareExpirationPreference?.(expirationDays);
    } catch {
      // Non-critical
    }

    try {
      let result: { success: boolean; url?: string; shareId?: string; isUpdate?: boolean; encryptionKey?: string; owningPersonalOrgId?: string; error?: string } | undefined;

      if (contentType === 'session' && sessionId) {
        result = await window.electronAPI?.shareSessionAsLink({
          sessionId,
          expirationDays,
          personalOrgId: selectedPersonalOrgId || undefined,
        });
      } else if (contentType === 'file' && filePath) {
        result = await window.electronAPI?.shareFileAsLink({
          filePath,
          expirationDays,
          personalOrgId: selectedPersonalOrgId || undefined,
        });
      }

      if (result?.success && result.url) {
        setShareUrl(result.url);
        setShareState('success');

        // Copy to clipboard
        await copyToClipboard(result.url);

        // Update share atoms for sessions
        if (contentType === 'session' && sessionId && result.shareId) {
          const expiresAt = new Date(Date.now() + expirationDays * 24 * 60 * 60 * 1000).toISOString();
          addShare({
            shareId: result.shareId,
            sessionId,
            title: title ?? 'Untitled',
            sizeBytes: 0,
            createdAt: new Date().toISOString(),
            expiresAt,
            viewCount: 0,
            owningPersonalOrgId: result.owningPersonalOrgId ?? '',
            encryptionKey: result.encryptionKey,
          });
        }
      } else {
        setErrorMessage(result?.error ?? 'Failed to share');
        setShareState('error');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
      setShareState('error');
    }
  }, [contentType, sessionId, filePath, expirationDays, selectedPersonalOrgId, title, addShare]);

  const handleCopyUrl = useCallback(async () => {
    if (!shareUrl) return;
    await copyToClipboard(shareUrl);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 2000);
  }, [shareUrl]);

  if (!isOpen) return null;

  const contentLabel = contentType === 'session' ? 'session' : 'file';
  const isAlreadyShared = !!existingShare;
  const needsAuth = authState?.isAuthenticated === false;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-[10000] bg-black/60 animate-[nim-fade-in_0.2s_ease-out]"
      onClick={onClose}
    >
      <div
        className="relative p-0 w-[420px] max-w-[90vw] rounded-2xl overflow-hidden border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-[0_8px_32px_rgba(0,0,0,0.4)] animate-[nim-slide-up_0.3s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          className="absolute top-4 right-4 w-8 h-8 p-0 flex items-center justify-center bg-transparent border-none text-[28px] leading-none cursor-pointer rounded-md z-[1] text-[var(--nim-text-muted)] transition-[color,transform] duration-200 hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:scale-110"
          onClick={onClose}
          aria-label="Close"
        >
          &times;
        </button>

        <div className="px-8 pt-8 pb-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[var(--nim-primary)]/15 text-[var(--nim-primary)]">
              <MaterialSymbol icon="share" size={22} />
            </div>
            <h2 className="m-0 text-lg font-semibold text-[var(--nim-text)]">
              Share {contentLabel}
            </h2>
          </div>

          {/* Sign-in required */}
          {needsAuth ? (
            <div className="share-dialog-login flex flex-col gap-4">
              <p className="m-0 text-[0.8125rem] text-[var(--nim-text-muted)]">
                Sign in to share encrypted links.
              </p>
              <AccountLoginForm mode="first-sign-in" />
              <div className="flex justify-end">
                <button
                  type="button"
                  className="rounded-lg border-none bg-transparent px-4 py-2.5 text-[0.8125rem] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                  onClick={onClose}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Privacy explanation */}
              <div className="flex gap-3 p-3 mb-5 rounded-lg bg-[var(--nim-bg-hover)]">
                <MaterialSymbol icon="lock" size={18} className="shrink-0 mt-0.5 text-[var(--nim-text-muted)]" />
                <div>
                  <p className="m-0 text-[0.8125rem] text-[var(--nim-text)]">
                    Anyone with the link can view this {contentLabel}
                  </p>
                  <p className="m-0 mt-1 text-[0.75rem] text-[var(--nim-text-faint)]">
                    Content is end-to-end encrypted.
                    <br />
                    No one without the link -- including Nimbalyst Servers -- can see it.
                  </p>
                </div>
              </div>

              {/* Expiration dropdown */}
              {shareState !== 'success' && (
                <div className="mb-5 flex flex-col gap-5">
                  {accounts.length > 1 && (
                    <ShareAccountPicker
                      accounts={accounts}
                      selectedPersonalOrgId={selectedPersonalOrgId}
                      defaultSource={defaultAccountSource}
                      onChange={setSelectedPersonalOrgId}
                    />
                  )}
                  <div>
                  <label className="block text-[0.75rem] font-medium text-[var(--nim-text-muted)] mb-1.5">
                    Link expires after
                  </label>
                  <select
                    className="w-full px-3 py-2 text-[0.8125rem] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer outline-none transition-colors duration-150 focus:border-[var(--nim-primary)] [&>option]:bg-[var(--nim-bg)] [&>option]:text-[var(--nim-text)]"
                    value={String(expirationDays)}
                    onChange={(e) => {
                      setExpirationDays(Number(e.target.value));
                    }}
                  >
                    {EXPIRATION_OPTIONS.map((opt) => (
                      <option key={String(opt.value)} value={String(opt.value)}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <p className="m-0 mt-1.5 text-[0.6875rem] text-[var(--nim-text-faint)]">
                    Your choice will be remembered for next time
                  </p>
                  </div>
                </div>
              )}

              {/* Success state: show URL */}
              {shareState === 'success' && shareUrl && (
                <div className="mb-5">
                  <label className="block text-[0.75rem] font-medium text-[var(--nim-text-muted)] mb-1.5">
                    Share link
                  </label>
                  <div className="flex gap-2">
                    <input
                      ref={urlInputRef}
                      type="text"
                      readOnly
                      value={shareUrl}
                      className="flex-1 min-w-0 px-3 py-2 text-[0.8125rem] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-hover)] text-[var(--nim-text)] outline-none select-text"
                      onClick={() => urlInputRef.current?.select()}
                    />
                    <button
                      className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-[0.8125rem] rounded-lg border border-[var(--nim-border)] bg-transparent text-[var(--nim-text)] cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                      onClick={handleCopyUrl}
                    >
                      <MaterialSymbol icon={urlCopied ? 'check' : 'content_copy'} size={14} />
                      {urlCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {/* Error state */}
              {shareState === 'error' && (
                <div className="mb-5 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                  <p className="m-0 text-[0.8125rem] text-red-400">{errorMessage}</p>
                </div>
              )}

              {/* Action button */}
              <div className="flex justify-end gap-2">
                {shareState === 'success' ? (
                  <button
                    className="px-5 py-2.5 rounded-lg border-none text-[0.8125rem] font-medium cursor-pointer text-[var(--nim-text)] bg-[var(--nim-bg-hover)] transition-colors duration-150 hover:bg-[var(--nim-border)]"
                    onClick={onClose}
                  >
                    Done
                  </button>
                ) : (
                  <>
                    <button
                      className="px-4 py-2.5 rounded-lg border-none text-[0.8125rem] cursor-pointer text-[var(--nim-text-muted)] bg-transparent transition-colors duration-150 hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                      onClick={onClose}
                    >
                      Cancel
                    </button>
                    <button
                      className="flex items-center gap-2 px-5 py-2.5 rounded-lg border-none text-[0.8125rem] font-medium cursor-pointer text-white bg-[var(--nim-primary)] transition-all duration-150 hover:brightness-110 disabled:opacity-50 disabled:cursor-default"
                      onClick={handleShare}
                      disabled={shareState === 'sharing'}
                    >
                      {shareState === 'sharing' ? (
                        <>
                          <MaterialSymbol icon="progress_activity" size={14} className="animate-spin" />
                          Sharing...
                        </>
                      ) : shareState === 'error' ? (
                        'Retry'
                      ) : isAlreadyShared ? (
                        <>
                          <MaterialSymbol icon="link" size={14} />
                          Update link
                        </>
                      ) : (
                        <>
                          <MaterialSymbol icon="link" size={14} />
                          Copy link
                        </>
                      )}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
