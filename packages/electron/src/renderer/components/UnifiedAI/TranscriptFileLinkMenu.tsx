import React, { useState } from 'react';
import { CommonFileActions } from '../CommonFileActions';
import { FloatingPortal, useFloatingMenu, virtualElement } from '../../hooks/useFloatingMenu';
import { resolveTranscriptClickPath } from '../../utils/resolveTranscriptClickPath';

interface TranscriptFileLinkMenuProps {
  baseDir?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function TranscriptFileLinkMenu({ baseDir, children, style }: TranscriptFileLinkMenuProps) {
  const [filePath, setFilePath] = useState('');
  const menu = useFloatingMenu({ placement: 'right-start' });

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const link = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[data-transcript-file-path]')
      : null;
    const path = link?.dataset.transcriptFilePath;
    if (!path) return;

    event.preventDefault();
    event.stopPropagation();
    setFilePath(resolveTranscriptClickPath(path, baseDir));
    menu.refs.setPositionReference(virtualElement(event.clientX, event.clientY));
    menu.setIsOpen(true);
  };

  return (
    <div className="transcript-file-link-menu" style={style} onContextMenu={handleContextMenu}>
      {children}
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={{
              ...menu.floatingStyles,
              background: 'var(--nim-bg)',
              border: '1px solid var(--nim-border)',
            }}
            {...menu.getFloatingProps()}
            className="transcript-file-link-context-menu min-w-[200px] p-1 rounded-md shadow-lg z-[10000] overflow-y-auto"
          >
            <CommonFileActions
              filePath={filePath}
              fileName={filePath.split(/[\\/]/).pop() || filePath}
              onClose={() => menu.setIsOpen(false)}
              menuItemClass="w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
              separatorClass="h-px my-1 bg-[var(--nim-border)]"
              useButtons
            />
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
