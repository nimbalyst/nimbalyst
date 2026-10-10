import type { JSX } from 'react';
import React, { useCallback, useMemo } from 'react';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import type { ToolCallDiffLoadResult } from '../../../ai/server/transcript';
import { MarkdownRenderer, type TranscriptFileLocation } from './MarkdownRenderer';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { JSONViewer } from './JSONViewer';
import { formatToolArguments, extractFilePathFromArgs } from '../utils/pathResolver';
import { EditToolResultCard } from './EditToolResultCard';
import { formatToolDisplayName } from '../utils/toolNameFormatter';
import { getCustomToolWidget, ToolWidgetErrorBoundary } from './CustomToolWidgets';
import { useTranscriptToolWidgetRegistryVersion } from '../contributions';
import { ToolCallChanges } from './ToolCallChanges';

/**
 * One tool call in the transcript: a registered custom widget, an edit diff
 * card, or the generic collapsible tool card (recursing into sub-agent child
 * events). Memoized: every prop is either the tool's own data, a primitive,
 * or a value the parent keeps identity-stable, so an unrelated transcript
 * render (e.g. one streamed text frame) does not re-render the widget.
 */

export type TranscriptTeammateStatus = { agentId: string; status: 'running' | 'completed' | 'errored' | 'idle' };

/** Values shared by every tool card. The parent memoizes this object once. */
export interface TranscriptToolShared {
  sessionId: string;
  workspacePath?: string;
  readFile?: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  onOpenFile?: (filePath: string, location?: TranscriptFileLocation) => void;
  onOpenSession?: (sessionId: string) => void;
  renderEmbeddedFile?: (params: { filePath: string; defaultExpanded?: boolean }) => React.ReactNode;
  canEmbedFile?: (filePath: string) => boolean;
  loadToolCallDiffs?: (toolCallItemId: string, toolCallTimestamp?: number) => Promise<ToolCallDiffLoadResult>;
  onToggleTool: (toolId: string) => void;
}

/**
 * State a sub-agent card needs for its child cards and its live status.
 * Only sub-agent cards receive it (they are rare), so expanding one tool or a
 * teammate status change re-renders sub-agent cards and leaves the rest alone.
 */
export interface SubagentChildContext {
  expandedTools: ReadonlySet<string>;
  skippedQuestionIds: ReadonlySet<string>;
  currentTeammates?: TranscriptTeammateStatus[];
}

export interface TranscriptToolCardProps {
  toolMsg: TranscriptViewMessage;
  toolIndex: number;
  depth: number;
  isExpanded: boolean;
  /** A later event carries the same providerToolCallId; drop the scroll anchor. */
  superseded: boolean;
  /** Question tools the user moved past without answering. */
  skipped?: boolean;
  shared: TranscriptToolShared;
  subagentContext?: SubagentChildContext;
}

/** The id `expandedTools` is keyed by. */
export const getToolExpandId = (toolMsg: TranscriptViewMessage, toolIndex: number): string =>
  toolMsg.toolCall?.providerToolCallId || toolMsg.toolCall?.toolName || `tool-${toolIndex}`;

const NO_EDITS: any[] = [];

// Lowercased tool names that should render with EditToolResultCard.
// 'applypatch'/'apply_patch' covers Codex ACP's apply_patch tool, which
// emits its diff via a `changes: { [path]: { type, unified_diff } }` shape
// (parsed in extractEditsFromToolMessage).
// Codex app-server's `file_change` is NOT in this set -- its `changes` is an
// array of `{path, kind, diff}` rather than the {old_string,new_string}/
// {content} shapes extractEditsFromToolMessage understands, so it routes
// through extractCodexFileChanges in renderToolCard instead. (#1191: it used
// to depend on main-side fileDiffs enrichment, which lazy diff loading removed.)
export const EDIT_TOOL_NAMES = new Set([
  'edit', 'write', 'multi-edit', 'multiedit', 'multi_edit',
  'applypatch', 'apply_patch',
]);

export const isEditToolName = (name?: string): boolean => {
  if (!name) return false;
  const normalized = name.toLowerCase();
  if (EDIT_TOOL_NAMES.has(normalized)) return true;
  if (normalized.endsWith('__edit')) return true;
  if (normalized.endsWith(':edit')) return true;
  return false;
};

