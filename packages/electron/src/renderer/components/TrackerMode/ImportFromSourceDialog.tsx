/**
 * ImportFromSourceDialog - the "Import from <external source>" picker.
 *
 * Flow: choose a binding (e.g. a GitHub repo, auto-derived from the workspace
 * remote) -> filter/search importable items -> multiselect -> import. Each
 * import runs through the host importer pipeline (tracker:importer:import),
 * which creates a native tracker item carrying a back-link to its source.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface ImporterBinding {
  id: string;
  label: string;
}

interface ImporterListEntry {
  externalId: string;
  urn: string;
  url: string;
  title: string;
  state: string;
  updatedAt: string;
}

interface ImportFromSourceDialogProps {
  providerId: string;
  providerLabel: string;
  /** Tracker types this importer may create; first is the default. */
  importsAs?: string[];
  workspacePath: string;
  onClose: () => void;
  onImported?: (createdCount: number) => void;
}

type StateFilter = 'open' | 'closed' | 'all';

export const ImportFromSourceDialog: React.FC<ImportFromSourceDialogProps> = ({
  providerId,
  providerLabel,
  importsAs,
  workspacePath,
  onClose,
  onImported,
}) => {
  const [bindings, setBindings] = useState<ImporterBinding[] | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [primaryType, setPrimaryType] = useState<string>(importsAs?.[0] ?? 'bug');
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ImporterListEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load bindings once.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.electronAPI
      .invoke('tracker:importer:listBindings', { workspacePath, providerId })
      .then((result: unknown) => {
        if (cancelled) return;
        const list = Array.isArray(result) ? (result as ImporterBinding[]) : [];
        setBindings(list);
        setBindingId(list[0]?.id ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBindings([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, workspacePath]);

  const loadItems = useCallback(
    async (binding: string, state: StateFilter, searchText: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = (await window.electronAPI.invoke('tracker:importer:listItems', {
          workspacePath,
          providerId,
          binding: { id: binding, label: binding },
          filters: { state, search: searchText || undefined, limit: 50 },
        })) as { items?: ImporterListEntry[] };
        setItems(Array.isArray(page?.items) ? page.items : []);
      } catch (e) {
        setItems([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [providerId, workspacePath]
  );

  // Reload items when binding or state changes.
  useEffect(() => {
    if (!bindingId) return;
    void loadItems(bindingId, stateFilter, search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingId, stateFilter]);

  // Debounced reload on search.
  useEffect(() => {
    if (!bindingId) return;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      void loadItems(bindingId, stateFilter, search);
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const toggle = useCallback((externalId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }, []);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.externalId));
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (items.every((i) => prev.has(i.externalId))) return new Set();
      return new Set(items.map((i) => i.externalId));
    });
  }, [items]);

  const runImport = useCallback(async () => {
    const ids = items.filter((i) => selected.has(i.externalId)).map((i) => i.externalId);
    if (ids.length === 0) return;
    setImporting(true);
    setProgress({ done: 0, total: ids.length });
    setError(null);
    let created = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        const result = (await window.electronAPI.invoke('tracker:importer:import', {
          workspacePath,
          providerId,
          externalId: ids[i],
          primaryType,
        })) as { created?: boolean };
        if (result?.created) created++;
      } catch (e) {
        failed++;
        // Surface the first failure but keep going.
        if (!error) setError(e instanceof Error ? e.message : String(e));
      }
      setProgress({ done: i + 1, total: ids.length });
    }
    setImporting(false);
    onImported?.(created);
    if (failed === 0) {
      onClose();
    }
  }, [items, selected, providerId, primaryType, workspacePath, onImported, onClose, error]);

  const typeOptions = useMemo(() => importsAs ?? ['bug', 'task'], [importsAs]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onClick={onClose}
      data-testid="import-from-source-dialog"
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[80vh] flex flex-col bg-nim border border-nim rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nim shrink-0">
          <MaterialSymbol icon="cloud_download" size={18} className="text-nim-muted" />
          <span className="text-sm font-semibold text-nim">Import from {providerLabel}</span>
          <div className="flex-1" />
          <button
            className="p-1 rounded hover:bg-nim-tertiary text-nim-muted"
            onClick={onClose}
            title="Close"
          >
            <MaterialSymbol icon="close" size={18} />
          </button>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-nim shrink-0 flex-wrap">
          {bindings && bindings.length > 1 && (
            <select
              className="text-xs bg-nim-secondary border border-nim rounded px-2 py-1 text-nim"
              value={bindingId ?? ''}
              onChange={(e) => setBindingId(e.target.value)}
            >
              {bindings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          )}
          {bindings && bindings.length === 1 && (
            <span className="text-xs text-nim-muted font-mono">{bindings[0].label}</span>
          )}
          <select
            className="text-xs bg-nim-secondary border border-nim rounded px-2 py-1 text-nim"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <div className="relative flex-1 min-w-[140px]">
            <MaterialSymbol
              icon="search"
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-nim-faint pointer-events-none"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full pl-7 pr-2 py-1 text-xs bg-nim-secondary border border-nim rounded text-nim placeholder:text-nim-faint focus:outline-none focus:border-[var(--nim-primary)]"
            />
          </div>
          <label className="flex items-center gap-1 text-xs text-nim-muted">
            Import as
            <select
              className="text-xs bg-nim-secondary border border-nim rounded px-2 py-1 text-nim"
              value={primaryType}
              onChange={(e) => setPrimaryType(e.target.value)}
            >
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {error && (
            <div className="px-4 py-2 text-xs text-nim-error bg-nim-error/10">{error}</div>
          )}
          {bindings && bindings.length === 0 && !loading && (
            <div className="px-4 py-8 text-center text-sm text-nim-faint">
              No {providerLabel} repositories found for this workspace.
              <div className="text-xs mt-1">
                Open a project whose git remote points at GitHub, and sign in with{' '}
                <span className="font-mono">gh auth login</span>.
              </div>
            </div>
          )}
          {loading && (
            <div className="px-4 py-8 text-center text-sm text-nim-faint">Loading...</div>
          )}
          {!loading && bindings && bindings.length > 0 && items.length === 0 && !error && (
            <div className="px-4 py-8 text-center text-sm text-nim-faint">No items found.</div>
          )}
          {items.length > 0 && (
            <>
              <label className="flex items-center gap-2 px-4 py-1.5 border-b border-nim text-xs text-nim-muted sticky top-0 bg-nim">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                Select all ({items.length})
              </label>
              {items.map((item) => (
                <label
                  key={item.externalId}
                  className="flex items-start gap-2 px-4 py-1.5 hover:bg-nim-tertiary cursor-pointer border-b border-nim/40"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.has(item.externalId)}
                    onChange={() => toggle(item.externalId)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-nim truncate">{item.title}</div>
                    <div className="text-[10px] text-nim-faint font-mono">
                      {item.externalId} · {item.state}
                    </div>
                  </div>
                </label>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-nim shrink-0">
          <span className="text-xs text-nim-faint">
            {selected.size > 0 ? `${selected.size} selected` : ''}
            {progress ? ` · imported ${progress.done}/${progress.total}` : ''}
          </span>
          <div className="flex-1" />
          <button
            className="px-3 py-1 text-xs text-nim-muted border border-nim rounded hover:bg-nim-tertiary"
            onClick={onClose}
            disabled={importing}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1 text-xs font-medium text-white bg-[var(--nim-primary)] rounded hover:opacity-90 disabled:opacity-50"
            onClick={runImport}
            disabled={importing || selected.size === 0}
            data-testid="import-from-source-confirm"
          >
            {importing ? 'Importing...' : `Import ${selected.size || ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};
