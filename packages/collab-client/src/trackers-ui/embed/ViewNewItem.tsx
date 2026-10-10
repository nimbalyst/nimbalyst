import { useState } from 'react';

/** A refused create keeps its title in place for correction or retry. */
export function ViewNewItem({ onCreate }: { onCreate(title: string, requestId: string): Promise<void> }) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="px-3 py-2 text-left text-xs text-nim-link" onClick={() => setOpen(true)}>+ New</button>;
  return <form className="flex flex-wrap gap-2 p-2" onSubmit={event => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setError(null);
    onCreate(title.trim(), requestId).then(() => { setTitle(''); setRequestId(crypto.randomUUID()); }, cause => setError(cause instanceof Error ? cause.message : 'The item could not be created')).finally(() => setBusy(false));
  }}>
    <input aria-label="New item title" autoFocus className="min-w-0 flex-1 rounded border border-nim bg-nim px-2 py-1 text-xs" value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
    <button type="submit" className="text-xs text-nim-link" disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create'}</button>
    <button type="button" className="text-xs" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    {error ? <div className="w-full text-xs text-nim-error" role="alert">{error}</div> : null}
  </form>;
}
