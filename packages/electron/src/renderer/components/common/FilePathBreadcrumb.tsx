import React, { useCallback, useMemo } from 'react';
import { basename } from 'pathe';
import { useSetAtom } from 'jotai';

import {
  openFileRequestAtom,
  revealFileAtom,
  revealFolderAtom,
  setWindowModeAtom,
} from '../../store';

interface BreadcrumbSegment {
  name: string;
  folderPath: string | null;
}

interface FilePathBreadcrumbProps {
  filePath: string;
  workspacePath?: string | null;
  className?: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function getBreadcrumbSegments(filePath: string, workspacePath?: string | null): BreadcrumbSegment[] {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedWorkspacePath = workspacePath ? normalizePath(workspacePath) : null;
  const isWithinWorkspace = Boolean(
    normalizedWorkspacePath &&
      (normalizedFilePath === normalizedWorkspacePath ||
        normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)),
  );

  let displayPath = normalizedFilePath;
  if (isWithinWorkspace && normalizedWorkspacePath) {
    displayPath = normalizedFilePath.slice(normalizedWorkspacePath.length).replace(/^\/+/, '');
  }

  const parts = displayPath.split('/').filter(Boolean);
  if (!parts.length) {
    return [{ name: basename(filePath), folderPath: null }];
  }

  const absolutePrefix = !isWithinWorkspace && normalizedFilePath.startsWith('/') ? '/' : '';
  return parts.map((name, index) => {
    const isFile = index === parts.length - 1;
    if (isFile) {
      return { name, folderPath: null };
    }

    const folderPath = isWithinWorkspace && normalizedWorkspacePath
      ? `${normalizedWorkspacePath}/${parts.slice(0, index + 1).join('/')}`
      : `${absolutePrefix}${parts.slice(0, index + 1).join('/')}`;

    return { name, folderPath };
  });
}

export const FilePathBreadcrumb: React.FC<FilePathBreadcrumbProps> = ({
  filePath,
  workspacePath,
  className = '',
}) => {
  const revealFolder = useSetAtom(revealFolderAtom);
  const revealFile = useSetAtom(revealFileAtom);
  const setOpenFileRequest = useSetAtom(openFileRequestAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);

  const breadcrumbSegments = useMemo(
    () => getBreadcrumbSegments(filePath, workspacePath),
    [filePath, workspacePath],
  );

  const handleBreadcrumbClick = useCallback((folderPath: string | null, targetFilePath?: string) => {
    if (folderPath) {
      setWindowMode('files');
      revealFolder(folderPath);
      return;
    }
    if (targetFilePath) {
      setOpenFileRequest({ path: targetFilePath, ts: Date.now() });
      revealFile(targetFilePath);
    }
  }, [revealFolder, revealFile, setOpenFileRequest, setWindowMode]);

  return (
    <div className={`unified-header-breadcrumb flex items-center gap-1.5 text-[13px] min-w-0 overflow-hidden ${className}`.trim()}>
      {breadcrumbSegments.map((segment, index) => {
        const isLast = index === breadcrumbSegments.length - 1;
        const isClickable = (!isLast && segment.folderPath) || (isLast && Boolean(filePath));
        return (
          <React.Fragment key={`${segment.name}-${index}`}>
            <span
              className={`breadcrumb-segment flex items-center gap-1 whitespace-nowrap ${
                isLast
                  ? 'breadcrumb-filename text-[var(--nim-text)] font-medium'
                  : 'text-[var(--nim-text-muted)]'
              } ${
                isClickable
                  ? 'breadcrumb-clickable cursor-pointer rounded py-0.5 px-1 -my-0.5 -mx-1 transition-colors duration-150 hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
                  : ''
              }`}
              onClick={isClickable ? () => handleBreadcrumbClick(segment.folderPath, isLast ? filePath : undefined) : undefined}
              title={isClickable ? `Go to ${segment.name} in file tree` : undefined}
            >
              {!isLast && (
                <svg className="breadcrumb-icon w-3.5 h-3.5 opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              )}
              {isLast && (
                <svg className="breadcrumb-icon w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              )}
              {segment.name}
            </span>
            {!isLast && <span className="breadcrumb-separator text-[var(--nim-text-faint)] text-[11px]">/</span>}
          </React.Fragment>
        );
      })}
    </div>
  );
};
