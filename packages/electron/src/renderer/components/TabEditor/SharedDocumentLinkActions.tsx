import React from 'react';
import { copyToClipboard } from '@nimbalyst/runtime/utils/clipboard';
import { CONSOLE_ORIGIN } from '../../../shared/consoleOrigin';

export interface SharedDocumentLinkTarget {
  documentId: string;
  orgId: string;
  teamProjectId?: string | null;
}

export function SharedDocumentLinkActions({ deepLink, target, onClose }: {
  deepLink: string;
  target?: SharedDocumentLinkTarget;
  onClose: () => void;
}) {
  const itemClass = 'dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]';
  const browserUrl = target?.orgId && target.documentId && target.teamProjectId
    // Mirrors orgDocumentPath in the web console's routing.ts.
    ? `${CONSOLE_ORIGIN}/org/${encodeURIComponent(target.orgId)}/project/${encodeURIComponent(target.teamProjectId)}/document/${encodeURIComponent(target.documentId)}`
    : null;

  const copyLink = async () => {
    try {
      await copyToClipboard(deepLink);
    } catch (error) {
      console.error('[SharedDocumentLinkActions] Failed to copy link:', error);
    }
    onClose();
  };

  const openInBrowser = async () => {
    if (!browserUrl) return;
    onClose();
    try {
      await window.electronAPI.openExternal(browserUrl);
    } catch (error) {
      console.error('[SharedDocumentLinkActions] Failed to open browser:', error);
    }
  };

  return (
    <>
      {browserUrl && (
        <button className={`open-shared-doc-in-browser ${itemClass}`} onClick={openInBrowser}>
          <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 3h6v6M10 14 21 3M21 14v7H3V3h7" />
          </svg>
          Open in browser
        </button>
      )}
      <button className={`copy-shared-doc-link ${itemClass}`} onClick={copyLink}>
        <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        Copy link
      </button>
    </>
  );
}
