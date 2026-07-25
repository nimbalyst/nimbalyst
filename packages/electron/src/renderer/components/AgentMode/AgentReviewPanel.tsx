import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomValue } from "jotai";
import { MaterialSymbol } from "@nimbalyst/runtime";
import { VList } from "virtua";
import { isPathInWorkspace } from "../../../shared/pathUtils";
import {
  sessionFileEditsAtom,
  workstreamFileEditsAtom,
  workspaceUncommittedFilesAtom,
  worktreeChangedFilesAtom,
} from "../../store/atoms/sessionFiles";
import { workstreamSessionsAtom } from "../../store/atoms/sessions";
import {
  loadInitialSessionFileState,
  registerSessionWorkspace,
  registerWorktreePath,
} from "../../store/listeners/fileStateListeners";
import {
  FloatingPortal,
  useFloatingMenu,
} from "../../hooks/useFloatingMenu";
import { InlineFileDiff } from "../PullRequestMode/PrFileDiff";

interface AgentReviewPanelProps {
  workstreamId: string;
  activeSessionId: string | null;
  workspacePath: string;
  worktreeId?: string | null;
  worktreePath?: string | null;
  width: number | string;
}

interface ReviewDiff {
  filePath: string;
  unifiedDiff: string;
  isBinary: boolean;
  status: "added" | "removed" | "modified" | "renamed";
  error?: string;
}

interface ReviewSourceRevision {
  editKey: string;
  fileStateSnapshot: readonly unknown[];
  status: ReviewDiff["status"];
}

interface CachedReviewDiff {
  diff: ReviewDiff;
  sourceRevision: ReviewSourceRevision;
}

interface DiffRequest {
  promise: Promise<void>;
  sourceRevision: ReviewSourceRevision;
}

const REVIEW_STREAM_ITEM_SIZE = 260;

function isSameSourceRevision(
  left: ReviewSourceRevision,
  right: ReviewSourceRevision
): boolean {
  return (
    left.editKey === right.editKey &&
    left.fileStateSnapshot === right.fileStateSnapshot &&
    left.status === right.status
  );
}

