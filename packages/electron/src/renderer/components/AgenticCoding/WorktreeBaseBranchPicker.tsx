/**
 * WorktreeBaseBranchPicker - Centered modal for configuring a new worktree.
 *
 * Lets the user:
 * - Pick the base branch (local + cached remotes immediately; background
 *   `git:fetch` refreshes the list once new refs arrive).
 * - Optionally set the worktree name (leaves blank for server-side
 *   auto-generation). Branch will be `worktree/<name>`.
 *
 * The modal stays mounted until the create call resolves, so any
 * server-side validation error can be surfaced inline without
 * losing the user's input. Buttons disable and the primary action
 * shows a spinner while the request is in flight.
 *
 * Any background work (initial branch load, `git:fetch` + remote
 * refresh) is tied to a per-open lifecycle: closing the modal
 * (cancel, ESC, overlay click, successful creation) marks it
 * cancelled so stale responses are dropped.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface WorktreeBaseBranchPickerProps {
  isOpen: boolean;
  workspacePath: string;
  initialName?: string;
  onCreate: (options: { baseBranch: string; name?: string }) => Promise<void>;
  onCancel: () => void;
}

interface BranchSections {
  local: string[];
  remote: string[];
  current: string;
}

const EMPTY_SECTIONS: BranchSections = { local: [], remote: [], current: '' };
const REMOTE_PREFIX = 'remotes/';

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

/**
 * Validate the user's worktree-name input against git's refname rules
 * (https://git-scm.com/docs/git-check-ref-format).
 *
 * The branch is created as `worktree/<name>`, so `<name>` must be valid
 * as one or more path components under that prefix. Empty is allowed —
 * the server auto-generates a name in that case.
 */
