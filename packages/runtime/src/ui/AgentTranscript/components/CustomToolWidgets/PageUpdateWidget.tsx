/**
 * One transcript line per agent edit to a page: "Updated <page>" that opens
 * the page. Agent edits to pages land directly (no review step), and there is
 * no Undo here (Decision 19); the page's history is how a person reverts.
 *
 * Rendered for `applyCollabDocEdit` (shared pages, typed-page bodies at
 * `collab://tracker-content/<id>`, Personal pages at `personal://...`) and, via
 * `PageUpdateLine`, by the tracker widget for a `tracker_update` that changed
 * a typed page's body. Kept a widget rather than a projector change because the
 * projector is shared with mobile.
 */

import React from 'react';
import { useAtomValue } from 'jotai';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import { findCitations } from '../../../../core/citationSyntax';
import type { CustomToolWidgetProps } from './index';

/**
 * "cited to your answer", "cited to 3 inputs"; null when nothing was cited.
 * Reads citations through the shared syntax, which owns the URL scheme.
 */
export function citationSummary(texts: string[]): string | null {
  const kinds: string[] = [];
  for (const text of texts) {
    for (const { citation } of findCitations(text)) {
      if (citation.kind === 'human') kinds.push(citation.inputKind);
    }
  }
  if (kinds.length === 0) return null;
  if (kinds.length === 1) return `cited to your ${kinds[0]}`;
  return `cited to ${kinds.length} inputs`;
}

/** The page title the main process reports: `Updated "<title>" (<uri>)`. */
export function pageTitleFromResult(resultText: string | null): string | null {
  const match = resultText ? /^Updated "(.+)" \(/.exec(resultText) : null;
  return match ? match[1]! : null;
}

function fallbackTitle(uri: string): string {
  if (uri.startsWith('personal://')) return 'a Personal page';
  if (uri.startsWith('collab://tracker-content/') || uri.startsWith('tracker://')) return 'a typed page';
  return 'a shared page';
}

function resultText(result: unknown): string | null {
  if (typeof result !== 'string') return null;
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      const block = parsed.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
      return block ? block.text : null;
    }
  } catch {
    // Plain text result.
  }
  return result;
}

export interface PageUpdateLineProps {
  sessionId: string;
  /** What `openPage` receives. */
  uri: string;
  title: string;
  state: 'running' | 'done' | 'error';
  editCount?: number;
  cited?: string | null;
  error?: string | null;
}

export const PageUpdateLine: React.FC<PageUpdateLineProps> = ({ sessionId, uri, title, state, editCount, cited, error }) => {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const verb = state === 'running' ? 'Updating' : state === 'error' ? 'Could not update' : 'Updated';
  const details = [
    editCount && editCount > 1 ? `${editCount} edits` : null,
    state === 'done' ? cited : null,
  ].filter(Boolean);
  return (
    <div
      className={`page-update-line flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-xs ${
        state === 'error' ? 'border-nim-error text-nim-error' : 'border-nim text-nim-muted'
      }`}
      data-testid="page-update-line"
    >
      <span className="font-medium text-nim">{verb}</span>
      {host?.openPage ? (
        <button
          type="button"
          className="page-update-line-title truncate text-nim-primary hover:underline"
          onClick={() => {
            void host.openPage!(uri).catch((err: unknown) => {
              console.error('[PageUpdateLine] Failed to open page:', err);
            });
          }}
        >
          {title}
        </button>
      ) : (
        <span className="page-update-line-title truncate text-nim">{title}</span>
      )}
      {details.length > 0 && <span className="shrink-0">&middot; {details.join(', ')}</span>}
      {state === 'error' && error && <span className="truncate">&middot; {error}</span>}
    </div>
  );
};

export const PageUpdateWidget: React.FC<CustomToolWidgetProps> = ({ message, sessionId }) => {
  const tool = message.toolCall;
  if (!tool) return null;
  const args = (tool.arguments ?? {}) as { filePath?: unknown; replacements?: unknown };
  const uri = typeof args.filePath === 'string' ? args.filePath : '';
  const replacements = Array.isArray(args.replacements) ? args.replacements : [];
  const text = resultText(tool.result);
  const state = tool.status === 'running' ? 'running' : tool.isError || tool.status === 'error' ? 'error' : 'done';
  const newTexts = replacements
    .map((replacement) => (replacement && typeof replacement.newText === 'string' ? replacement.newText : ''))
    .filter(Boolean);
  return (
    <PageUpdateLine
      sessionId={sessionId}
      uri={uri}
      title={pageTitleFromResult(text) ?? fallbackTitle(uri)}
      state={state}
      editCount={replacements.length}
      cited={citationSummary(newTexts)}
      error={state === 'error' ? text : null}
    />
  );
};

PageUpdateWidget.displayName = 'PageUpdateWidget';
