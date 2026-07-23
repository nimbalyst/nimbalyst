/**
 * Nimbalyst Memory settings panel (live).
 *
 * The engine runs in a backend utility-process; this panel reaches it through
 * the renderer->backend READ bridge (`props.callBackendTool`, backed by the
 * `extensions:ai-call-backend-tool` IPC). It surfaces three things so a user can
 * understand what the memory actually holds:
 *   1. Coverage   — what's indexed (chunks by source class, embedder, freshness)
 *   2. Memories   — the curated durable facts (grouped, add/edit/delete)
 *   3. Try it     — a retrieval inspector that makes the embeddings legible by
 *                   showing what a query recalls, and which arm (semantic/keyword)
 *                   surfaced each hit.
 * When the bridge is absent (older host) it degrades to informational copy.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SettingsPanelProps } from '@nimbalyst/runtime';

interface IndexStatus {
  ready?: boolean;
  chunks?: number;
  denseChunks?: number;
  bySourceClass?: Record<string, number>;
  sourceFiles?: number;
  lastIndexedAt?: number | null;
  indexSizeBytes?: number;
  indexing?: boolean;
  lastEmbedError?: string | null;
  embedder?: { id?: string; model?: string; dims?: number } | null;
  retrieval?: {
    mode?: 'hybrid' | 'keyword-only';
    semantic?: { available?: boolean; reason?: string };
    keyword?: { available?: boolean; source?: string };
  };
  error?: string | null;
  root?: string;
}

interface FactRow {
  sourcePath: string;
  text: string;
  category?: string | null;
  scope?: string | null;
  priority?: number;
  mtime?: number;
}

interface FactCandidate {
  text: string;
  category?: string | null;
  scope?: string | null;
}

interface SearchHit {
  sourcePath: string;
  sourceClass?: string;
  headingPath?: string[];
  text: string;
  score: number;
  signals?: { dense: boolean; sparse: boolean };
}

/** Display label + accent for each known source class (coverage breakdown). */
const SOURCE_CLASS_META: Record<string, { label: string; color: string }> = {
  plans: { label: 'plans', color: '#a78bfa' },
  docs: { label: 'docs', color: '#4ade80' },
  design: { label: 'design', color: '#60a5fa' },
  facts: { label: 'voice-memory facts', color: '#f472b6' },
  claude: { label: 'CLAUDE.md', color: '#fbbf24' },
};
const FALLBACK_COLOR = '#808080';

function metaFor(cls: string): { label: string; color: string } {
  return SOURCE_CLASS_META[cls] ?? { label: cls, color: FALLBACK_COLOR };
}