function validateName(name: string): string | null {
  if (!name) return null;
  if (name.length > 64) return 'Name is too long (max 64 chars).';

  if (name.startsWith('/')) return 'Name cannot start with "/".';
  if (name.endsWith('/')) return 'Name cannot end with "/".';
  if (name.startsWith('.')) return 'Name cannot start with ".".';
  if (name.endsWith('.')) return 'Name cannot end with ".".';
  if (name.startsWith('-')) return 'Name cannot start with "-".';

  if (name.endsWith('.lock')) return 'Name cannot end with ".lock".';

  if (name.includes('..')) return 'Name cannot contain "..".';
  if (name.includes('//')) return 'Name cannot contain "//".';
  if (name.includes('@{')) return 'Name cannot contain "@{".';

  // ASCII control chars, space, and git's forbidden refname chars.
  // eslint-disable-next-line no-control-regex
  const forbiddenChar = /[\x00-\x1f\x7f \t~^:?*[\\]/;
  if (forbiddenChar.test(name)) {
    return 'Name cannot contain spaces or any of: ~ ^ : ? * [ \\';
  }

  // Each path component must not be empty (covered by // check) and
  // must not start/end with forbidden boundary chars individually.
  for (const segment of name.split('/')) {
    if (segment.startsWith('.')) return 'Path components cannot start with ".".';
    if (segment.endsWith('.lock')) return 'Path components cannot end with ".lock".';
  }

  return null;
}

export function WorktreeBaseBranchPicker({
  isOpen,
  workspacePath,
  initialName,
  onCreate,
  onCancel,
}: WorktreeBaseBranchPickerProps) {
  const [sections, setSections] = useState<BranchSections>(EMPTY_SECTIONS);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingRemotes, setIsRefreshingRemotes] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [name, setName] = useState(initialName ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Lifecycle flag shared across the open session. Set to false on
  // unmount, cancel, or successful create so any in-flight `git:branches`
  // / `git:fetch` results are discarded instead of mutating state after
  // the modal has closed.
  const aliveRef = useRef(true);

  const stopBackgroundWork = useCallback(() => {
    aliveRef.current = false;
    setIsRefreshingRemotes(false);
  }, []);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    aliveRef.current = true;
    setSections(EMPTY_SECTIONS);
    setIsLoading(true);
    setIsRefreshingRemotes(false);
    setLoadError(null);
    setSelectedBranch('');
    setName(initialName ?? '');
    setIsSubmitting(false);
    setSubmitError(null);
  }, [initialName, isOpen]);

  // Load branches + background fetch.
  useEffect(() => {
    if (!isOpen) return;

    const loadInitial = async () => {
      try {
        const initial = await fetchBranches(workspacePath);
        if (!aliveRef.current) return;
        setSections(initial);
        // Pre-select current branch as a sensible default.
        if (initial.current && initial.local.includes(initial.current)) {
          setSelectedBranch(initial.current);
        } else if (initial.local[0]) {
          setSelectedBranch(initial.local[0]);
        }
        setIsLoading(false);
      } catch (error) {
        if (!aliveRef.current) return;
        setLoadError(error instanceof Error ? error.message : 'Failed to load branches');
        setIsLoading(false);
      }
    };

    const refreshRemotes = async () => {
      if (!window.electronAPI) return;
      setIsRefreshingRemotes(true);
      try {
        await window.electronAPI.invoke('git:fetch', workspacePath);
        if (!aliveRef.current) return;
        const refreshed = await fetchBranches(workspacePath);
        if (!aliveRef.current) return;
        setSections((prev) => ({ ...refreshed, current: refreshed.current || prev.current }));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[WorktreeBaseBranchPicker] git:fetch failed', error);
      } finally {
        if (aliveRef.current) setIsRefreshingRemotes(false);
      }
    };

    void loadInitial();
    void refreshRemotes();

    return () => {
      aliveRef.current = false;
    };
  }, [isOpen, workspacePath]);

  // Focus name input when modal opens (after initial load completes).
  useEffect(() => {
    if (!isOpen || isLoading) return;
    const t = setTimeout(() => nameInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [isOpen, isLoading]);

  const handleCancel = useCallback(() => {
    if (isSubmitting) return;
    stopBackgroundWork();
    onCancel();
  }, [isSubmitting, onCancel, stopBackgroundWork]);

  // ESC to dismiss (blocked while submitting).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, handleCancel]);

  const nameError = useMemo(() => validateName(name.trim()), [name]);
  const canSubmit =
    !isSubmitting && !isLoading && !loadError && Boolean(selectedBranch) && !nameError;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onCreate({
        baseBranch: selectedBranch,
        name: name.trim() ? name.trim() : undefined,
      });
      // Caller closes the modal on success; stop background work
      // before the unmount so the in-flight fetch is discarded.
      stopBackgroundWork();
    } catch (error) {
      // Surface the failure inline; keep the modal open so the user
      // can adjust the name and retry without losing their selection.
      setSubmitError(error instanceof Error ? error.message : 'Failed to create worktree');
      setIsSubmitting(false);
    }
  }, [canSubmit, name, onCreate, selectedBranch, stopBackgroundWork]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && canSubmit) {
        e.preventDefault();
        void handleSubmit();
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
      onClick={handleCancel}
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
        aria-busy={isSubmitting}
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
              className="worktree-name-input px-3 py-2 text-[13px] rounded-md border border-nim bg-nim-secondary text-nim focus:outline-none focus:border-nim-primary disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="worktree-name-input"
              autoComplete="off"
              spellCheck={false}
              disabled={isSubmitting}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? 'worktree-name-error' : undefined}
            />
            <div className="flex items-center justify-between text-[11px] text-nim-muted gap-2">
              <span className="font-mono truncate" data-testid="worktree-branch-preview">
                Branch: {branchPreview}
              </span>
              {nameError && (
                <span
                  id="worktree-name-error"
                  className="text-[var(--nim-error)]"
                  data-testid="worktree-name-error"
                >
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
                    disabled={isSubmitting}
                  />
                )}
                {sections.remote.length > 0 && (
                  <BranchSection
                    title="Remote branches"
                    branches={sections.remote}
                    current={sections.current}
                    selected={selectedBranch}
                    onSelect={setSelectedBranch}
                    disabled={isSubmitting}
                  />
                )}
              </div>
            )}
          </div>

          {submitError && (
            <div
              className="worktree-base-branch-submit-error text-[12px] text-[var(--nim-error)] px-3 py-2 rounded-md border border-[var(--nim-error)] bg-[var(--nim-error)]/10"
              data-testid="worktree-base-branch-submit-error"
              role="alert"
            >
              {submitError}
            </div>
          )}
        </div>

        <div className="worktree-base-branch-picker-footer flex justify-end gap-3 px-6 py-4 border-t border-nim">
          <button
            type="button"
            className="worktree-base-branch-cancel nim-btn-secondary px-4 py-2 text-[13px] font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="worktree-base-branch-cancel"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="worktree-base-branch-create nim-btn-primary px-5 py-2 text-[13px] font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            data-testid="worktree-base-branch-create"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {isSubmitting && <Spinner />}
            {isSubmitting ? 'Creating…' : 'Create Worktree'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="worktree-base-branch-spinner inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
      aria-hidden="true"
      data-testid="worktree-base-branch-spinner"
    />
  );
}

interface BranchSectionProps {
  title: string;
  branches: string[];
  current: string;
  selected: string;
  onSelect: (branch: string) => void;
  disabled?: boolean;
}

function BranchSection({ title, branches, current, selected, onSelect, disabled }: BranchSectionProps) {
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
                className={`worktree-base-branch-item flex items-center w-full px-2 py-1.5 text-left text-[12px] bg-transparent border-none cursor-pointer gap-2 rounded-sm disabled:opacity-50 disabled:cursor-not-allowed ${
                  isSelected
                    ? 'bg-[var(--nim-primary)]/15 text-nim'
                    : 'text-nim hover:bg-nim-hover'
                }`}
                data-testid={`worktree-base-branch-item-${branch}`}
                onClick={() => onSelect(branch)}
                disabled={disabled}
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
