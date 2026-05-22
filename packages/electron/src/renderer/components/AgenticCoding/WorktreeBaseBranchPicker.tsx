/**
 * WorktreeBaseBranchPicker - Centered modal for configuring a new worktree.
 *
 * Lets the user:
 * - Pick the base branch (local + cached remotes immediately; background
 *   `git:fetch` refreshes the list once new refs arrive).
 * - Optionally set the worktree name (leaves blank for server-side
 *   auto-generation). Branch will be `worktree/<name>`.
 *
 * If the background fetch fails, the cached list is kept and the failure
 * is logged silently (per #264 decision).
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface WorktreeBaseBranchPickerProps {
  isOpen: boolean;
  workspacePath: string;
  onCreate: (options: { baseBranch: string; name?: string }) => void;
  onCancel: () => void;
}

interface BranchSections {
  local: string[];
  remote: string[];
  current: string;
}

const EMPTY_SECTIONS: BranchSections = { local: [], remote: [], current: '' };
const REMOTE_PREFIX = 'remotes/';
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function partition(branches: string[], current: string): BranchSections {
  const local: string[] = [];
  const remote: string[] = [];
  for (const branch of branches) {
    if (branch.startsWith(REMOTE_PREFIX)) {
      remote.push(branch.slice(REMOTE_PREFIX.length));
    } else {
      local.push(branch);
    }
  }
  local.sort();
  remote.sort();
  return { local, remote, current };
}

async function fetchBranches(workspacePath: string): Promise<BranchSections> {
  if (!window.electronAPI) return EMPTY_SECTIONS;
  const result = (await window.electronAPI.invoke('git:branches', workspacePath)) as {
    branches: string[];
    current: string;
  };
  return partition(result.branches ?? [], result.current ?? '');
}

function validateName(name: string): string | null {
  if (!name) return null;
  if (name.length > 64) return 'Name is too long (max 64 chars).';
  if (!NAME_PATTERN.test(name)) {
    return 'Use letters, digits, dots, dashes, underscores or slashes.';
  }
  return null;
}

export function WorktreeBaseBranchPicker({
  isOpen,
  workspacePath,
  onCreate,
  onCancel,
}: WorktreeBaseBranchPickerProps) {
  const [sections, setSections] = useState<BranchSections>(EMPTY_SECTIONS);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingRemotes, setIsRefreshingRemotes] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [name, setName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setSections(EMPTY_SECTIONS);
    setIsLoading(true);
    setIsRefreshingRemotes(false);
    setLoadError(null);
    setSelectedBranch('');
    setName('');
  }, [isOpen]);

  // Load branches + background fetch.
  useEffect(() => {
    if (!isOpen) return;

    let alive = true;

    const loadInitial = async () => {
      try {
        const initial = await fetchBranches(workspacePath);
        if (!alive) return;
        setSections(initial);
        // Pre-select current branch as a sensible default.
        if (initial.current && initial.local.includes(initial.current)) {
          setSelectedBranch(initial.current);
        } else if (initial.local[0]) {
          setSelectedBranch(initial.local[0]);
        }
        setIsLoading(false);
      } catch (error) {
        if (!alive) return;
        setLoadError(error instanceof Error ? error.message : 'Failed to load branches');
        setIsLoading(false);
      }
    };

    const refreshRemotes = async () => {
      if (!window.electronAPI) return;
      setIsRefreshingRemotes(true);
      try {
        await window.electronAPI.invoke('git:fetch', workspacePath);
        if (!alive) return;
        const refreshed = await fetchBranches(workspacePath);
        if (!alive) return;
        setSections((prev) => ({ ...refreshed, current: refreshed.current || prev.current }));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[WorktreeBaseBranchPicker] git:fetch failed', error);
      } finally {
        if (alive) setIsRefreshingRemotes(false);
      }
    };

    void loadInitial();
    void refreshRemotes();

    return () => {
      alive = false;
    };
  }, [isOpen, workspacePath]);

  // Focus name input when modal opens (after initial load completes).
  useEffect(() => {
    if (!isOpen || isLoading) return;
    const t = setTimeout(() => nameInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [isOpen, isLoading]);

  // ESC to dismiss.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, onCancel]);

  const nameError = useMemo(() => validateName(name.trim()), [name]);
  const canSubmit = !isLoading && !loadError && Boolean(selectedBranch) && !nameError;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onCreate({
      baseBranch: selectedBranch,
      name: name.trim() ? name.trim() : undefined,
    });
  }, [canSubmit, name, onCreate, selectedBranch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && canSubmit) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [canSubmit, handleSubmit],
  );

  if (!isOpen) return null;

  const hasAnyBranch = sections.local.length > 0 || sections.remote.length > 0;
  const branchPreview = name.trim() ? `worktree/${name.trim()}` : 'worktree/<auto-generated>';

  return (
    <div
      className="worktree-base-branch-picker-overlay nim-overlay backdrop-blur-sm bg-black/60"
      onClick={onCancel}
      data-testid="worktree-base-branch-picker-overlay"
    >
      <div
        className="worktree-base-branch-picker-dialog nim-modal w-[92%] max-w-[520px] animate-[worktree-modal-appear_0.18s_ease] flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        data-testid="worktree-base-branch-picker"
        data-component="WorktreeBaseBranchPicker"
        role="dialog"
        aria-modal="true"
        aria-label="Create new worktree"
      >
        <div className="worktree-base-branch-picker-header px-6 pt-6 pb-4 border-b border-nim">
          <h2 className="m-0 text-[18px] font-semibold text-nim">Create new worktree</h2>
          <p className="m-0 mt-1 text-[13px] text-nim-muted">
            Pick a base branch and (optionally) a name for the new worktree.
          </p>
        </div>

        <div className="worktree-base-branch-picker-body flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-5">
          <div className="worktree-name-field flex flex-col gap-1.5">
            <label
              htmlFor="worktree-name-input"
              className="text-[12px] font-semibold text-nim uppercase tracking-wider"
            >
              Worktree name
            </label>
            <input
              id="worktree-name-input"
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Leave blank to auto-generate (e.g. swift-rabbit)"
              className="worktree-name-input px-3 py-2 text-[13px] rounded-md border border-nim bg-nim-secondary text-nim focus:outline-none focus:border-nim-primary"
              data-testid="worktree-name-input"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex items-center justify-between text-[11px] text-nim-muted gap-2">
              <span className="font-mono truncate" data-testid="worktree-branch-preview">
                Branch: {branchPreview}
              </span>
              {nameError && (
                <span className="text-[var(--nim-error)]" data-testid="worktree-name-error">
                  {nameError}
                </span>
              )}
            </div>
          </div>

          <div className="worktree-base-branch-field flex flex-col gap-1.5 min-h-[140px]">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-nim uppercase tracking-wider">
                Base branch
              </span>
              {isRefreshingRemotes && (
                <span
                  className="text-[11px] text-nim-muted italic"
                  data-testid="worktree-base-branch-refreshing"
                >
                  Refreshing remotes…
                </span>
              )}
            </div>

            {isLoading && (
              <div
                className="px-3 py-3 text-[12px] text-nim-muted"
                data-testid="worktree-base-branch-loading"
              >
                Loading branches…
              </div>
            )}

            {!isLoading && loadError && (
              <div className="px-3 py-3 text-[12px] text-[var(--nim-error)]">{loadError}</div>
            )}

            {!isLoading && !loadError && !hasAnyBranch && (
              <div className="px-3 py-3 text-[12px] text-nim-muted">No branches found.</div>
            )}

            {!isLoading && !loadError && hasAnyBranch && (
              <div
                className="worktree-base-branch-list flex flex-col gap-3 max-h-[44vh] overflow-y-auto rounded-md border border-nim bg-nim-secondary p-2"
                role="radiogroup"
                aria-label="Base branch"
              >
                {sections.local.length > 0 && (
                  <BranchSection
                    title="Local branches"
                    branches={sections.local}
                    current={sections.current}
                    selected={selectedBranch}
                    onSelect={setSelectedBranch}
                  />
                )}
                {sections.remote.length > 0 && (
                  <BranchSection
                    title="Remote branches"
                    branches={sections.remote}
                    current={sections.current}
                    selected={selectedBranch}
                    onSelect={setSelectedBranch}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="worktree-base-branch-picker-footer flex justify-end gap-3 px-6 py-4 border-t border-nim">
          <button
            type="button"
            className="worktree-base-branch-cancel nim-btn-secondary px-4 py-2 text-[13px] font-medium rounded-lg"
            data-testid="worktree-base-branch-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="worktree-base-branch-create nim-btn-primary px-5 py-2 text-[13px] font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="worktree-base-branch-create"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            Create Worktree
          </button>
        </div>
      </div>
    </div>
  );
}

interface BranchSectionProps {
  title: string;
  branches: string[];
  current: string;
  selected: string;
  onSelect: (branch: string) => void;
}

function BranchSection({ title, branches, current, selected, onSelect }: BranchSectionProps) {
  const sectionLabelId = `worktree-branch-section-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="worktree-base-branch-section" role="group" aria-labelledby={sectionLabelId}>
      <div
        id={sectionLabelId}
        className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-nim-faint"
      >
        {title}
      </div>
      <ul className="list-none m-0 p-0">
        {branches.map((branch) => {
          const isCurrent = branch === current;
          const isSelected = branch === selected;
          return (
            <li key={branch}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`worktree-base-branch-item flex items-center w-full px-2 py-1.5 text-left text-[12px] bg-transparent border-none cursor-pointer gap-2 rounded-sm ${
                  isSelected
                    ? 'bg-[var(--nim-primary)]/15 text-nim'
                    : 'text-nim hover:bg-nim-hover'
                }`}
                data-testid={`worktree-base-branch-item-${branch}`}
                onClick={() => onSelect(branch)}
              >
                <span className="flex-1 truncate font-mono text-[12px]">{branch}</span>
                {isCurrent && (
                  <span className="text-[10px] text-nim-muted" aria-label="current branch">
                    current
                  </span>
                )}
                {isSelected && (
                  <span className="text-[14px] leading-none text-nim-primary" aria-hidden="true">●</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
