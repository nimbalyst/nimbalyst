/**
 * FilesChangedTab — file list + Monaco side-by-side diff (issue #307, Phase G).
 *
 * Left: changed files with +/- and a status badge. Right: the selected file's
 * diff via the existing MonacoDiffViewer. Only one diff editor is mounted at a
 * time (keyed by pr id + path), so switching files disposes the prior models —
 * no Monaco leak across a large PR.
 *
 * Binary files (no patch) show a placeholder. Added files diff against empty
 * base; removed files diff against empty head; renamed files read the base
 * side from `previousPath`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { getMonacoTheme } from '@nimbalyst/runtime/editors';
import { isDarkThemeAtom, themeIdAtom } from '@nimbalyst/runtime/store';
import { MonacoDiffViewer } from '../../HistoryDialog/MonacoDiffViewer';
import {
  getPullRequestService,
  type PullRequestRow,
  type PullRequestFileRow,
} from '../../../services/RendererPullRequestService';

interface FilesChangedTabProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  refreshToken: number;
}

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  added: { label: 'A', className: 'text-nim-success' },
  removed: { label: 'D', className: 'text-nim-error' },
  modified: { label: 'M', className: 'text-nim-warning' },
  renamed: { label: 'R', className: 'text-nim-accent' },
};

export function FilesChangedTab({
  workspaceId,
  remote,
  pr,
  refreshToken,
}: FilesChangedTabProps): JSX.Element {
  void workspaceId;
  const isDark = useAtomValue(isDarkThemeAtom);
  const themeId = useAtomValue(themeIdAtom);
  // Resolve the same Monaco theme the app's editors use, including custom /
  // extension themes (passing themeId as both nimbalyst theme + extension id).
  const monacoThemeName = getMonacoTheme(themeId, isDark, themeId);
  const [files, setFiles] = useState<PullRequestFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const [oldContent, setOldContent] = useState('');
  const [newContent, setNewContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  // Load the changed-file list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPullRequestService()
      .files(workspaceId, remote, pr.number)
      .then((rows) => {
        if (cancelled) return;
        setFiles(rows);
        setSelectedPath((prev) => prev ?? rows[0]?.path ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.number, refreshToken]);

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  // Load the selected file's two sides.
  useEffect(() => {
    if (!selectedFile) {
      setOldContent('');
      setNewContent('');
      return;
    }
    if (selectedFile.patch === null) {
      // Binary file — no text diff available.
      return;
    }

    let cancelled = false;
    setContentLoading(true);
    setContentError(null);

    const service = getPullRequestService();
    const basePath = selectedFile.previousPath ?? selectedFile.path;
    const needBase = selectedFile.status !== 'added';
    const needHead = selectedFile.status !== 'removed';

    Promise.all([
      needBase ? service.fileContents(workspaceId, remote, pr.baseRef, basePath) : Promise.resolve(''),
      needHead ? service.fileContents(workspaceId, remote, pr.headSha, selectedFile.path) : Promise.resolve(''),
    ])
      .then(([base, head]) => {
        if (cancelled) return;
        setOldContent(base);
        setNewContent(head);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setContentError(err instanceof Error ? err.message : 'Failed to load file contents');
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.baseRef, pr.headSha, selectedFile, refreshToken]);

  return (
    <div className="pr-files-tab flex flex-row h-full overflow-hidden" data-testid="pr-files-tab">
      {/* File list */}
      <div className="w-64 shrink-0 border-r border-nim overflow-y-auto bg-nim-secondary">
        {loading && files.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-nim-muted text-xs">
            <div className="spinner w-4 h-4 border-[2px] border-nim-secondary border-t-nim-accent rounded-full animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="text-nim-error text-xs p-3">{error}</div>
        ) : files.length === 0 ? (
          <div className="text-nim-faint text-xs p-3">No changed files.</div>
        ) : (
          files.map((file) => {
            const style = STATUS_STYLE[file.status] ?? STATUS_STYLE.modified;
            const isSelected = file.path === selectedPath;
            const name = file.path.split('/').pop() ?? file.path;
            return (
              <button
                key={file.path}
                data-testid="pr-file-row"
                onClick={() => setSelectedPath(file.path)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs border-b border-nim transition-colors ${
                  isSelected ? 'bg-nim-active text-nim' : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
                }`}
                title={file.path}
              >
                <span className={`font-mono font-bold w-3 shrink-0 ${style.className}`}>{style.label}</span>
                <span className="flex-1 min-w-0 truncate">{name}</span>
                <span className="shrink-0 text-[10px] text-nim-faint">
                  <span className="text-nim-success">+{file.additions}</span>{' '}
                  <span className="text-nim-error">-{file.deletions}</span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Diff */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {!selectedFile ? (
          <div className="flex items-center justify-center h-full text-nim-faint text-sm">
            Select a file to view its diff.
          </div>
        ) : selectedFile.patch === null ? (
          <div className="flex flex-col items-center justify-center h-full text-nim-faint text-sm gap-2">
            <MaterialSymbol icon="draft" size={32} className="opacity-50" />
            Binary file — no text diff available.
          </div>
        ) : contentError ? (
          <div className="flex items-center justify-center h-full text-nim-error text-sm">{contentError}</div>
        ) : contentLoading ? (
          <div className="flex items-center justify-center gap-2 h-full text-nim-muted text-sm">
            <div className="spinner w-5 h-5 border-[3px] border-nim-secondary border-t-nim-accent rounded-full animate-spin" />
            Loading diff…
          </div>
        ) : (
          <MonacoDiffViewer
            key={`${pr.id}:${selectedFile.path}`}
            oldContent={oldContent}
            newContent={newContent}
            filePath={selectedFile.path}
            theme={isDark ? 'dark' : 'light'}
            monacoThemeName={monacoThemeName}
          />
        )}
      </div>
    </div>
  );
}
