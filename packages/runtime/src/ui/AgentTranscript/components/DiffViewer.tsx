import React from 'react';
import { stripCommonContext } from '../utils/stripCommonContext';

// Diff line styles - use color-mix for subtle backgrounds
const diffLineStyles = {
  removed: {
    backgroundColor: 'color-mix(in srgb, var(--nim-error) 12%, transparent)',
  },
  removedHover: {
    backgroundColor: 'color-mix(in srgb, var(--nim-error) 18%, transparent)',
  },
  added: {
    backgroundColor: 'color-mix(in srgb, var(--nim-success) 12%, transparent)',
  },
  addedHover: {
    backgroundColor: 'color-mix(in srgb, var(--nim-success) 18%, transparent)',
  },
};

// A single diff line. This is a real component (not a render helper) so that
// its hover `useState` is a stable hook — calling useState from a plain helper
// invoked a variable number of times per render breaks the Rules of Hooks and
// throws "Rendered more hooks than during the previous render."
const DiffLine: React.FC<{ type: 'added' | 'removed' | 'info'; marker: string; content: string }> = ({ type, marker, content }) => {
  const [isHovered, setIsHovered] = React.useState(false);

  let bgStyle: React.CSSProperties = {};
  let markerColor = '';

  if (type === 'removed') {
    bgStyle = isHovered ? diffLineStyles.removedHover : diffLineStyles.removed;
    markerColor = 'text-[var(--nim-error)]';
  } else if (type === 'added') {
    bgStyle = isHovered ? diffLineStyles.addedHover : diffLineStyles.added;
    markerColor = 'text-[var(--nim-success)]';
  } else {
    bgStyle = isHovered ? { backgroundColor: 'var(--nim-bg-hover)' } : { backgroundColor: 'var(--nim-bg-secondary)' };
    markerColor = 'text-[var(--nim-text-faint)]';
  }

  return (
    <div
      className={`diff-line ${type} flex items-start px-3 py-0.5 min-h-6 whitespace-pre leading-normal text-[var(--nim-text)]`}
      style={bgStyle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className={`diff-line-marker inline-block w-6 shrink-0 font-semibold select-none text-center ${markerColor}`}>{marker}</span>
      <span className="diff-line-content pl-2 leading-normal whitespace-pre">{content || ' '}</span>
    </div>
  );
};

interface DiffViewerProps {
  edit: any;
  filePath?: string; // File path from session context
  maxHeight?: string;
  /** Optional: Open a file in the editor (makes file path clickable) */
  onOpenFile?: (filePath: string) => void;
  /** Absolute file path for opening (may differ from display filePath) */
  absoluteFilePath?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ edit, filePath: contextFilePath, maxHeight = '20rem', onOpenFile, absoluteFilePath }) => {
  // Extract the relevant diff information from the edit object
  const replacements = edit.replacements || [];
  // Use file path from props (session context) or fallback to edit fields
  const filePath = contextFilePath || edit.filePath || edit.file_path || edit.targetFilePath || 'Unknown file';

  // Helper to render clickable file header
  const renderFileHeader = (displayPath: string) => {
    const pathToOpen = absoluteFilePath || edit.filePath || edit.file_path || edit.targetFilePath;
    const isClickable = onOpenFile && pathToOpen;

    const handleClick = (e: React.MouseEvent) => {
      if (isClickable) {
        e.preventDefault();
        onOpenFile(pathToOpen);
      }
    };

    if (isClickable) {
      return (
        <div className="diff-file-header px-3 py-2 bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] font-medium border-b border-[var(--nim-border)] text-[0.7rem] shrink-0">
          <button
            className="diff-file-header-link bg-transparent border-none p-0 m-0 font-inherit text-[var(--nim-link)] cursor-pointer no-underline text-left hover:underline"
            onClick={handleClick}
            title={`Open ${pathToOpen}`}
          >
            {displayPath}
          </button>
        </div>
      );
    }
    return <div className="diff-file-header px-3 py-2 bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] font-medium border-b border-[var(--nim-border)] text-[0.7rem] shrink-0">{displayPath}</div>;
  };

  // Render a diff line via the DiffLine component so each line owns its own
  // hover state as a stable hook (see DiffLine above).
  const renderDiffLine = (type: 'added' | 'removed' | 'info', marker: string, content: string, key: string) => (
    <DiffLine key={key} type={type} marker={marker} content={content} />
  );

  // Handle single edit with old_string/new_string (Claude Code Edit tool format)
  if (!replacements.length && (edit.old_string || edit.new_string)) {
    const oldTextRaw = edit.old_string || edit.oldText || '';
    const newTextRaw = edit.new_string || edit.newText || '';

    // TODO: Re-evaluate context stripping - for now show full context from LLM
    // Strip common prefix and suffix to show only what changed
    // const { oldText, newText } = stripCommonContext(oldTextRaw, newTextRaw);
    const oldText = oldTextRaw;
    const newText = newTextRaw;

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    return (
      <div className="diff-viewer font-mono text-xs leading-normal bg-[var(--nim-bg-secondary)] rounded-md border border-[var(--nim-border)] flex flex-col" style={{ maxHeight }}>
        {renderFileHeader(filePath)}
        <div className="diff-content overflow-auto py-1 flex-1 min-h-0"><div className="diff-content-inner inline-block min-w-full">
          {/* Show removed lines */}
          {oldLines.length > 0 && oldLines.some((line: string) => line.trim()) && (
            <>
              {oldLines.map((line: string, i: number) => renderDiffLine('removed', '-', line, `old-${i}`))}
            </>
          )}

          {/* Show added lines */}
          {newLines.length > 0 && newLines.some((line: string) => line.trim()) && (
            <>
              {newLines.map((line: string, i: number) => renderDiffLine('added', '+', line, `new-${i}`))}
            </>
          )}
        </div></div>
      </div>
    );
  }

  // If we have replacements array, show each replacement as a separate diff
  if (replacements.length > 0) {
    return (
      <>
        {replacements.map((replacement: any, idx: number) => {
          const oldTextRaw = replacement.oldText || replacement.old_text || '';
          const newTextRaw = replacement.newText || replacement.new_text || '';

          // TODO: Re-evaluate context stripping - for now show full context from LLM
          // Strip common prefix and suffix to show only what changed
          // const { oldText, newText } = stripCommonContext(oldTextRaw, newTextRaw);
          const oldText = oldTextRaw;
          const newText = newTextRaw;

          const oldLines = oldText.split('\n');
          const newLines = newText.split('\n');

          return (
            <div key={idx} className="diff-viewer font-mono text-xs leading-normal bg-[var(--nim-bg-secondary)] rounded-md border border-[var(--nim-border)] flex flex-col" style={{ maxHeight, marginBottom: idx < replacements.length - 1 ? '0.5rem' : '0' }}>
              {renderFileHeader(`${filePath}${replacements.length > 1 ? ` (${idx + 1}/${replacements.length})` : ''}`)}
              <div className="diff-content overflow-auto py-1 flex-1 min-h-0"><div className="diff-content-inner inline-block min-w-full">
                {/* Show removed lines */}
                {oldLines.length > 0 && oldLines.some((line: string) => line.trim()) && (
                  <>
                    {oldLines.map((line: string, i: number) => renderDiffLine('removed', '-', line, `old-${i}`))}
                  </>
                )}

                {/* Show added lines */}
                {newLines.length > 0 && newLines.some((line: string) => line.trim()) && (
                  <>
                    {newLines.map((line: string, i: number) => renderDiffLine('added', '+', line, `new-${i}`))}
                  </>
                )}
              </div></div>
            </div>
          );
        })}
      </>
    );
  }

  // If we only have content (insertion), show it as added lines
  if (edit.content) {
    const lines = edit.content.split('\n');
    return (
      <div className="diff-viewer font-mono text-xs leading-normal bg-[var(--nim-bg-secondary)] rounded-md border border-[var(--nim-border)] flex flex-col" style={{ maxHeight }}>
        {renderFileHeader(filePath)}
        <div className="diff-content overflow-auto py-1 flex-1 min-h-0"><div className="diff-content-inner inline-block min-w-full">
          {lines.map((line: string, i: number) => renderDiffLine('added', '+', line, `add-${i}`))}
        </div></div>
      </div>
    );
  }

  // Fallback: show edit details in a simple format
  return (
    <div className="diff-viewer font-mono text-xs leading-normal bg-[var(--nim-bg-secondary)] rounded-md border border-[var(--nim-border)] flex flex-col" style={{ maxHeight }}>
      {renderFileHeader(filePath)}
      <div className="diff-content overflow-auto py-1 flex-1 min-h-0"><div className="diff-content-inner inline-block min-w-full">
        {edit.operation && renderDiffLine('info', '\u2022', `Operation: ${edit.operation}`, 'operation')}
        {edit.instruction && renderDiffLine('info', '\u2022', edit.instruction, 'instruction')}
      </div></div>
    </div>
  );
};
