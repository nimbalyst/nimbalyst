import React from 'react';
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import { DiffViewer } from './DiffViewer';
import { NewFilePreview } from './NewFilePreview';
import { toProjectRelative, shortenPath } from '../utils/pathResolver';
import { formatToolDisplayName } from '../utils/toolNameFormatter';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

/** Returns true if the edit represents a new file creation (content only, no diff) */
const isNewFileEdit = (edit: any): boolean => {
  if (!edit.content || typeof edit.content !== 'string') return false;
  if (edit.old_string || edit.new_string || edit.oldText || edit.newText) return false;
  if (Array.isArray(edit.replacements) && edit.replacements.length > 0) return false;
  return true;
};

interface EditToolResultCardProps {
  toolMessage: TranscriptViewMessage;
  edits: any[];
  workspacePath?: string;
  onOpenFile?: (filePath: string) => void;
  renderEmbeddedFile?: (params: { filePath: string; defaultExpanded?: boolean }) => React.ReactNode;
  /**
   * Host-provided predicate: returns true if `filePath` will be rendered
   * by `renderEmbeddedFile` so this card can suppress the redundant
   * diff/new-file view in favor of the inline preview. The host knows
   * its custom editor registry; the runtime does not, so we ask.
   */
  canEmbedFile?: (filePath: string) => boolean;
  /**
   * When set, the card renders as a one-line row while closed and the full
   * card while open; clicking either header toggles. Absent means always open
   * with no toggle.
   */
  collapse?: { isExpanded: boolean; onToggle: () => void };
}

const resolveEditFilePath = (edit: any, toolMessage: TranscriptViewMessage): string | undefined => {
  if (!edit) return undefined;
  const tool = toolMessage.toolCall;
  return (
    edit.filePath ||
    edit.file_path ||
    edit.targetFilePath ||
    tool?.targetFilePath ||
    tool?.arguments?.file_path ||
    tool?.arguments?.filePath ||
    tool?.arguments?.path
  );
};

const getInstructionText = (toolMessage: TranscriptViewMessage): string => {
  const args = toolMessage.toolCall?.arguments;
  if (!args) return '';
  if (typeof args.instructions === 'string') return args.instructions;
  if (typeof args.instruction === 'string') return args.instruction;
  return '';
};

const truncateInstruction = (text: string, maxLength = 320) => {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
};