/** Formats provider-supplied sub-agent execution metadata without normalizing it. */
export function formatSubagentAuditLabel(
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (model) parts.push(`Model: ${model}`);
  if (reasoningEffort) parts.push(`Reasoning effort: ${reasoningEffort}`);
  return parts.length > 0 ? parts.join('; ') : null;
}

const safeParseJson = (value: string): any | null => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const looksLikeJson = (value: string) => {
  const trimmed = value.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
};

export const getTranscriptToolKey = (
  toolMsg: TranscriptViewMessage,
  fallbackIndex: number,
  depth: number
): string => {
  const stableId =
    toolMsg.toolCall?.providerToolCallId ||
    toolMsg.subagentId ||
    (Number.isFinite(toolMsg.id) ? `id-${toolMsg.id}` : null) ||
    (Number.isFinite(toolMsg.sequence) ? `seq-${toolMsg.sequence}` : null) ||
    `idx-${fallbackIndex}`;
  // Append fallbackIndex as a tiebreaker. Some providers report the same
  // providerToolCallId for both a parent tool and a derived/echo row at the
  // same depth, which would collide if we keyed by stableId alone.
  return `tool-${depth}-${stableId}-i${fallbackIndex}`;
};

const stableSerialize = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`);

  return `{${entries.join(',')}}`;
};

const buildEditSignature = (edit: Record<string, any>): string => {
  const resolvedPath = edit.filePath || edit.file_path || edit.targetFilePath || '';
  return stableSerialize({
    filePath: resolvedPath,
    replacements: edit.replacements,
    oldString: edit.old_string ?? edit.oldText,
    newString: edit.new_string ?? edit.newText,
    content: edit.content,
    applied: edit.applied,
    type: edit.type,
  });
};

/**
 * Parse a unified diff string into the `replacements: [{oldText, newText}]`
 * shape DiffViewer expects. Hunks are split on `@@` headers; one replacement
 * is emitted per hunk so the rendered diff preserves hunk boundaries.
 *
 * Used to bridge Codex ACP's `apply_patch` tool output (which carries hunks
 * as a single unified diff string) into the same renderer Claude's Edit uses.
 */
export const parseUnifiedDiffToReplacements = (
  unifiedDiff: string
): Array<{ oldText: string; newText: string }> => {
  if (!unifiedDiff) return [];
  const lines = unifiedDiff.split('\n');
  const replacements: Array<{ oldText: string; newText: string }> = [];
  let oldBuf: string[] = [];
  let newBuf: string[] = [];
  let inHunk = false;

  const flush = () => {
    if (oldBuf.length === 0 && newBuf.length === 0) return;
    replacements.push({ oldText: oldBuf.join('\n'), newText: newBuf.join('\n') });
    oldBuf = [];
    newBuf = [];
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === '') continue; // trailing newline / blank between hunks
    if (line.startsWith('\\ ')) continue; // "\ No newline at end of file"
    if (line.startsWith('-')) {
      oldBuf.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newBuf.push(line.slice(1));
    } else {
      const ctx = line.startsWith(' ') ? line.slice(1) : line;
      oldBuf.push(ctx);
      newBuf.push(ctx);
    }
  }
  flush();
  return replacements;
};

/**
 * Detect Codex `apply_patch`'s `changes` shape -- a record keyed by file
 * path whose values are `{ type: 'add'|'update'|'delete'|'move',
 * unified_diff?: string, move_path?: string|null }`. Returns one synthesized
 * edit per entry, ready for EditToolResultCard.
 */
const extractApplyPatchChanges = (changes: unknown): any[] => {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const out: any[] = [];
  for (const [path, raw] of Object.entries(changes as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const kind = typeof entry.type === 'string' ? entry.type : undefined;
    const unifiedDiff = typeof entry.unified_diff === 'string' ? entry.unified_diff : undefined;

    if (kind === 'add') {
      // Codex apply_patch carries the full new-file body as `content` for
      // type: 'add'. Older variants (or other apply_patch implementations)
      // may instead provide a unified_diff whose `+` lines comprise the
      // file -- prefer `content` but fall back to extracting from the diff.
      let content = '';
      if (typeof entry.content === 'string') {
        content = entry.content;
      } else if (unifiedDiff) {
        content = unifiedDiff
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .map((l) => l.slice(1))
          .join('\n');
      }
      out.push({ filePath: path, type: 'add', operation: 'create', content });
      continue;
    }

    if (kind === 'delete') {
      out.push({ filePath: path, type: 'delete', operation: 'delete', content: '' });
      continue;
    }

    if (unifiedDiff) {
      const replacements = parseUnifiedDiffToReplacements(unifiedDiff);
      out.push({
        filePath: path,
        type: kind ?? 'update',
        operation: 'edit',
        replacements,
      });
    }
  }
  return out;
};

/**
 * Detect the Codex app-server `file_change` shape -- an ARRAY of
 * `{ path, kind: 'add'|'update'|'delete', move_path?: string|null, diff: string }`
 * (see CodexAppServerRawParser.parseFileChangeItem). The `diff` field's meaning
 * depends on `kind`, per providers/codex/patchReverse.ts:
 *
 *   add    -> raw post-edit file content (NOT a unified diff)
 *   update -> one or more standard unified-diff hunks
 *   delete -> the removed content, formatted as `-` lines
 *
 * Rendering straight off these arguments keeps Codex edits on the red/green
 * EditToolResultCard without touching the lazy history-diff machinery: the
 * patch text is already in the persisted tool call, so no snapshot reads and
 * no diff computation are needed.
 *
 * The legacy `@openai/codex-sdk` transport passes the SDK's `changes` through
 * verbatim and those entries carry no `diff`, so they yield no edits here and
 * fall through to the generic tool card.
 */
export const extractCodexFileChanges = (changes: unknown): any[] => {
  if (!Array.isArray(changes)) return [];
  const out: any[] = [];
  for (const raw of changes) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const filePath = typeof entry.path === 'string' ? entry.path : undefined;
    const diff = typeof entry.diff === 'string' ? entry.diff : undefined;
    if (!filePath || !diff) continue;
    const kind = typeof entry.kind === 'string' ? entry.kind : 'update';

    if (kind === 'add') {
      out.push({ filePath, type: 'add', operation: 'create', content: diff });
      continue;
    }

    if (kind === 'delete') {
      out.push({
        filePath,
        type: 'delete',
        operation: 'delete',
        old_string: stripLeadingDiffMarkers(diff),
        new_string: '',
      });
      continue;
    }

    const replacements = parseUnifiedDiffToReplacements(diff);
    if (replacements.length === 0) continue;
    out.push({ filePath, type: 'update', operation: 'edit', replacements });
  }
  return out;
};

/** Strip the leading `-` from each line of a Codex delete diff. */
const stripLeadingDiffMarkers = (diff: string): string =>
  diff
    .split('\n')
    .map((line) => (line.startsWith('-') ? line.slice(1) : line))
    .join('\n');

/**
 * Map resolved `ToolCallDiffResult[]` into the edit-record shape
 * EditToolResultCard expects. Used by transcript rows that are enriched in
 * main before the renderer sees them (for example Codex `file_change`).
 */
export const toolCallDiffsToEdits = (diffs: any[]): any[] => {
  const out: any[] = [];
  for (const diff of diffs) {
    if (!diff || typeof diff !== 'object') continue;
    const filePath = typeof diff.filePath === 'string' ? diff.filePath : undefined;
    if (!filePath) continue;
    const operation = typeof diff.operation === 'string' ? diff.operation : 'edit';

    if (operation === 'create') {
      // Prefer the explicit `content` field when the matcher provided it
      // (Write/Edit tools include the file body directly). For Codex
      // `file_change` with kind='add', the matcher returns
      // `diffs: [{ oldString: '', newString: <full body> }]` from its
      // history-snapshot fallback because the SDK's FileChangeItem.changes
      // doesn't carry content -- pull the body off newString in that case
      // so NewFilePreview renders with the actual file contents instead
      // of an empty preview.
      let content = typeof diff.content === 'string' ? diff.content : '';
      if (!content && Array.isArray(diff.diffs) && diff.diffs.length > 0) {
        content = diff.diffs
          .map((d: any) => (typeof d?.newString === 'string' ? d.newString : ''))
          .join('');
      }
      out.push({
        filePath,
        type: 'add',
        operation: 'create',
        content,
      });
      continue;
    }

    const replacements = Array.isArray(diff.diffs)
      ? diff.diffs
          .filter((d: any) => d && typeof d === 'object')
          .map((d: any) => ({
            oldText: typeof d.oldString === 'string' ? d.oldString : '',
            newText: typeof d.newString === 'string' ? d.newString : '',
          }))
      : [];

    if (operation === 'delete') {
      // ToolCallMatcher returns the file's last-known content as a single
      // diff entry for delete. Render it as red-only by clearing newText.
      const first = replacements[0] ?? { oldText: '', newText: '' };
      out.push({
        filePath,
        type: 'delete',
        operation: 'delete',
        old_string: first.oldText,
        new_string: '',
      });
      continue;
    }

    out.push({
      filePath,
      type: 'update',
      operation: 'edit',
      replacements: replacements.length > 0 ? replacements : undefined,
    });
  }
  return out;
};

export const extractEditsFromToolMessage = (message: TranscriptViewMessage): any[] => {
  const tool = message.toolCall;
  if (!tool) return [];

  const args = tool.arguments as Record<string, any> | undefined;
  const fallbackPath =
    tool.targetFilePath ||
    (args?.file_path as string | undefined) ||
    (args?.filePath as string | undefined) ||
    (args?.path as string | undefined);

  const edits: any[] = [];
  const visited = new WeakSet<object>();
  const seenEditSignatures = new Set<string>();

  const pushEdit = (raw: any, fallback?: string) => {
    if (!raw || typeof raw !== 'object') return;
    const normalized: any = { ...raw };

    if (Array.isArray(normalized.content)) {
      const flattened = normalized.content
        .map((block: any) => {
          if (typeof block === 'string') return block;
          if (block && typeof block.text === 'string') return block.text;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (flattened) {
        normalized.content = flattened;
      }
    }

    if (
      !normalized.filePath &&
      !normalized.file_path &&
      !normalized.targetFilePath &&
      fallback
    ) {
      normalized.filePath = fallback;
    }

    const signature = buildEditSignature(normalized);
    if (seenEditSignatures.has(signature)) {
      return;
    }
    seenEditSignatures.add(signature);
    edits.push(normalized);
  };

  const visit = (value: any, localFallback?: string) => {
    if (value === null || value === undefined) return;
    const fallback = localFallback || fallbackPath;

    if (Array.isArray(value)) {
      value.forEach(item => visit(item, fallback));
      return;
    }

    if (typeof value === 'string') {
      if (looksLikeJson(value)) {
        const parsed = safeParseJson(value);
        if (parsed) {
          visit(parsed, fallback);
        }
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (visited.has(value as object)) {
      return;
    }
    visited.add(value as object);

    const candidate = value as Record<string, any>;
    const candidateFilePath =
      candidate.file_path ||
      candidate.filePath ||
      candidate.targetFilePath ||
      candidate.file ||
      fallback;

    const hasReplacementArray = Array.isArray(candidate.replacements) && candidate.replacements.length > 0;
    const hasTextContent = typeof candidate.content === 'string' && candidate.content.trim().length > 0;
    const hasContentBlocks =
      Array.isArray(candidate.content) &&
      candidate.content.some((block: any) => typeof block === 'string' || typeof block?.text === 'string');
    const hasDiffLike =
      typeof candidate.diff === 'string' ||
      typeof candidate.newText === 'string' ||
      typeof candidate.oldText === 'string' ||
      typeof candidate.new_string === 'string' ||
      typeof candidate.old_string === 'string';

    if (hasReplacementArray || hasTextContent || hasContentBlocks || hasDiffLike) {
      pushEdit(candidate, candidateFilePath);
    }

    if (candidate.edit) {
      const editPath = candidate.edit?.file_path || candidate.edit?.filePath || candidateFilePath;
      visit(candidate.edit, editPath);
    }

    if (Array.isArray(candidate.edits)) {
      candidate.edits.forEach((entry: any) => {
        const entryPath = entry?.file_path || entry?.filePath || candidateFilePath;
        visit(entry, entryPath);
      });
    }

    Object.entries(candidate).forEach(([key, child]) => {
      if (key === 'edit' || key === 'edits' || key === 'replacements') {
        return;
      }

      if (typeof child === 'string' && looksLikeJson(child)) {
        const parsed = safeParseJson(child);
        if (parsed) {
          visit(parsed, candidateFilePath);
        }
        return;
      }

      if (child && typeof child === 'object') {
        visit(child, candidateFilePath);
      }
    });
  };

  // Codex ACP `apply_patch` carries its diff under `changes: { [path]: { type, unified_diff } }`
  // in either args or result. Detect first so the rest of the recursive walk
  // doesn't fall back to dumping the raw JSON.
  const fromArgs = extractApplyPatchChanges((args as any)?.changes);
  if (fromArgs.length > 0) {
    return fromArgs;
  }
  const resultObj =
    typeof tool.result === 'string' && looksLikeJson(tool.result)
      ? safeParseJson(tool.result)
      : tool.result;
  const fromResult = extractApplyPatchChanges((resultObj as any)?.changes);
  if (fromResult.length > 0) {
    return fromResult;
  }

  // Note: toolCall.changes contains {path, patch} metadata -- not edit instructions.
  // Edits are extracted from tool arguments and result payloads via visit() below.

  if (args) {
    visit(args);
  }

  if (tool.result) {
    visit(tool.result);
  }

  return edits;
};

// Helper to extract text content from tool result
const extractResultText = (result: any): string | null => {
  if (typeof result === 'string') {
    return result;
  }

  // Handle array of content blocks (Anthropic format)
  if (Array.isArray(result)) {
    const textParts: string[] = [];
    for (const block of result) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      }
    }
    return textParts.length > 0 ? textParts.join('\n') : null;
  }

  return null;
};

export const TranscriptToolCard = React.memo(function TranscriptToolCard({
  toolMsg,
  toolIndex,
  depth,
  isExpanded,
  superseded,
  skipped,
  shared,
  subagentContext,
}: TranscriptToolCardProps): JSX.Element | null {
  // The card is memoized, so it subscribes to the widget registry itself:
  // extension enable/disable must swap widgets without a session reload.
  useTranscriptToolWidgetRegistryVersion();

  const { sessionId, workspacePath, readFile, onOpenFile, onOpenSession, renderEmbeddedFile, canEmbedFile, loadToolCallDiffs, onToggleTool } = shared;
  const tool = toolMsg.toolCall;
  const toolId = getToolExpandId(toolMsg, toolIndex);
  const onToggle = useCallback(() => onToggleTool(toolId), [onToggleTool, toolId]);

  const providerToolCallId = tool?.providerToolCallId;
  const createdAtMs = toolMsg.createdAt?.getTime();
  const lazyDiffLoader = useMemo(
    () => (providerToolCallId && loadToolCallDiffs
      ? () => loadToolCallDiffs(providerToolCallId, createdAtMs)
      : undefined),
    [providerToolCallId, createdAtMs, loadToolCallDiffs]
  );

  const CustomWidget = tool?.toolName ? getCustomToolWidget(tool.toolName) : undefined;

  // Codex `file_change` carries its patch text in the tool arguments, so it
  // renders as a red/green diff without any main-side enrichment.
  const editEntries = useMemo(() => {
    const call = toolMsg.toolCall;
    if (!call || CustomWidget) return NO_EDITS;
    if (call.toolName === 'file_change') {
      return extractCodexFileChanges((call.arguments as Record<string, any> | undefined)?.changes);
    }
    return isEditToolName(call.toolName) ? extractEditsFromToolMessage(toolMsg) : NO_EDITS;
  }, [toolMsg, CustomWidget]);

  if (!tool) return null;

  // Hide Task tool calls that were cancelled as siblings of a parallel spawn.
  // These get exactly "<tool_use_error>Sibling tool call errored</tool_use_error>"
  // as their result and were never actually started.
  if (tool.toolName === 'Task' && toolMsg.isError) {
    const result = tool.result;
    const resultStr = typeof result === 'string' ? result : '';
    if (/^\s*(<tool_use_error>)?\s*Sibling tool call errored\s*(<\/tool_use_error>)?\s*$/.test(resultStr)) {
      return null;
    }
  }

  const isSubAgent = toolMsg.type === 'subagent';
  const isTeammate = isSubAgent && !!(toolMsg.subagent?.teammateName || toolMsg.subagent?.teamName);
  const hasChildren = isSubAgent && toolMsg.subagent?.childEvents && toolMsg.subagent.childEvents.length > 0;

  if (CustomWidget) {
    return (
      <div
        data-transcript-tool-id={depth === 0 && !superseded ? tool.providerToolCallId : undefined}
        className={`rich-transcript-tool-container mb-2 ${depth > 0 ? 'nested ml-0' : ''}`}
        style={{ marginLeft: depth > 0 ? '1rem' : '0' }}
      >
        <ToolWidgetErrorBoundary toolName={tool.toolName}>
          <CustomWidget
            message={toolMsg}
            isExpanded={isExpanded}
            onToggle={onToggle}
            workspacePath={workspacePath}
            sessionId={sessionId}
            readFile={readFile}
            loadToolCallDiffs={lazyDiffLoader}
            superseded={skipped}
          />
        </ToolWidgetErrorBoundary>
      </div>
    );
  }

  if (editEntries.length > 0) {
    return (
      <div
        className={`rich-transcript-tool-container mb-2 ${depth > 0 ? 'nested ml-0' : ''}`}
        style={{ marginLeft: depth > 0 ? '1rem' : '0' }}
      >
        <EditToolResultCard
          toolMessage={toolMsg}
          edits={editEntries}
          workspacePath={workspacePath}
          onOpenFile={onOpenFile}
          renderEmbeddedFile={renderEmbeddedFile}
          canEmbedFile={canEmbedFile}
        />
      </div>
    );
  }

  const toolDisplayName = formatToolDisplayName(tool.toolName || '') || tool.toolName || 'Tool';

  // Extract description from arguments for sub-agents
  const toolArgs = tool.arguments as Record<string, any> | undefined;
  const description = (isSubAgent && toolArgs?.description ? toolArgs.description : null) as string | null;
  const prompt = (isSubAgent && toolArgs?.prompt ? toolArgs.prompt : null) as string | null;
  const subagentAuditLabel = isSubAgent
    ? formatSubagentAuditLabel(toolMsg.subagent?.model, toolMsg.subagent?.reasoningEffort)
    : null;

  // Extract result text
  const resultText = tool.result ? extractResultText(tool.result) : null;

  // Special styling for sub-agents and teammates
  const cardClass = isTeammate
    ? 'rich-transcript-tool-card teammate rounded border border-[var(--nim-border)] overflow-hidden'
    : isSubAgent
      ? 'rich-transcript-tool-card sub-agent rounded border border-[var(--nim-border)] overflow-hidden'
      : depth > 0
        ? 'rich-transcript-tool-card child-tool rounded border border-[var(--nim-border)] overflow-hidden bg-[var(--nim-bg-tertiary)]'
        : 'rich-transcript-tool-card rounded border border-[var(--nim-border)] overflow-hidden bg-[var(--nim-bg-secondary)]';

  return (
    <div className={`rich-transcript-tool-container mb-2 ${depth > 0 ? 'nested ml-0' : ''}`} style={{ marginLeft: depth > 0 ? '1rem' : '0' }}>
      <div className={cardClass}>
        <button onClick={onToggle} className="rich-transcript-tool-button w-full py-1 px-2 flex items-center gap-1.5 text-left border-none cursor-pointer text-sm bg-transparent">
          {isTeammate ? (
            // Group icon for team teammates
            <MaterialSymbol icon="group" size={16} className="rich-transcript-tool-icon sub-agent-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
          ) : isSubAgent && toolArgs?.run_in_background ? (
            // Cloud icon for background (async) agents
            <MaterialSymbol icon="cloud_sync" size={16} className="rich-transcript-tool-icon sub-agent-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
          ) : isSubAgent ? (
            // Document icon for synchronous sub-agents
            <MaterialSymbol icon="description" size={16} className="rich-transcript-tool-icon sub-agent-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
          ) : (
            // Wrench icon for regular tools
            <MaterialSymbol icon="build" size={16} className="rich-transcript-tool-icon w-4 h-4 text-[var(--nim-primary)] shrink-0" />
          )}
          <span className="rich-transcript-tool-name font-mono text-sm text-[var(--nim-text)] font-medium" title={tool.toolName || undefined}>
            {isTeammate
              ? (toolMsg.subagent?.teammateName || 'Teammate')
              : isSubAgent
                ? (toolArgs?.run_in_background ? 'Background Agent' : 'Sub-Agent')
                : toolDisplayName}
            {isTeammate && toolMsg.subagent?.teammateMode && (
              <span className="rich-transcript-tool-subagent-type text-[var(--nim-text-muted)] font-normal text-xs ml-1">({toolMsg.subagent?.teammateMode})</span>
            )}
            {isSubAgent && !isTeammate && toolMsg.subagent?.agentType && (
              <span className="rich-transcript-tool-subagent-type text-[var(--nim-primary)] font-semibold"> [{toolMsg.subagent?.agentType}]</span>
            )}
          </span>
          {subagentAuditLabel && (
            <span
              className="rich-transcript-subagent-audit min-w-0 max-w-40 truncate text-[11px] text-[var(--nim-text-muted)]"
              aria-label={subagentAuditLabel}
              title={subagentAuditLabel}
            >
              {toolMsg.subagent?.model}{toolMsg.subagent?.model && toolMsg.subagent?.reasoningEffort ? ' · ' : ''}{toolMsg.subagent?.reasoningEffort}
            </span>
          )}
          {!isSubAgent && tool.arguments && (() => {
            const argStr = formatToolArguments(tool.toolName, tool.arguments, workspacePath);
            if (!argStr) return null;

            // Check if there's a clickable file path (only for tools that reference actual files)
            const filePath = extractFilePathFromArgs(tool.toolName, tool.arguments);
            const isClickable = onOpenFile && filePath;

            if (isClickable) {
              return (
                <span
                  role="link"
                  tabIndex={0}
                  className="rich-transcript-tool-args rich-transcript-tool-args-link text-[var(--nim-text-muted)] flex-1 overflow-hidden text-ellipsis whitespace-nowrap bg-transparent border-none p-0 m-0 font-inherit text-[var(--nim-link)] cursor-pointer no-underline text-left hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenFile(filePath);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      onOpenFile(filePath);
                    }
                  }}
                  title={`Open ${filePath}`}
                >
                  {argStr}
                </span>
              );
            }
            return <span className="rich-transcript-tool-args text-[var(--nim-text-muted)] flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{argStr}</span>;
          })()}
          {/* Status indicator: sub-agents/teammates show live status, regular tools show success/error */}
          {isSubAgent ? (() => {
            // Look up teammate status from session metadata
            // Try tool.teammateAgentId first, then extract agent_id from result text
            let agentId = toolMsg.subagentId;
            if (!agentId && tool.result && typeof tool.result === 'string') {
              const match = tool.result.match(/agent_id:\s*(\S+)/);
              if (match) agentId = match[1].replace(/[.,]$/, '');
            }
            const teammateStatus = agentId ? subagentContext?.currentTeammates?.find(t => t.agentId === agentId)?.status : undefined;
            // If no metadata yet but spawn succeeded (isError due to interception), assume running
            const effectiveStatus = teammateStatus || (tool.result && toolMsg.isError ? 'running' : tool.result ? 'completed' : null);
            if (effectiveStatus === 'running') {
              return (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="inline-block w-3 h-3 border-2 border-[var(--nim-bg-tertiary)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
                  <span className="text-[11px] text-[var(--nim-text-muted)]">Running</span>
                </span>
              );
            }
            if (effectiveStatus === 'idle') {
              return (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-[var(--nim-primary)] text-[10px]">&#9675;</span>
                  <span className="text-[11px] text-[var(--nim-text-muted)]">Idle</span>
                </span>
              );
            }
            if (effectiveStatus === 'completed') {
              return (
                <span className="flex items-center gap-1 shrink-0">
                  <MaterialSymbol icon="check_circle" size={14} className="text-[var(--nim-success)]" />
                  <span className="text-[11px] text-[var(--nim-text-muted)]">Done</span>
                </span>
              );
            }
            if (effectiveStatus === 'errored') {
              return (
                <span className="flex items-center gap-1 shrink-0">
                  <MaterialSymbol icon="cancel" size={14} className="text-[var(--nim-error)]" />
                  <span className="text-[11px] text-[var(--nim-text-muted)]">Errored</span>
                </span>
              );
            }
            // Still waiting for result / no status yet - show progress spinner if available
            if (!tool.result && tool.progress.length > 0) {
              return (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="inline-block w-3 h-3 border-2 border-[var(--nim-primary)] border-t-transparent rounded-full animate-spin" />
                  <span className="text-[11px] text-[var(--nim-text-muted)]">Running</span>
                </span>
              );
            }
            return null;
          })() : (
            <>
              {tool.result && !toolMsg.isError && (
                <MaterialSymbol icon="check_circle" size={16} className="rich-transcript-tool-success w-4 h-4 text-[var(--nim-success)] shrink-0" />
              )}
              {tool.result && toolMsg.isError && (
                <MaterialSymbol icon="cancel" size={16} className="rich-transcript-tool-error w-4 h-4 text-[var(--nim-error)] shrink-0" />
              )}
            </>
          )}
          <MaterialSymbol icon={isExpanded ? "expand_more" : "chevron_right"} size={16} className="rich-transcript-tool-chevron w-3 h-3 text-[var(--nim-text-faint)]" />
        </button>

        {isExpanded && (
          <div className="rich-transcript-tool-expanded p-2 text-sm border-t border-[var(--nim-border)]">
            {/* Show description for sub-agents */}
            {isSubAgent && description && (
              <div className="rich-transcript-tool-section mb-1.5">
                <div className="rich-transcript-tool-description text-sm text-[var(--nim-text)] leading-relaxed mb-2">{description}</div>
              </div>
            )}

            {/* Show prompt for sub-agents (collapsable) */}
            {isSubAgent && prompt && (
              <details className="rich-transcript-tool-details my-2">
                <summary className="rich-transcript-tool-details-summary text-xs text-[var(--nim-text-faint)] cursor-pointer py-1 select-none hover:text-[var(--nim-text-muted)]">View full prompt</summary>
                <div className="rich-transcript-tool-details-content mt-1 text-sm">
                  <MarkdownRenderer content={prompt} isUser={false} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                </div>
              </details>
            )}

            {/* Show regular tool arguments (not for sub-agents) */}
            {!isSubAgent && tool.arguments && Object.keys(tool.arguments).length > 0 && (
              <div className="rich-transcript-tool-section mb-1.5">
                <div className="rich-transcript-tool-section-label text-[var(--nim-text-faint)] mb-0.5 text-xs">Arguments:</div>
                <JSONViewer data={tool.arguments} maxHeight="16rem" />
              </div>
            )}

            {/* Recursively render child tools */}
            {hasChildren && (
              <div className="rich-transcript-tool-section mb-1.5">
                <div className="rich-transcript-tool-section-label text-[var(--nim-text-faint)] mb-0.5 text-xs">
                  {isTeammate ? 'Teammate' : 'Sub-agent'} Actions ({(toolMsg.subagent?.childEvents ?? []).length}):
                </div>
                <div className="rich-transcript-subagent-children flex flex-col gap-1 mt-2">
                  {(toolMsg.subagent?.childEvents ?? []).map((childMsg: TranscriptViewMessage, childIdx: number) => {
                    const childCallId = childMsg.toolCall?.providerToolCallId;
                    return (
                      <TranscriptToolCard
                        key={getTranscriptToolKey(childMsg, childIdx, depth + 1)}
                        toolMsg={childMsg}
                        toolIndex={childIdx}
                        depth={depth + 1}
                        isExpanded={subagentContext?.expandedTools.has(getToolExpandId(childMsg, childIdx)) ?? false}
                        superseded={false}
                        skipped={childCallId ? (subagentContext?.skippedQuestionIds.has(childCallId) ?? false) : undefined}
                        shared={shared}
                        subagentContext={childMsg.type === 'subagent' ? subagentContext : undefined}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* Show progress indicator for running sub-agents/teammates */}
            {isSubAgent && !tool.result && tool.progress.length > 0 && (
              <div className="rich-transcript-tool-section mb-1.5 flex items-center gap-2 text-xs text-[var(--nim-text-muted)]">
                <span className="inline-block w-3 h-3 border-2 border-[var(--nim-primary)] border-t-transparent rounded-full animate-spin" />
                <span>Running <span className="font-mono text-[var(--nim-text)]">{tool.progress[tool.progress.length - 1]?.progressContent}</span></span>
                <span>({Math.round(tool.progress[tool.progress.length - 1]?.elapsedSeconds ?? 0)}s)</span>
              </div>
            )}

            {/* Show result - extract text from JSON if possible */}
            {tool.result && (
              <details className="rich-transcript-tool-details my-2" open={!isSubAgent}>
                <summary className="rich-transcript-tool-details-summary text-xs text-[var(--nim-text-faint)] cursor-pointer py-1 select-none hover:text-[var(--nim-text-muted)]">
                  {isSubAgent ? 'View result' : 'Result'}
                </summary>
                <div className="rich-transcript-tool-details-content mt-1 text-sm">
                  {resultText ? (
                    <MarkdownRenderer content={resultText} isUser={false} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                  ) : typeof tool.result === 'string' ? (
                    <MarkdownRenderer content={tool.result} isUser={false} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
                  ) : (
                    <JSONViewer data={tool.result} maxHeight="16rem" />
                  )}
                </div>
              </details>
            )}

            {/* File changes caused by this tool call */}
            {!isSubAgent && ((tool.fileDiffs && tool.fileDiffs.length > 0) || lazyDiffLoader) && (
              <ToolCallChanges
                diffs={tool.fileDiffs}
                isExpanded={isExpanded}
                workspacePath={workspacePath}
                onOpenFile={onOpenFile}
                renderEmbeddedFile={renderEmbeddedFile}
                canEmbedFile={canEmbedFile}
                loadDiffs={lazyDiffLoader}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});
