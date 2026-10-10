/**
 * The decisions or open questions marked across pages
 * (a placed-view link of marks, see `placedViewUrl.ts`), read through the
 * host's page-marks source. Each row is the marked sentence, its faint
 * who / when / not-chosen line, and the page it is on.
 *
 * Optional title attrs: `type=<typeId>` (only pages of that type),
 * `search=<text>` (percent-encoded), `limit=<n>`.
 */

import { useEffect, useState, type JSX } from 'react';
import { collabOpenOptions, type CollabOpenOptions } from '@nimbalyst/collab-client/core';
import { decodeViewAttrValue, type PlacedViewMarksKind } from '@nimbalyst/runtime/core/placedViewUrl';
import {
  getPageMarksSource,
  onPageMarksSourceChange,
  type PageMarkRecord,
  type PageMarksQuery,
  type PageMarksSource,
} from '../../pages';
import { PlacedViewNote } from './PlacedViewNote';

export interface MarksListEmbedProps {
  kind: PlacedViewMarksKind;
  label: string;
  attrs: Readonly<Record<string, string>>;
  /** Opens the page a mark is on, by its tab uri (`tracker://...`, `personal://...`). */
  /** `options` carries Cmd/Ctrl from the click, so a host can open a new tab. */
  onOpenPage?: (uri: string, options?: CollabOpenOptions) => void;
}

export function marksQuery(kind: PlacedViewMarksKind, attrs: Readonly<Record<string, string>>): PageMarksQuery {
  const limit = attrs.limit ? parseInt(attrs.limit, 10) : NaN;
  return {
    ...(kind === 'all' ? {} : { kind }),
    ...(attrs.type ? { typeId: attrs.type } : {}),
    ...(attrs.search ? { search: decodeViewAttrValue(attrs.search) } : {}),
    ...(Number.isFinite(limit) && limit >= 0 ? { limit } : {}),
  };
}

function useMarksSource(): PageMarksSource | null {
  const [source, setSource] = useState(getPageMarksSource);
  useEffect(() => onPageMarksSourceChange(() => setSource(getPageMarksSource())), []);
  return source;
}

/**
 * Loads the marks, and again whenever the source says they changed (an edit,
 * a reconnect, a retry while the team index was incomplete). Only the newest
 * load lands; a failed reload keeps the rows already shown for the same query,
 * never rows from another source or query.
 */
function useMarks(source: PageMarksSource | null, queryKey: string): { marks: PageMarkRecord[] | null; error: string | null; status?: 'ready' | 'partial' } {
  const [state, setState] = useState<{
    source: PageMarksSource | null;
    queryKey: string;
    marks: PageMarkRecord[] | null;
    error: string | null;
    status?: 'ready' | 'partial';
  }>({ source: null, queryKey: '', marks: null, error: null });
  useEffect(() => {
    if (!source) return undefined;
    let cancelled = false;
    let latest = 0;
    const query = JSON.parse(queryKey) as PageMarksQuery;
    const load = () => {
      const attempt = ++latest;
      const current = () => !cancelled && attempt === latest;
      const result = source.listMarksResult ? source.listMarksResult(query) : source.listMarks(query).then(marks => ({ marks, status: 'ready' as const }));
      result.then(
        ({ marks, status }) => { if (current()) setState({ source, queryKey, marks, status, error: null }); },
        (cause: unknown) => {
          if (!current()) return;
          const error = cause instanceof Error ? cause.message : String(cause);
          setState((previous) => ({
            source,
            queryKey,
            marks: previous.source === source && previous.queryKey === queryKey ? previous.marks : null,
            error,
            status: previous.status,
          }));
        },
      );
    };
    load();
    const unsubscribe = source.subscribe?.(load);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [source, queryKey]);
  // Until the new query answers, show it as loading rather than the old rows.
  if (state.source !== source || state.queryKey !== queryKey) return { marks: null, error: null };
  return { marks: state.marks, error: state.error, status: state.status };
}

function metaLine(mark: PageMarkRecord): string {
  return [mark.by, mark.on, mark.over ? `over ${mark.over}` : null].filter(Boolean).join(', ');
}

const EMPTY: Record<PlacedViewMarksKind, string> = {
  decided: 'No sentences are marked decided yet.',
  open: 'No sentences are marked open yet.',
  all: 'No sentences are marked yet.',
};

export function MarksListEmbed({ kind, label, attrs, onOpenPage }: MarksListEmbedProps): JSX.Element {
  const source = useMarksSource();
  const queryKey = JSON.stringify(marksQuery(kind, attrs));
  const { marks, error, status } = useMarks(source, queryKey);
  const name = label || (kind === 'open' ? 'Open questions' : 'Decisions');
  if (!source) return <PlacedViewNote>{name}: this host cannot read page marks yet.</PlacedViewNote>;

  return (
    <div
      className="marks-list-embed my-3 flex flex-col overflow-hidden rounded-lg border border-nim bg-nim-secondary"
      contentEditable={false}
      data-testid="marks-list-embed"
      data-kind={kind}
    >
      <div className="marks-list-embed-head border-b border-nim px-3 py-2 text-xs font-medium text-nim">{name}</div>
      <div className="marks-list-embed-body flex flex-col bg-nim text-sm">
        {error ? <div className="px-3 py-2 text-xs text-nim-error" role="alert">{error}</div> : null}
        {marks === null && !error ? <div className="px-3 py-2 text-xs text-nim-muted">Loading...</div> : null}
        {status === 'partial' ? <div className="px-3 py-2 text-xs text-nim-muted" role="status">Results are incomplete. Some pages may still be indexing, offline, or unsupported by this server.</div> : null}
        {marks?.length === 0 && status !== 'partial' && !error ? <div className="px-3 py-2 text-xs text-nim-muted">{EMPTY[kind]}</div> : null}
        {marks?.map((mark) => (
          <div key={mark.id} className="marks-list-row flex items-baseline gap-2 border-b border-nim px-3 py-1.5 last:border-b-0">
            <span
              className={mark.kind === 'decided'
                ? 'marks-list-chip shrink-0 rounded border border-[var(--nim-purple)] px-1 text-[10px] font-semibold uppercase text-[var(--nim-purple)]'
                : 'marks-list-chip shrink-0 rounded border border-[var(--nim-warning)] px-1 text-[10px] font-semibold uppercase text-[var(--nim-warning)]'}
            >
              {mark.kind === 'decided' ? 'Decided' : 'Open'}
            </span>
            <span className="marks-list-text min-w-0 flex-1 select-text">
              <span className="text-nim">{mark.plainText}</span>
              {metaLine(mark) ? <span className="ml-2 text-xs text-nim-faint" data-testid="marks-list-meta">{metaLine(mark)}</span> : null}
            </span>
            {onOpenPage ? (
              <button
                type="button"
                className="marks-list-page shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-nim-link hover:underline"
                onClick={(event) => onOpenPage(mark.page.uri, collabOpenOptions(event))}
              >
                {mark.page.title}
              </button>
            ) : (
              <span className="marks-list-page shrink-0 text-xs text-nim-muted">{mark.page.title}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