function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function relativeTime(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

export function NimbalystMemorySettings({ theme, callBackendTool }: SettingsPanelProps) {
  const isDark = theme === 'dark' || theme === 'crystal-dark';
  const muted = 'var(--nim-text-muted)';

  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [facts, setFacts] = useState<FactRow[] | null>(null);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyFact, setBusyFact] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<FactCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [distilling, setDistilling] = useState(false);
  const [adding, setAdding] = useState(false);
  const [distillError, setDistillError] = useState<string | null>(null);
  const [distillNotice, setDistillNotice] = useState<string | null>(null);

  // Facts viewer: category filter + add/edit form.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [editor, setEditor] = useState<FactDraft | null>(null);
  const [savingFact, setSavingFact] = useState(false);

  // Query inspector.
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Quick Open: opt-in AI-session indexing (off by default). Persisted as an app
  // setting and read by the host's SemanticCatalogService.
  const [indexSessions, setIndexSessions] = useState(false);
  const [togglingSessions, setTogglingSessions] = useState(false);

  useEffect(() => {
    const api = (window as { electronAPI?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } })
      .electronAPI;
    if (!api?.invoke) return;
    void api
      .invoke('semantic-search:get-index-sessions')
      .then((v) => setIndexSessions(v === true))
      .catch(() => {});
  }, []);

  const toggleIndexSessions = useCallback(async (next: boolean) => {
    const api = (window as { electronAPI?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } })
      .electronAPI;
    if (!api?.invoke) return;
    setTogglingSessions(true);
    setIndexSessions(next); // optimistic
    try {
      await api.invoke('semantic-search:set-index-sessions', next);
    } catch {
      setIndexSessions(!next); // revert on failure
    } finally {
      setTogglingSessions(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!callBackendTool) return;
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const s = (await callBackendTool('memory.status')) as IndexStatus;
      setStatus(s);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStatus(false);
    }
  }, [callBackendTool]);

  const refreshFacts = useCallback(async () => {
    if (!callBackendTool) return;
    setFactsError(null);
    try {
      const res = (await callBackendTool('memory.list_facts', { limit: 500 })) as {
        facts?: FactRow[];
      };
      setFacts(Array.isArray(res?.facts) ? res.facts : []);
    } catch (err) {
      setFactsError(err instanceof Error ? err.message : String(err));
      setFacts([]);
    }
  }, [callBackendTool]);

  useEffect(() => {
    void refreshStatus();
    void refreshFacts();
  }, [refreshStatus, refreshFacts]);

  // Poll while an index pass is in flight so chunk counts tick up live.
  useEffect(() => {
    if (!status?.indexing) return;
    const id = setInterval(() => void refreshStatus(), 3000);
    return () => clearInterval(id);
  }, [status?.indexing, refreshStatus]);

  const rebuild = useCallback(async () => {
    if (!callBackendTool) return;
    setRebuilding(true);
    try {
      await callBackendTool('memory.rebuild');
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuilding(false);
      void refreshStatus();
      void refreshFacts();
    }
  }, [callBackendTool, refreshStatus, refreshFacts]);

  const deleteFact = useCallback(
    async (sourcePath: string) => {
      if (!callBackendTool) return;
      setBusyFact(sourcePath);
      try {
        await callBackendTool('memory.delete_fact', { sourcePath });
        await refreshFacts();
      } catch (err) {
        setFactsError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyFact(null);
        setConfirmDelete(null);
      }
    },
    [callBackendTool, refreshFacts]
  );

  // Save the add/edit form. `remember` is ADD-only, so an edit is delete + add:
  // we remember the new text first, then delete the old file only on success.
  const saveFact = useCallback(async () => {
    if (!callBackendTool || !editor) return;
    const text = editor.text.trim();
    if (!text) return;
    setSavingFact(true);
    setFactsError(null);
    try {
      await callBackendTool('memory.remember', {
        text,
        category: editor.category.trim() || undefined,
        scope: editor.scope.trim() || undefined,
        priority: Number.isFinite(editor.priority) ? editor.priority : 0,
      });
      if (editor.replacingPath) {
        await callBackendTool('memory.delete_fact', { sourcePath: editor.replacingPath });
      }
      setEditor(null);
      await refreshFacts();
    } catch (err) {
      setFactsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingFact(false);
    }
  }, [callBackendTool, editor, refreshFacts]);

  const suggestFacts = useCallback(async () => {
    if (!callBackendTool) return;
    setDistilling(true);
    setDistillError(null);
    setDistillNotice(null);
    setCandidates(null);
    try {
      const res = (await callBackendTool('memory.distill_candidate_facts', {
        sourceClass: 'plans',
        maxDocs: 3,
      })) as {
        candidates?: FactCandidate[];
        capability?: { available?: boolean; reason?: string };
        fallback?: { hint?: string };
      };
      if (res?.capability?.available === false) {
        setDistillNotice(
          res.fallback?.hint ?? 'Add durable facts manually with the Add fact action.',
        );
        return;
      }
      const list = Array.isArray(res?.candidates) ? res.candidates : [];
      setCandidates(list);
      setSelected(new Set(list.map((_, i) => i)));
    } catch (err) {
      setDistillError(err instanceof Error ? err.message : String(err));
    } finally {
      setDistilling(false);
    }
  }, [callBackendTool]);

  const addSelected = useCallback(async () => {
    if (!callBackendTool || !candidates) return;
    setAdding(true);
    try {
      for (let i = 0; i < candidates.length; i++) {
        if (!selected.has(i)) continue;
        const c = candidates[i];
        await callBackendTool('memory.remember', {
          text: c.text,
          category: c.category ?? undefined,
          scope: c.scope ?? undefined,
        });
      }
      setCandidates(null);
      setSelected(new Set());
      await refreshFacts();
    } catch (err) {
      setDistillError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [callBackendTool, candidates, selected, refreshFacts]);

  const toggleCandidate = useCallback((i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const runSearch = useCallback(async () => {
    if (!callBackendTool) return;
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = (await callBackendTool('memory.search_project_knowledge', {
        query: q,
        k: 6,
      })) as { chunks?: SearchHit[] };
      setHits(Array.isArray(res?.chunks) ? res.chunks : []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [callBackendTool, query]);

  // --- Derived ------------------------------------------------------------

  const bySourceClass = status?.bySourceClass ?? {};
  const totalChunks = status?.chunks ?? 0;
  const coverage =
    totalChunks > 0 ? Math.round(((status?.denseChunks ?? 0) / totalChunks) * 100) : 0;
  const keywordOnly =
    status?.retrieval?.mode === 'keyword-only' ||
    status?.retrieval?.semantic?.available === false ||
    Boolean(status?.lastEmbedError);
  const breakdown = useMemo(
    () =>
      Object.entries(bySourceClass)
        .map(([cls, n]) => ({ cls, n, ...metaFor(cls) }))
        .sort((a, b) => b.n - a.n),
    [bySourceClass]
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const f of facts ?? []) if (f.category) set.add(f.category);
    return Array.from(set).sort();
  }, [facts]);

  const groupedFacts = useMemo(() => {
    const list = (facts ?? []).filter(
      (f) => !categoryFilter || f.category === categoryFilter
    );
    const groups = new Map<string, FactRow[]>();
    for (const f of list) {
      const key = f.category ?? 'uncategorized';
      const arr = groups.get(key) ?? [];
      arr.push(f);
      groups.set(key, arr);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [facts, categoryFilter]);

  return (
    <div
      className="nimbalyst-memory-settings select-text"
      style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: 4, fontSize: 13 }}
    >
      <section style={SECTION}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Project knowledge</h3>
        <p style={{ margin: 0, color: muted, lineHeight: 1.5 }}>
          A local "project brain" that indexes your markdown into a rebuildable
          shadow index and serves fast local keyword retrieval to the coding
          agent and the voice agent. Semantic matching is added when an optional
          provider is already available. The engine runs in the background and
          refreshes as files change.
        </p>
      </section>

      {!callBackendTool && (
        <p style={{ margin: 0, color: muted, lineHeight: 1.5 }}>
          Live status is unavailable in this version of the host.
        </p>
      )}

      {/* ---------------- QUICK OPEN ---------------- */}
      <section style={SECTION}>
        <h4 style={H4}>Global search</h4>
        <p style={{ margin: 0, color: muted, lineHeight: 1.5 }}>
          With this extension enabled, Quick Open gains a <strong>Search</strong>{' '}
          tab that finds trackers and documents by project terms, and by meaning
          when semantic matching is available. Trackers are cataloged automatically.
        </p>
        <label
          style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', lineHeight: 1.45 }}
        >
          <input
            type="checkbox"
            checked={indexSessions}
            disabled={togglingSessions}
            onChange={(e) => void toggleIndexSessions(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <span style={{ color: 'var(--nim-text)' }}>Also index AI sessions</span>
            <span style={{ display: 'block', color: muted, fontSize: 12 }}>
              Makes past sessions findable by their titles, prompts, and replies
              (not the full transcript). Off by default. Toggling on indexes your
              existing sessions in the background.
            </span>
          </span>
        </label>
      </section>

      {/* ---------------- 1. COVERAGE ---------------- */}
      <section style={SECTION}>
        <div style={HEAD}>
          <h4 style={H4}>
            Coverage
            {status && status.ready !== false && (
              <span style={chipTone(status.indexing ? 'idle' : 'ok')}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: status.indexing ? 'var(--nim-text-muted)' : '#4ade80',
                  }}
                />
                {status.indexing ? 'Indexing…' : 'Ready'}
              </span>
            )}
          </h4>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => void refreshStatus()}
              disabled={!callBackendTool || loadingStatus}
              className="nimbalyst-memory-refresh"
              style={btnStyle(isDark)}
            >
              {loadingStatus ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => void rebuild()}
              disabled={!callBackendTool || rebuilding || status?.indexing}
              className="nimbalyst-memory-rebuild"
              style={btnStyle(isDark)}
            >
              {rebuilding ? 'Rebuilding…' : 'Rebuild'}
            </button>
          </div>
        </div>

        {statusError && <p style={ERR}>{statusError}</p>}

        {status && status.ready === false && (
          <p style={{ margin: 0, color: muted }}>
            The local project index is unavailable. Use normal workspace file/text
            search over project Markdown.
          </p>
        )}

        {status && status.ready !== false && (
          <div style={CARD}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Stat value={totalChunks.toLocaleString()} label="chunks indexed" />
              <Stat
                value={keywordOnly ? 'Unavailable' : `${coverage}`}
                unit={keywordOnly ? undefined : '%'}
                label={keywordOnly ? 'semantic matching' : 'embedding coverage'}
              />
              <Stat value={`${status.sourceFiles ?? 0}`} label="source files" />
            </div>

            {breakdown.length > 0 && (
              <div>
                <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--nim-bg-tertiary)' }}>
                  {breakdown.map((b) => (
                    <span
                      key={b.cls}
                      title={`${b.label}: ${b.n}`}
                      style={{ width: `${(b.n / totalChunks) * 100}%`, background: b.color }}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: 10 }}>
                  {breakdown.map((b) => (
                    <span key={b.cls} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: b.color }} />
                      {b.label} <span style={{ color: 'var(--nim-text-muted)' }}>{b.n.toLocaleString()}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={DIVIDER} />

            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', margin: 0, fontSize: 12 }}>
              <dt style={{ color: 'var(--nim-text-muted)' }}>Retrieval</dt>
              <dd style={{ margin: 0 }}>
                {keywordOnly ? (
                  'Local keyword search'
                ) : (
                  <>
                    <code>
                      {status.embedder?.id ?? 'unknown'} · {status.embedder?.model ?? '—'}
                    </code>
                    {status.embedder?.dims ? ` · ${status.embedder.dims}d` : ''}
                  </>
                )}
              </dd>
              <dt style={{ color: 'var(--nim-text-muted)' }}>Last indexed</dt>
              <dd style={{ margin: 0 }}>
                {relativeTime(status.lastIndexedAt)} · auto-refreshes on file change
              </dd>
              <dt style={{ color: 'var(--nim-text-muted)' }}>Index size</dt>
              <dd style={{ margin: 0 }}>
                {formatBytes(status.indexSizeBytes)}{' '}
                <span style={{ color: 'var(--nim-text-muted)' }}>(rebuildable)</span>
              </dd>
            </dl>

            {keywordOnly && (
              <p style={{ margin: 0, color: 'var(--nim-warning, #d19a66)', lineHeight: 1.5 }}>
                Local keyword search is active. Semantic matching is unavailable.
              </p>
            )}
          </div>
        )}
      </section>

      <div style={DIVIDER} />

      {/* ---------------- 2. MEMORIES ---------------- */}
      <section style={SECTION}>
        <div style={HEAD}>
          <h4 style={H4}>
            Memories
            {facts && <span style={chipTone('plain')}>{facts.length} facts</span>}
          </h4>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => void suggestFacts()}
              disabled={!callBackendTool || distilling}
              className="nimbalyst-memory-suggest"
              style={btnStyle(isDark)}
              title="Use an LLM to propose facts from your recent plans/decisions"
            >
              {distilling ? 'Suggesting…' : 'Suggest from decisions'}
            </button>
            <button
              type="button"
              onClick={() =>
                setEditor({ text: '', category: '', scope: '', priority: 0, replacingPath: null })
              }
              disabled={!callBackendTool}
              className="nimbalyst-memory-add"
              style={btnPrimary}
            >
              + Add fact
            </button>
          </div>
        </div>
        <p style={{ margin: 0, color: muted, lineHeight: 1.5 }}>
          The durable facts the agent remembers (the{' '}
          <code>nimbalyst-local/voice-memory/</code> markdown tree). Highest
          priority first within each category.
        </p>

        {distillError && <p style={ERR}>{distillError}</p>}
        {distillNotice && (
          <p style={{ margin: 0, color: muted, lineHeight: 1.5 }}>{distillNotice}</p>
        )}
        {factsError && <p style={ERR}>{factsError}</p>}

        {/* Add / edit form */}
        {editor && (
          <div style={{ ...CARD, gap: 8 }}>
            <textarea
              value={editor.text}
              onChange={(e) => setEditor({ ...editor, text: e.target.value })}
              placeholder="A durable fact to remember…"
              rows={2}
              style={INPUT}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={editor.category}
                onChange={(e) => setEditor({ ...editor, category: e.target.value })}
                placeholder="category"
                style={{ ...INPUT, flex: 1, minWidth: 120 }}
              />
              <input
                value={editor.scope}
                onChange={(e) => setEditor({ ...editor, scope: e.target.value })}
                placeholder="scope (e.g. global, project)"
                style={{ ...INPUT, flex: 1, minWidth: 120 }}
              />
              <input
                type="number"
                value={editor.priority}
                onChange={(e) => setEditor({ ...editor, priority: Number(e.target.value) })}
                placeholder="priority"
                style={{ ...INPUT, width: 90 }}
                title="Higher = injected earlier into the agent context"
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => void saveFact()}
                disabled={savingFact || !editor.text.trim()}
                style={btnPrimary}
              >
                {savingFact ? 'Saving…' : editor.replacingPath ? 'Save changes' : 'Add fact'}
              </button>
              <button type="button" onClick={() => setEditor(null)} style={btnStyle(isDark)}>
                Cancel
              </button>
              {editor.replacingPath && (
                <span style={{ alignSelf: 'center', color: muted, fontSize: 11 }}>
                  Editing replaces the existing fact file.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Auto-distilled candidates awaiting confirmation (ADD-only). */}
        {candidates && (
          <div style={{ ...CARD, gap: 8 }}>
            {candidates.length === 0 ? (
              <span style={{ color: muted, fontStyle: 'italic' }}>
                No new facts found in your recent decisions.
              </span>
            ) : (
              <>
                <span style={{ color: muted }}>
                  Proposed facts from your recent plans/decisions — pick the ones to keep:
                </span>
                {candidates.map((c, i) => (
                  <label
                    key={`${i}-${c.text.slice(0, 24)}`}
                    style={{ display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.4 }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggleCandidate(i)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      {c.text}
                      {c.category && <span style={{ ...badge('cat'), marginLeft: 6 }}>{c.category}</span>}
                    </span>
                  </label>
                ))}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => void addSelected()}
                    disabled={adding || selected.size === 0}
                    style={btnStyle(isDark)}
                  >
                    {adding ? 'Adding…' : `Add ${selected.size} selected`}
                  </button>
                  <button type="button" onClick={() => setCandidates(null)} style={btnStyle(isDark)}>
                    Dismiss
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Category filter pills */}
        {categories.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Pill active={categoryFilter === null} onClick={() => setCategoryFilter(null)}>
              All
            </Pill>
            {categories.map((c) => (
              <Pill key={c} active={categoryFilter === c} onClick={() => setCategoryFilter(c)}>
                {c}
              </Pill>
            ))}
          </div>
        )}

        {facts && facts.length === 0 && (
          <p style={{ margin: 0, color: muted, fontStyle: 'italic' }}>
            No facts stored yet — the agent will add them as you work, or add one above.
          </p>
        )}

        {groupedFacts.map(([category, rows]) => (
          <div key={category} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={GROUP_LABEL}>
              {category}
              <span style={GROUP_COUNT}>{rows.length}</span>
            </div>
            {rows
              .slice()
              .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.mtime ?? 0) - (a.mtime ?? 0))
              .map((f) => (
                <div key={f.sourcePath} style={{ ...CARD, gap: 7, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ lineHeight: 1.45, color: 'var(--nim-text)' }}>{f.text}</div>
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                      <button
                        type="button"
                        title="Edit"
                        onClick={() =>
                          setEditor({
                            text: f.text,
                            category: f.category ?? '',
                            scope: f.scope ?? '',
                            priority: f.priority ?? 0,
                            replacingPath: f.sourcePath,
                          })
                        }
                        style={iconBtn}
                      >
                        ✎
                      </button>
                      {confirmDelete === f.sourcePath ? null : (
                        <button
                          type="button"
                          title="Delete"
                          onClick={() => setConfirmDelete(f.sourcePath)}
                          style={iconBtn}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {f.scope && <span style={badge('scope')}>{f.scope}</span>}
                    {typeof f.priority === 'number' && f.priority !== 0 && (
                      <span style={badge(f.priority >= 8 ? 'prioHigh' : 'prioMed')}>
                        priority {f.priority}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', color: 'var(--nim-text-muted)', fontSize: 11 }}>
                      <code style={{ color: 'var(--nim-text-muted)' }}>{f.sourcePath.replace(/^.*\//, '')}</code>
                      {f.mtime ? ` · ${relativeTime(f.mtime)}` : ''}
                    </span>
                  </div>
                  {confirmDelete === f.sourcePath && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: muted, fontSize: 12 }}>Delete this fact?</span>
                      <button
                        type="button"
                        onClick={() => void deleteFact(f.sourcePath)}
                        disabled={busyFact === f.sourcePath}
                        style={{ ...btnStyle(isDark), color: 'var(--nim-error, #e06c75)' }}
                      >
                        {busyFact === f.sourcePath ? 'Deleting…' : 'Confirm'}
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)} style={btnStyle(isDark)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
          </div>
        ))}
      </section>

      <div style={DIVIDER} />

      {/* ---------------- 3. TRY YOUR MEMORY ---------------- */}
      <section style={SECTION}>
        <h4 style={H4}>Try your memory</h4>
        <p style={{ margin: 0, color: 'var(--nim-text-muted)', fontSize: 12 }}>
          Ask what the agent would ask. See exactly what gets recalled, and which
          signal — semantic (embeddings) or keyword — surfaced it.
        </p>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            placeholder="how do extensions store their own data?"
            disabled={!callBackendTool}
            className="nimbalyst-memory-query"
            style={{ ...INPUT, flex: 1 }}
          />
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={!callBackendTool || searching || !query.trim()}
            style={btnPrimary}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {searchError && <p style={ERR}>{searchError}</p>}

        {hits && hits.length === 0 && !searching && (
          <p style={{ margin: 0, color: muted, fontStyle: 'italic' }}>No matches.</p>
        )}

        {hits && hits.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hits.map((h, i) => {
              const sig = signalLabel(h.signals);
              return (
                <div key={`${h.sourcePath}-${i}`} style={{ ...CARD, gap: 6, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={SCORE}>{h.score.toFixed(2)}</span>
                    <span style={{ fontSize: 11, color: 'var(--nim-text-muted)', display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
                      <span style={{ color: 'var(--nim-link)', whiteSpace: 'nowrap' }}>
                        {h.sourcePath.replace(/^.*\//, '')}
                      </span>
                      {(h.headingPath ?? []).map((seg, j) => (
                        <span key={j} style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ opacity: 0.5 }}> › </span>
                          {seg}
                        </span>
                      ))}
                    </span>
                    {sig && <span style={{ ...signalStyle(sig.tone), marginLeft: 'auto' }}>{sig.text}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--nim-text-muted)', lineHeight: 1.5 }}>
                    {h.text.length > 320 ? `${h.text.slice(0, 320)}…` : h.text}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// --- small presentational helpers ----------------------------------------

interface FactDraft {
  text: string;
  category: string;
  scope: string;
  priority: number;
  /** When set, saving deletes this old fact after writing the new one. */
  replacingPath: string | null;
}

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 20, fontWeight: 650, color: 'var(--nim-text)', lineHeight: 1.1 }}>
        {value}
        {unit && <small style={{ fontSize: 12, fontWeight: 500, color: 'var(--nim-text-muted)' }}>{unit}</small>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--nim-text-muted)' }}>{label}</div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: '3px 9px',
        borderRadius: 999,
        cursor: 'pointer',
        border: `1px solid ${active ? 'rgba(96,165,250,0.4)' : 'transparent'}`,
        background: active ? 'var(--nim-bg-selected)' : 'var(--nim-bg-tertiary)',
        color: active ? 'var(--nim-link)' : 'var(--nim-text-muted)',
      }}
    >
      {children}
    </button>
  );
}

function signalLabel(signals?: { dense: boolean; sparse: boolean }) {
  if (!signals) return null;
  if (signals.dense && signals.sparse) return { text: 'semantic + keyword', tone: 'both' as const };
  if (signals.dense) return { text: 'semantic', tone: 'semantic' as const };
  if (signals.sparse) return { text: 'keyword', tone: 'keyword' as const };
  return null;
}

// --- style constants ------------------------------------------------------

const SECTION = { display: 'flex', flexDirection: 'column' as const, gap: 10 };
const HEAD = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const H4 = { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--nim-text)', display: 'flex', alignItems: 'center', gap: 8 } as const;
const DIVIDER = { height: 1, background: 'var(--nim-border)', margin: 0 };
const CARD = {
  background: 'var(--nim-bg-secondary)',
  border: '1px solid var(--nim-border)',
  borderRadius: 8,
  padding: 14,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 14,
};
const ERR = { margin: 0, color: 'var(--nim-error, #e06c75)', lineHeight: 1.5 };
const GROUP_LABEL = {
  fontSize: 11,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
  color: 'var(--nim-text-muted)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 2,
};
const GROUP_COUNT = { background: 'var(--nim-bg-tertiary)', borderRadius: 999, padding: '0 6px', fontSize: 10 };
const INPUT = {
  background: 'var(--nim-bg, #1a1a1a)',
  border: '1px solid var(--nim-border)',
  borderRadius: 7,
  padding: '8px 11px',
  color: 'var(--nim-text)',
  fontSize: 13,
  fontFamily: 'inherit',
  resize: 'vertical' as const,
};
const SCORE = {
  fontVariantNumeric: 'tabular-nums' as const,
  fontWeight: 650,
  color: 'var(--nim-text)',
  fontSize: 12,
  background: 'var(--nim-bg-tertiary)',
  borderRadius: 5,
  padding: '1px 7px',
};
const iconBtn = {
  background: 'transparent',
  border: 0,
  color: 'var(--nim-text-muted)',
  cursor: 'pointer',
  padding: '2px 4px',
  borderRadius: 4,
  fontSize: 13,
} as const;

function chipTone(tone: 'ok' | 'idle' | 'plain') {
  const base = { fontSize: 11, padding: '1px 7px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4 };
  if (tone === 'ok') return { ...base, background: 'rgba(74,222,128,0.16)', color: '#86efac' };
  if (tone === 'idle') return { ...base, background: 'var(--nim-bg-tertiary)', color: 'var(--nim-text-muted)' };
  return { ...base, background: 'var(--nim-bg-tertiary)', color: 'var(--nim-text-muted)' };
}

function badge(kind: 'scope' | 'prioHigh' | 'prioMed' | 'cat') {
  const base = { fontSize: 10.5, padding: '1px 6px', borderRadius: 4, fontWeight: 500 as const };
  switch (kind) {
    case 'scope':
      return { ...base, background: 'rgba(167,139,250,0.15)', color: '#a78bfa' };
    case 'prioHigh':
      return { ...base, background: 'rgba(239,68,68,0.15)', color: '#fca5a5' };
    case 'prioMed':
      return { ...base, background: 'rgba(251,191,36,0.15)', color: '#fbbf24' };
    default:
      return { ...base, background: 'var(--nim-bg-tertiary)', color: 'var(--nim-text-muted)' };
  }
}

function signalStyle(tone: 'semantic' | 'keyword' | 'both') {
  const base = { fontSize: 10, padding: '1px 7px', borderRadius: 4, flexShrink: 0 };
  if (tone === 'semantic') return { ...base, background: 'rgba(96,165,250,0.16)', color: '#60a5fa' };
  if (tone === 'keyword') return { ...base, background: 'rgba(74,222,128,0.16)', color: '#86efac' };
  return { ...base, background: 'rgba(167,139,250,0.16)', color: '#a78bfa' };
}

function btnStyle(_isDark: boolean) {
  return {
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid var(--nim-border)',
    background: 'var(--nim-bg-tertiary)',
    color: 'var(--nim-text-muted)',
    cursor: 'pointer',
  } as const;
}

const btnPrimary = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--nim-primary)',
  background: 'var(--nim-primary)',
  color: '#fff',
  cursor: 'pointer',
} as const;