export const EditToolResultCard: React.FC<EditToolResultCardProps> = ({
  toolMessage,
  edits,
  workspacePath,
  onOpenFile,
  renderEmbeddedFile,
  canEmbedFile,
  collapse,
}) => {
  const isEmbeddable = (filePath?: string) =>
    typeof filePath === 'string' && !!canEmbedFile?.(filePath);
  const tool = toolMessage.toolCall;
  if (!tool || edits.length === 0) {
    return null;
  }

  const firstEditPath = resolveEditFilePath(edits[0], toolMessage);
  const primarySupportsEmbeddedPreview = isEmbeddable(firstEditPath);
  const displayPath = firstEditPath ? toProjectRelative(firstEditPath, workspacePath) : '';
  const prettyPath = displayPath ? shortenPath(displayPath, 64) : '';
  const toolDisplayName = formatToolDisplayName(tool.toolName || '') || tool.toolName || 'Edit';

  const instruction = truncateInstruction(getInstructionText(toolMessage));
  const allNewFiles = edits.every(isNewFileEdit);
  // NIM-806: the Created/Applied badge is an OUTCOME — it must not render from
  // the tool_use arguments alone. For the genuine claude-code-cli the proxy
  // emits the Write/Edit tool_use at message_stop, BEFORE the user approves the
  // permission prompt and before the file is actually written; the real
  // tool_result only arrives in the next request body. Gate the success label on
  // an observed tool_result so a gated edit shows "Pending" (not a premature
  // "Created"). isError still wins (an errored/denied edit reads "Failed").
  const rawResult = toolMessage.toolCall?.result;
  const hasResult = rawResult !== undefined && rawResult !== null && rawResult !== '';
  const statusLabel = toolMessage.isError
    ? 'Failed'
    : !hasResult
      ? 'Pending'
      : allNewFiles ? 'Created' : 'Applied';
  const statusClass = toolMessage.isError ? 'error' : !hasResult ? 'pending' : 'success';
  const editCountLabel = allNewFiles
    ? `${edits[0].content.split('\n').length} lines`
    : edits.length === 1 ? '1 edit' : `${edits.length} edits`;
  const previewFilePaths = Array.from(new Set(
    edits
      .map((edit) => resolveEditFilePath(edit, toolMessage))
      .filter((filePath): filePath is string => (
        !!filePath &&
        primarySupportsEmbeddedPreview &&
        isEmbeddable(filePath)
      ))
  ));

  // Stops propagation so opening the file does not also toggle a collapsible header.
  const handleOpenFile = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (firstEditPath && onOpenFile) {
      onOpenFile(firstEditPath);
    }
  };

  // The click that ends a drag-selection of header text must not close the card.
  const handleHeaderClick = () => {
    if (!collapse || window.getSelection()?.isCollapsed === false) return;
    collapse.onToggle();
  };

  if (collapse && !collapse.isExpanded) {
    const summary = prettyPath ? `${prettyPath}, ${editCountLabel}` : editCountLabel;
    return (
      <div className="rich-transcript-edit-row rounded border border-nim overflow-hidden bg-nim-secondary">
        <button
          type="button"
          onClick={collapse.onToggle}
          aria-expanded={false}
          className="rich-transcript-edit-row__button w-full py-1 px-2 flex items-center gap-1.5 text-left border-none cursor-pointer text-sm bg-transparent"
        >
          <MaterialSymbol icon={allNewFiles ? 'note_add' : 'edit'} size={16} className="w-4 h-4 text-nim-primary shrink-0" />
          <span className="rich-transcript-edit-row__name font-mono text-sm text-nim font-medium">{toolDisplayName}</span>
          {/* Plain text, not a file link: the whole row must open the diff,
              which matters on touch screens. The open card links the file. */}
          <span className="rich-transcript-edit-row__summary flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-nim-muted" title={firstEditPath}>{summary}</span>
          {statusClass === 'success' && (
            <MaterialSymbol icon="check_circle" size={16} className="rich-transcript-edit-row__status w-4 h-4 text-nim-success shrink-0" />
          )}
          {statusClass === 'error' && (
            <MaterialSymbol icon="cancel" size={16} className="rich-transcript-edit-row__status w-4 h-4 text-nim-error shrink-0" />
          )}
          {statusClass === 'pending' && (
            <span className="rich-transcript-edit-row__status rich-transcript-edit-row__status--pending flex items-center shrink-0 text-nim-muted" title="Pending" aria-label="Pending">
              <MaterialSymbol icon="schedule" size={16} />
            </span>
          )}
          <MaterialSymbol icon="chevron_right" size={16} className="w-3 h-3 text-nim-faint shrink-0" />
        </button>
      </div>
    );
  }

  return (
    <div className="rich-transcript-edit-card rounded bg-nim-secondary border border-nim p-2 flex flex-col gap-2">
      <div
        className={`rich-transcript-edit-card__header flex items-start gap-2 ${collapse ? 'cursor-pointer' : ''}`}
        onClick={handleHeaderClick}
      >
        <div className="rich-transcript-edit-card__icon w-5 h-5 text-nim-primary shrink-0 p-1 rounded-lg flex items-center justify-center" aria-hidden="true">
          <MaterialSymbol icon={allNewFiles ? "note_add" : "edit"} size={16} />
        </div>
        <div className="rich-transcript-edit-card__details flex-1 min-w-0">
          <div className="rich-transcript-edit-card__title font-mono text-[0.85rem] text-nim font-semibold flex flex-wrap items-baseline gap-1 leading-[1.4]">
            {toolDisplayName}
            {prettyPath && (
              <>
                <span className="rich-transcript-edit-card__file-separator text-nim-faint mx-1">·</span>
                {firstEditPath && onOpenFile ? (
                  <button
                    className="rich-transcript-edit-card__file-link bg-transparent border-none p-0 m-0 font-[inherit] text-nim-link cursor-pointer no-underline hover:underline"
                    onClick={handleOpenFile}
                    title={`Open ${firstEditPath}`}
                  >
                    {prettyPath}
                  </button>
                ) : (
                  <span className="rich-transcript-edit-card__file text-nim-muted font-normal">{prettyPath}</span>
                )}
              </>
            )}
          </div>
          <div className="rich-transcript-edit-card__meta flex items-center gap-1 text-xs text-nim-faint">
            <span>{editCountLabel}</span>
            {instruction && <span className="rich-transcript-edit-card__meta-divider text-nim-faint">•</span>}
            {instruction && <span>Instruction</span>}
          </div>
        </div>
        {firstEditPath && onOpenFile && (
          <button
            className="rich-transcript-edit-card__open-button flex items-center justify-center w-5 h-5 p-0 border-none rounded bg-transparent text-nim-faint cursor-pointer shrink-0 transition-colors duration-150 hover:bg-nim-hover hover:text-nim"
            onClick={handleOpenFile}
            title="Open file"
            aria-label="Open file"
          >
            <MaterialSymbol icon="open_in_new" size={14} />
          </button>
        )}
        <span className={`rich-transcript-edit-card__status rich-transcript-edit-card__status--${statusClass} text-[0.7rem] font-semibold py-0.5 px-2 rounded-full uppercase tracking-[0.02em] ${statusClass === 'success' ? 'text-nim-success' : statusClass === 'pending' ? 'text-nim-muted' : 'text-nim-error'}`}>
          {statusLabel}
        </span>
        {collapse && (
          <button
            type="button"
            className="rich-transcript-edit-card__collapse-button flex items-center justify-center w-5 h-5 p-0 border-none rounded bg-transparent text-nim-faint cursor-pointer shrink-0 hover:bg-nim-hover hover:text-nim"
            onClick={(e) => {
              e.stopPropagation();
              collapse.onToggle();
            }}
            aria-expanded={true}
            aria-label="Collapse edit"
            title="Collapse"
          >
            <MaterialSymbol icon="expand_more" size={16} />
          </button>
        )}
      </div>

      {instruction && (
        <div className="rich-transcript-edit-card__instruction text-[0.8rem] text-nim-muted bg-nim-tertiary rounded p-2 whitespace-pre-wrap break-words leading-[1.5]">
          {instruction}
        </div>
      )}

      <div className="rich-transcript-edit-card__diffs flex flex-col gap-2">
        {edits.map((edit, idx) => {
          const absolutePath = resolveEditFilePath(edit, toolMessage);
          const relativePath = absolutePath ? toProjectRelative(absolutePath, workspacePath) : undefined;
          const isSecondaryEmbeddableFile =
            !!absolutePath &&
            absolutePath !== firstEditPath &&
            isEmbeddable(absolutePath);
          const shouldUseEmbeddedPreview =
            !!renderEmbeddedFile &&
            primarySupportsEmbeddedPreview &&
            isEmbeddable(absolutePath);

          if (shouldUseEmbeddedPreview || (!primarySupportsEmbeddedPreview && isSecondaryEmbeddableFile)) {
            return null;
          }

          if (isNewFileEdit(edit)) {
            return (
              <React.Fragment key={`new-${idx}`}>
                <NewFilePreview
                  content={edit.content}
                  filePath={relativePath || absolutePath}
                  maxHeight="18rem"
                  onOpenFile={onOpenFile}
                  absoluteFilePath={absolutePath}
                />
              </React.Fragment>
            );
          }

          return (
            <React.Fragment key={`edit-${idx}`}>
              <DiffViewer
                edit={edit}
                filePath={relativePath || absolutePath}
                maxHeight="18rem"
                onOpenFile={onOpenFile}
                absoluteFilePath={absolutePath}
              />
            </React.Fragment>
          );
        })}
      </div>

      {renderEmbeddedFile && previewFilePaths.length > 0 && (
        <div className="rich-transcript-edit-card__previews flex flex-col gap-2">
          {previewFilePaths.map((filePath) => (
            <React.Fragment key={filePath}>
              {renderEmbeddedFile({ filePath, defaultExpanded: allNewFiles })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
