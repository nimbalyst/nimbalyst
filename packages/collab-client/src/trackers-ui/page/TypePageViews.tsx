import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CollabOpenOptions } from '../../core';
import { createPlacedViewMarkdown, type PlacedViewScope } from '@nimbalyst/runtime/core/placedViewUrl';
import type { NamedPageViewsController, NamedPageViewsSnapshot } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/namedPageViewsController';
import { LazyPlacedViewEmbed } from '../embed/LazyPlacedViewEmbed';
import type { PlacedViewHandoff } from './placedViewHandoff';

const EMPTY: NamedPageViewsSnapshot = { views: [], editable: false, error: null };
const emptyRead = () => EMPTY;
const emptySubscribe = () => () => {};

export function TypePageViews({ typeId, controller, temporaryView, onClearTemporaryView, onPrepareDocument, scope, onOpenItem, children }: {
  typeId: string;
  controller?: NamedPageViewsController | null;
  temporaryView?: PlacedViewHandoff | null;
  onClearTemporaryView?: () => void;
  onPrepareDocument?: () => Promise<void>;
  scope?: PlacedViewScope;
  onOpenItem: (id: string, options?: CollabOpenOptions) => void;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.getSnapshot ?? emptyRead, emptyRead);
  const [selected, setSelected] = useState<string | null>(null);
  const [explored, setExplored] = useState(temporaryView?.attrs ?? {});
  useEffect(() => { if (temporaryView) { setSelected(null); setExplored(temporaryView.attrs); } }, [temporaryView]);
  const active = state.views.find(view => view.id === selected);
  const [form, setForm] = useState<'add' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState<string | null>(null);
  const draftId = useRef('');
  const perform = (operation: () => void) => { try { operation(); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change views.'); } };
  const current = active ?? (temporaryView ? { name: temporaryView.label, attrs: explored } : null);
  const beginAdd = () => {
    setForm('add'); setName(current?.name || 'New view'); draftId.current = crypto.randomUUID(); setError(null);
    if (!controller && onPrepareDocument) void onPrepareDocument().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not open the type description.'));
  };
  return <>
    <div className="type-page-tab-views flex flex-wrap items-center gap-1 border-b border-nim text-xs" role="tablist" aria-label="Type views" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const index = tabs.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.focus(); tabs[next]?.click();
    }}>
      <button type="button" role="tab" tabIndex={!active ? 0 : -1} aria-selected={!active && !temporaryView} className="px-2.5 py-2 text-nim" onClick={() => { setSelected(null); setForm(null); setCopy(null); onClearTemporaryView?.(); }}>All</button>
      {state.views.map(view => <button key={view.id} type="button" role="tab" tabIndex={active?.id === view.id ? 0 : -1} aria-selected={active?.id === view.id} className="px-2.5 py-2 text-nim aria-selected:border-b-2 aria-selected:border-[var(--nim-primary)]" onClick={() => { setSelected(view.id); setForm(null); setCopy(null); onClearTemporaryView?.(); }}>{view.name}</button>)}
      {temporaryView && !active ? <span className="px-2.5 py-2 text-nim">{temporaryView.label || 'View'} · Unsaved view</span> : null}
    </div>
    <div className="flex flex-wrap gap-3 py-2 text-xs text-nim-link">
      <button type="button" disabled={!state.editable && (!!controller || !onPrepareDocument)} onClick={beginAdd}>{temporaryView && !active ? 'Save as named view' : 'Add view'}</button>
      {active && state.editable ? <><button type="button" onClick={() => { setForm('rename'); setName(active.name); }}>Rename view</button><button type="button" onClick={() => perform(() => { controller!.remove(active.id); setSelected(null); setForm(null); })}>Remove view</button></> : null}
      {current ? <button type="button" disabled={!scope} onClick={() => {
        // A copied link carries its definition, not a lookup of this named view.
        const link = createPlacedViewMarkdown({ kind: 'type', typeId, ...(scope ? { scope } : {}) }, current.name, { ...current.attrs });
        setCopy(link);
        // The selectable field remains available when browser clipboard permission is denied.
        void navigator.clipboard?.writeText(link).catch(() => {});
      }}>Place in page</button> : null}
    </div>
    {form ? <form className="flex flex-wrap gap-2 py-2 text-xs" onSubmit={event => { event.preventDefault(); perform(() => {
      if (!controller || !state.editable) throw new Error('The type description is still opening or is read-only.');
      if (form === 'rename' && active) controller.rename(active.id, name);
      else { controller.add(draftId.current, name, { ...(current?.attrs ?? {}) }); setSelected(draftId.current); onClearTemporaryView?.(); }
      setForm(null);
    }); }}>
      <input aria-label="View name" className="rounded border border-nim bg-nim px-2 py-1 text-nim" autoFocus value={name} onChange={event => setName(event.target.value)} />
      <button type="submit" disabled={!state.editable || !name.trim()} className="text-nim-link">{form === 'rename' ? 'Rename' : 'Save view'}</button>
      <button type="button" onClick={() => setForm(null)}>Cancel</button>
      {!controller ? <span role="status">Opening the type description…</span> : null}
    </form> : null}
    {copy ? <label className="py-2 text-xs text-nim-muted">Copy this link and paste it into a page<input aria-label="View link to copy" className="mt-1 w-full rounded border border-nim bg-nim px-2 py-1 text-nim" readOnly value={copy} onFocus={event => event.target.select()} /></label> : null}
    {error || state.error ? <div role="alert" className="py-2 text-xs text-nim-error">{error || state.error}</div> : null}
    {active ? <LazyPlacedViewEmbed key={active.id} target={{ kind: 'type', typeId }} label={active.name} attrs={active.attrs} variant="page" onOpenItem={onOpenItem} onAttrsChange={state.editable ? patch => controller!.patch(active.id, patch) : undefined} />
      : temporaryView ? <LazyPlacedViewEmbed key={JSON.stringify(temporaryView)} target={{ kind: 'type', typeId }} label={temporaryView.label} attrs={explored} variant="page" settingsTemporary onOpenItem={onOpenItem} onAttrsChange={patch => setExplored(current => Object.fromEntries(Object.entries({ ...current, ...patch }).filter((entry): entry is [string, string] => entry[1] !== null)))} /> : children}
  </>;
}
