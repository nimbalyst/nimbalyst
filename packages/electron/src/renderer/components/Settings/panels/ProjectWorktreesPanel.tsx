/**
 * Project Settings > Worktrees: which branch a new worktree starts from when
 * the caller does not pick one (#1958).
 *
 * The setting is stored per project on WorkspaceState.worktreeDefaultBase and
 * read by the main-process resolver (services/worktreeBaseBranch.ts) inside
 * worktree creation, so every entry point without its own base uses it. The
 * worktree picker pre-selects it; PR review worktrees always use the PR head.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

type Mode = 'remote-default' | 'current-branch' | 'custom';

interface Setting {
  mode: Mode;
  ref?: string;
}

interface Resolved {
  ref: string;
  source: 'project-setting' | 'remote-default' | 'current-branch' | 'fallback';
  fallbackReason?: string;
}

type ResolveResult =
  | { success: true; setting: Setting | null; resolved: Resolved; remoteDefault: Resolved; currentBranch: string | null }
  | { success: false; setting: Setting | null; error?: string };

const REMOTE_PREFIX = 'remotes/';

interface ProjectWorktreesPanelProps {
  workspacePath: string;
  workspaceName: string;
}

export function ProjectWorktreesPanel({ workspacePath, workspaceName }: ProjectWorktreesPanelProps) {
  const [info, setInfo] = useState<ResolveResult | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  // The radio can sit on 'custom' before a branch is chosen; nothing is saved
  // until one is.
  const [mode, setMode] = useState<Mode>('remote-default');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [resolved, branchList] = await Promise.all([
      window.electronAPI.invoke('worktree:resolve-default-base', workspacePath) as Promise<ResolveResult>,
      window.electronAPI.invoke('git:branches', workspacePath).catch(() => ({ branches: [] })) as Promise<{ branches?: string[] }>,
    ]);
    setInfo(resolved);
    setMode(resolved.setting?.mode ?? 'remote-default');
    // `git branch -a` lists remotes as `remotes/origin/x`; refs are `origin/x`.
    const refs = (branchList.branches ?? [])
      .map((b) => (b.startsWith(REMOTE_PREFIX) ? b.slice(REMOTE_PREFIX.length) : b))
      .filter((b) => !b.endsWith('/HEAD'));
    setBranches([...new Set(refs)].sort());
  }, [workspacePath]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const save = useCallback(async (setting: Setting | null) => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.invoke('worktree:set-default-base', workspacePath, setting);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [load, workspacePath]);

  const chooseMode = (next: Mode) => {
    setMode(next);
    if (next === 'remote-default') void save(null);
    else if (next === 'current-branch') void save({ mode: 'current-branch' });
    // 'custom' waits for a branch.
  };

  const savedRef = info?.setting?.mode === 'custom' ? info.setting.ref ?? '' : '';
  const q = query.trim().toLowerCase();
  const visibleBranches = useMemo(
    () => (q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches).slice(0, 200),
    [branches, q],
  );

  const resolved = info?.success ? info : null;
  const remoteDefaultLabel = resolved
    ? resolved.remoteDefault.source === 'remote-default'
      ? resolved.remoteDefault.ref
      : `${resolved.remoteDefault.ref || 'none'} (${resolved.remoteDefault.fallbackReason ?? 'fallback'})`
    : '';

  const optionClass = (selected: boolean) =>
    `worktrees-default-base-option flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${
      selected ? 'border-[var(--nim-primary)] bg-[var(--nim-bg-secondary)]' : 'border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]'
    }`;

  return (
    <div className="project-worktrees-panel settings-panel-content flex flex-col p-6 gap-6" data-testid="project-worktrees-panel">
      <div className="settings-panel-header">
        <h2 className="m-0 mb-2 text-lg font-semibold text-[var(--nim-text)]">Worktrees</h2>
        <p className="m-0 text-[13px] text-[var(--nim-text-muted)] leading-normal">
          The branch new worktrees in <strong className="text-[var(--nim-text)] font-medium">{workspaceName}</strong> start
          from when none is picked. New worktree branches never track the base branch.
        </p>
      </div>

      {info && !info.success && (
        <div className="text-[13px] text-[var(--nim-text-muted)] select-text">
          Could not read this project's branches: {info.error ?? 'unknown error'}
        </div>
      )}

      <fieldset className="worktrees-default-base flex flex-col gap-2 border-none p-0 m-0" disabled={saving || !info}>
        <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--nim-text)]">Default base branch</legend>

        <label className={optionClass(mode === 'remote-default')}>
          <input type="radio" name="worktree-default-base" checked={mode === 'remote-default'} onChange={() => chooseMode('remote-default')} data-testid="worktrees-mode-remote-default" />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-[var(--nim-text)]">Remote default branch</span>
            <span className="text-xs text-[var(--nim-text-muted)] font-mono select-text">{remoteDefaultLabel}</span>
          </span>
        </label>

        <label className={optionClass(mode === 'current-branch')}>
          <input type="radio" name="worktree-default-base" checked={mode === 'current-branch'} onChange={() => chooseMode('current-branch')} data-testid="worktrees-mode-current-branch" />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-[var(--nim-text)]">Main checkout's current branch</span>
            <span className="text-xs text-[var(--nim-text-muted)] font-mono select-text">{resolved?.currentBranch ?? ''}</span>
          </span>
        </label>

        <label className={optionClass(mode === 'custom')}>
          <input type="radio" name="worktree-default-base" checked={mode === 'custom'} onChange={() => chooseMode('custom')} data-testid="worktrees-mode-custom" />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-[var(--nim-text)]">Specific branch</span>
            <span className="text-xs text-[var(--nim-text-muted)] font-mono select-text">{savedRef || 'Choose a branch below'}</span>
          </span>
        </label>

        {mode === 'custom' && (
          <div className="worktrees-custom-branch flex flex-col gap-2 pl-8">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search local and remote branches"
              aria-label="Search branches"
              className="px-3 py-1.5 text-[13px] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] focus:outline-none focus:border-[var(--nim-primary)]"
              data-testid="worktrees-custom-search"
            />
            <ul className="list-none m-0 p-1 max-h-[240px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]" role="listbox" aria-label="Branches">
              {visibleBranches.map((branch) => (
                <li key={branch}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={branch === savedRef}
                    onClick={() => void save({ mode: 'custom', ref: branch })}
                    className={`w-full text-left px-2 py-1 text-[12px] font-mono rounded-sm border-none cursor-pointer ${
                      branch === savedRef ? 'bg-[var(--nim-primary)]/15 text-[var(--nim-text)]' : 'bg-transparent text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
                    }`}
                  >
                    {branch}
                  </button>
                </li>
              ))}
              {visibleBranches.length === 0 && (
                <li className="px-2 py-1 text-[12px] text-[var(--nim-text-muted)]">No branches match.</li>
              )}
            </ul>
          </div>
        )}
      </fieldset>

      {resolved && (
        <div className="worktrees-effective text-[13px] text-[var(--nim-text-muted)] select-text" data-testid="worktrees-effective-base">
          New worktrees start from <span className="font-mono text-[var(--nim-text)]">{resolved.resolved.ref || 'nothing (no commits yet)'}</span>
          {resolved.resolved.source === 'fallback' && resolved.resolved.fallbackReason ? ` (${resolved.resolved.fallbackReason})` : ''}.
        </div>
      )}

      {error && <div className="text-[13px] text-[var(--nim-error)] select-text" role="alert">{error}</div>}

      <p className="m-0 text-[12px] text-[var(--nim-text-faint)] leading-normal">
        Used by new worktree sessions from the worktree picker (pre-selected there), agent-spawned sessions, mobile, Blitz,
        Super Loop and tips. A remote branch is fetched once before creating; if the fetch fails, the cached ref is used.
        Pull request review worktrees always start from the pull request.
      </p>
    </div>
  );
}
