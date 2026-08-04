/**
 * DocUnreadDot — the 8px "unread" dot shown on a shared-doc sidebar row.
 * Mirrors the tracker/session unread dot (filled circle in `--nim-primary`).
 * Reads `docUnreadAtom(documentId)` so only the affected row re-renders.
 */
import React from 'react';
export interface DocUnreadDotProps {
    documentId: string;
    className?: string;
}
export declare const DocUnreadDot: React.FC<DocUnreadDotProps>;