function countDiffChanges(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

function inferStatus(
  operation: string | undefined,
  worktreeStatus: string | undefined
): ReviewDiff["status"] {
  if (worktreeStatus === "added" || operation === "create") return "added";
  if (worktreeStatus === "deleted" || operation === "delete") return "removed";
  if (operation === "rename") return "renamed";
  return "modified";
}

function normalizeReviewDiff(diff: string): string {
  if (!diff.startsWith("Index:")) return diff;
  const fileHeaderIndex = diff.indexOf("\n--- ");
  return fileHeaderIndex >= 0 ? diff.slice(fileHeaderIndex + 1) : diff;
}

export function AgentReviewPanel({
  workstreamId,
  activeSessionId,
  workspacePath,
  worktreeId,
  worktreePath,
  width,
}: AgentReviewPanelProps) {
  const effectiveWorkspacePath = worktreePath || workspacePath;
  const reviewSessionId = activeSessionId || workstreamId;
  const workstreamSessions = useAtomValue(workstreamSessionsAtom(workstreamId));
  const allFileEdits = useAtomValue(workstreamFileEditsAtom(workstreamId));
  const currentSessionFileEdits = useAtomValue(
    sessionFileEditsAtom(reviewSessionId)
  );
  const [filterToCurrentSession, setFilterToCurrentSession] = useState(false);
  const fileEdits = filterToCurrentSession
    ? currentSessionFileEdits
    : allFileEdits;
  const uncommittedFiles = useAtomValue(
    workspaceUncommittedFilesAtom(effectiveWorkspacePath)
  );
  const changedWorktreeFiles = useAtomValue(
    worktreeChangedFilesAtom(worktreeId || "__no_worktree__")
  );
  const [diffs, setDiffs] = useState<Map<string, CachedReviewDiff>>(new Map());
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const diffCacheRef = useRef<Map<string, CachedReviewDiff>>(new Map());
  const diffRequestsRef = useRef<Map<string, DiffRequest>>(new Map());

  useEffect(() => {
    if (worktreeId && worktreePath) {
      registerWorktreePath(worktreeId, worktreePath);
    }
    const sessionIds = new Set([
      workstreamId,
      ...workstreamSessions,
      reviewSessionId,
    ]);
    sessionIds.forEach((sessionId) => {
      registerSessionWorkspace(sessionId, effectiveWorkspacePath);
      loadInitialSessionFileState(sessionId, effectiveWorkspacePath);
    });
  }, [
    effectiveWorkspacePath,
    reviewSessionId,
    workstreamId,
    workstreamSessions,
    worktreeId,
    worktreePath,
  ]);

  const reviewFiles = useMemo(() => {
    const byPath = new Map<
      string,
      {
        operation?: string;
        worktreeStatus?: string;
        editRevisions?: string[];
      }
    >();

    for (const edit of fileEdits) {
      if (!isPathInWorkspace(edit.filePath, effectiveWorkspacePath)) continue;
      const current = byPath.get(edit.filePath);
      byPath.set(edit.filePath, {
        ...current,
        operation: edit.operation,
        editRevisions: [
          ...(current?.editRevisions ?? []),
          `${edit.sessionId}\0${edit.timestamp}\0${edit.operation ?? ""}`,
        ],
      });
    }

    if (worktreeId && worktreePath) {
      for (const file of changedWorktreeFiles) {
        const absolutePath = `${worktreePath}/${file.path}`;
        if (!byPath.has(absolutePath)) continue;
        byPath.set(absolutePath, {
          ...byPath.get(absolutePath),
          worktreeStatus: file.status,
        });
      }
    }

    const fileStateSnapshot =
      worktreeId && worktreePath ? changedWorktreeFiles : uncommittedFiles;

    return [...byPath.entries()]
      .map(([filePath, metadata]) => {
        const status = inferStatus(
          metadata.operation,
          metadata.worktreeStatus
        );
        return {
          filePath,
          status,
          sourceRevision: {
            editKey: [...(metadata.editRevisions ?? [])].sort().join("\0"),
            fileStateSnapshot,
            status,
          } satisfies ReviewSourceRevision,
        };
      })
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  }, [
    changedWorktreeFiles,
    effectiveWorkspacePath,
    fileEdits,
    uncommittedFiles,
    worktreeId,
    worktreePath,
  ]);

  useEffect(() => {
    const currentPaths = new Set(reviewFiles.map(({ filePath }) => filePath));
    let cacheChanged = false;
    for (const filePath of diffCacheRef.current.keys()) {
      if (!currentPaths.has(filePath)) {
        diffCacheRef.current.delete(filePath);
        cacheChanged = true;
      }
    }
    for (const filePath of diffRequestsRef.current.keys()) {
      if (!currentPaths.has(filePath)) {
        diffRequestsRef.current.delete(filePath);
      }
    }
    if (cacheChanged) {
      setDiffs(new Map(diffCacheRef.current));
    }
  }, [reviewFiles]);

  const candidateSessionIds = useMemo(
    () =>
      (filterToCurrentSession
        ? [reviewSessionId]
        : [activeSessionId, ...workstreamSessions]
      ).filter(
        (id, index, all): id is string =>
          Boolean(id) && all.indexOf(id) === index
      ),
    [
      activeSessionId,
      filterToCurrentSession,
      reviewSessionId,
      workstreamSessions,
    ]
  );
  const diffScopeKey = useMemo(
    () => [effectiveWorkspacePath, ...candidateSessionIds].join("\0"),
    [candidateSessionIds, effectiveWorkspacePath]
  );
  const diffScopeRef = useRef(diffScopeKey);

  const loadDiff = useCallback(
    async (
      filePath: string,
      status: ReviewDiff["status"]
    ): Promise<ReviewDiff> => {
      for (const sessionId of candidateSessionIds) {
        try {
          const result = (await window.electronAPI.invoke(
            "session:file-diff",
            effectiveWorkspacePath,
            sessionId,
            filePath
          )) as { unifiedDiff?: string; isBinary?: boolean };
          if (result?.isBinary || result?.unifiedDiff?.trim()) {
            return {
              filePath,
              unifiedDiff: normalizeReviewDiff(result.unifiedDiff ?? ""),
              isBinary: Boolean(result.isBinary),
              status,
            };
          }
        } catch {
          // Fall through to another session baseline, then the git working-tree diff.
        }
      }

      try {
        const result = (await window.electronAPI.invoke(
          "git:file-diff",
          effectiveWorkspacePath,
          { path: filePath, group: "working" as const }
        )) as { unifiedDiff?: string; isBinary?: boolean };
        return {
          filePath,
          unifiedDiff: result?.unifiedDiff ?? "",
          isBinary: Boolean(result?.isBinary),
          status,
        };
      } catch (error) {
        return {
          filePath,
          unifiedDiff: "",
          isBinary: false,
          status,
          error: error instanceof Error ? error.message : "Failed to load diff",
        };
      }
    },
    [candidateSessionIds, effectiveWorkspacePath]
  );

  useEffect(() => {
    if (diffScopeRef.current === diffScopeKey) return;
    diffScopeRef.current = diffScopeKey;
    diffCacheRef.current = new Map();
    diffRequestsRef.current = new Map();
    setDiffs(new Map());
  }, [diffScopeKey]);

  const ensureDiffLoaded = useCallback(
    (
      filePath: string,
      status: ReviewDiff["status"],
      sourceRevision: ReviewSourceRevision
    ) => {
      if (diffScopeRef.current !== diffScopeKey) {
        diffScopeRef.current = diffScopeKey;
        diffCacheRef.current = new Map();
        diffRequestsRef.current = new Map();
        setDiffs(new Map());
      }
      const cached = diffCacheRef.current.get(filePath);
      if (
        cached &&
        isSameSourceRevision(cached.sourceRevision, sourceRevision)
      ) {
        return;
      }
      const pending = diffRequestsRef.current.get(filePath);
      if (
        pending &&
        isSameSourceRevision(pending.sourceRevision, sourceRevision)
      ) {
        return;
      }

      const request = loadDiff(filePath, status)
        .then((diff) => {
          const activeRequest = diffRequestsRef.current.get(filePath);
          if (
            diffScopeRef.current !== diffScopeKey ||
            activeRequest?.promise !== request
          ) {
            return;
          }
          diffCacheRef.current.set(filePath, { diff, sourceRevision });
          setDiffs(new Map(diffCacheRef.current));
        })
        .finally(() => {
          if (diffRequestsRef.current.get(filePath)?.promise === request) {
            diffRequestsRef.current.delete(filePath);
          }
        });
      diffRequestsRef.current.set(filePath, { promise: request, sourceRevision });
    },
    [diffScopeKey, loadDiff]
  );

  const toggleCollapsed = useCallback((filePath: string) => {
    setCollapsedFiles((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  return (
    <div
      className="agent-review-panel shrink-0 flex flex-col h-full bg-[var(--nim-bg-secondary)]"
      style={{ width }}
      data-testid="agent-review-panel"
    >
      <div className="agent-review-panel__header flex items-center gap-2 px-3 py-2 border-b border-[var(--nim-border)] shrink-0">
        <ReviewTargetDropdown
          filterToCurrentSession={filterToCurrentSession}
          onFilterToCurrentSessionChange={setFilterToCurrentSession}
          workstreamSessionCount={workstreamSessions.length}
          canSelectCurrent={Boolean(activeSessionId)}
        />
        <span className="ml-auto text-xs text-[var(--nim-text-faint)] shrink-0">
          {reviewFiles.length} file{reviewFiles.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="agent-review-panel__content flex-1 min-h-0 overflow-hidden">
        {reviewFiles.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-[var(--nim-text-faint)]">
            <MaterialSymbol icon="check_circle" size={32} />
            <span className="text-sm">No changed files to review.</span>
          </div>
        ) : (
          <VList
            className="!h-full !w-full"
            style={{ height: "100%" }}
            data={reviewFiles}
            bufferSize={800}
            itemSize={REVIEW_STREAM_ITEM_SIZE}
          >
            {({ filePath, status, sourceRevision }) => {
              const cached =
                diffScopeRef.current === diffScopeKey
                  ? diffs.get(filePath)
                  : undefined;
              return (
                <ReviewFileSection
                  key={filePath}
                  filePath={filePath}
                  relativePath={
                    filePath.startsWith(`${effectiveWorkspacePath}/`)
                      ? filePath.slice(effectiveWorkspacePath.length + 1)
                      : filePath
                  }
                  status={status}
                  sourceRevision={sourceRevision}
                  diff={
                    cached &&
                    isSameSourceRevision(
                      cached.sourceRevision,
                      sourceRevision
                    )
                      ? cached.diff
                      : undefined
                  }
                  collapsed={collapsedFiles.has(filePath)}
                  onEnsureDiff={ensureDiffLoaded}
                  onToggleCollapsed={toggleCollapsed}
                />
              );
            }}
          </VList>
        )}
      </div>
    </div>
  );
}

function ReviewTargetDropdown({
  filterToCurrentSession,
  onFilterToCurrentSessionChange,
  workstreamSessionCount,
  canSelectCurrent,
}: {
  filterToCurrentSession: boolean;
  onFilterToCurrentSessionChange: (filterToCurrent: boolean) => void;
  workstreamSessionCount: number;
  canSelectCurrent: boolean;
}) {
  const menu = useFloatingMenu({ placement: "bottom-start" });
  const targetLabel = filterToCurrentSession
    ? "Current session only"
    : `All sessions (${workstreamSessionCount})`;

  return (
    <div className="workstream-review-target min-w-0">
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        data-testid="workstream-review-target"
        className={`workstream-review-target__trigger flex flex-col items-start gap-0 px-2 py-1 -mx-2 -my-1 border-none rounded cursor-pointer transition-colors max-w-full ${
          menu.isOpen
            ? "bg-[var(--nim-bg-tertiary)]"
            : "bg-transparent hover:bg-[var(--nim-bg-hover)]"
        }`}
      >
        <div className="workstream-review-target__title-row flex items-center gap-1 max-w-full">
          <MaterialSymbol
            icon="rate_review"
            size={16}
            className="text-[var(--nim-text-muted)] shrink-0"
          />
          <span className="workstream-review-target__title text-sm font-medium text-[var(--nim-text)] truncate min-w-0">
            Workstream Review
          </span>
          <MaterialSymbol
            icon="expand_more"
            size={16}
            className={`workstream-review-target__chevron text-[var(--nim-text-muted)] transition-transform duration-200 shrink-0 ${
              menu.isOpen ? "rotate-180" : ""
            }`}
          />
        </div>
        <span className="workstream-review-target__subtitle text-xs text-[var(--nim-text-muted)] pl-5">
          {targetLabel}
        </span>
      </button>

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="workstream-review-target__menu min-w-[260px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-lg z-[1000] overflow-hidden"
          >
            <div className="workstream-review-target__section px-3 py-2">
              <div className="workstream-review-target__section-header text-[10px] font-semibold text-[var(--nim-text-faint)] uppercase tracking-wide mb-1.5">
                Review Target
              </div>
              <label className="workstream-review-target__option flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-[var(--nim-bg-hover)]">
                <input
                  type="radio"
                  name="workstreamReviewTarget"
                  checked={!filterToCurrentSession}
                  onChange={() => {
                    onFilterToCurrentSessionChange(false);
                    menu.setIsOpen(false);
                  }}
                  className="cursor-pointer"
                />
                <span className="text-xs text-[var(--nim-text)]">
                  All sessions ({workstreamSessionCount})
                </span>
              </label>
              {canSelectCurrent && (
                <label className="workstream-review-target__option flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-[var(--nim-bg-hover)]">
                  <input
                    type="radio"
                    name="workstreamReviewTarget"
                    checked={filterToCurrentSession}
                    onChange={() => {
                      onFilterToCurrentSessionChange(true);
                      menu.setIsOpen(false);
                    }}
                    className="cursor-pointer"
                  />
                  <span className="text-xs text-[var(--nim-text)]">
                    Current session only
                  </span>
                </label>
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

function ReviewFileSection({
  filePath,
  relativePath,
  status,
  sourceRevision,
  diff,
  collapsed,
  onEnsureDiff,
  onToggleCollapsed,
}: {
  filePath: string;
  relativePath: string;
  status: ReviewDiff["status"];
  sourceRevision: ReviewSourceRevision;
  diff: ReviewDiff | undefined;
  collapsed: boolean;
  onEnsureDiff: (
    filePath: string,
    status: ReviewDiff["status"],
    sourceRevision: ReviewSourceRevision
  ) => void;
  onToggleCollapsed: (filePath: string) => void;
}) {
  useEffect(() => {
    if (!collapsed && !diff) {
      onEnsureDiff(filePath, status, sourceRevision);
    }
  }, [
    collapsed,
    diff,
    filePath,
    onEnsureDiff,
    sourceRevision,
    status,
  ]);

  const stats = countDiffChanges(diff?.unifiedDiff ?? "");

  return (
    <section
      className="agent-review-panel__file border-b border-[var(--nim-border)]"
      data-file-path={filePath}
    >
      <button
        type="button"
        onClick={() => onToggleCollapsed(filePath)}
        className="agent-review-panel__file-header sticky top-0 z-[1] w-full flex items-center gap-2 px-3 py-2 border-none border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-left cursor-pointer hover:bg-[var(--nim-bg-hover)]"
      >
        <MaterialSymbol
          icon={collapsed ? "chevron_right" : "expand_more"}
          size={16}
          className="text-[var(--nim-text-faint)]"
        />
        <MaterialSymbol
          icon="description"
          size={15}
          className="text-[var(--nim-text-faint)]"
        />
        <span
          className="min-w-0 flex-1 truncate text-xs text-[var(--nim-text)]"
          title={relativePath}
        >
          {relativePath}
        </span>
        {stats.additions > 0 && (
          <span className="font-mono text-[11px] text-[var(--nim-success)]">
            +{stats.additions}
          </span>
        )}
        {stats.deletions > 0 && (
          <span className="font-mono text-[11px] text-[var(--nim-error)]">
            −{stats.deletions}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="agent-review-panel__diff overflow-x-auto bg-[var(--nim-bg)]">
          {!diff ? (
            <div className="px-4 py-6 text-xs text-[var(--nim-text-faint)]">
              Loading diff…
            </div>
          ) : diff.error ? (
            <div className="px-4 py-6 text-xs text-[var(--nim-error)]">
              {diff.error}
            </div>
          ) : diff.isBinary ? (
            <div className="px-4 py-6 text-xs text-[var(--nim-text-faint)]">
              Binary file — no text diff available.
            </div>
          ) : (
            <InlineFileDiff
              filePath={relativePath}
              status={status}
              unifiedDiff={diff.unifiedDiff}
            />
          )}
        </div>
      )}
    </section>
  );
}
