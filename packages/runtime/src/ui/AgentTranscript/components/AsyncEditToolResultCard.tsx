/**
 * AsyncEditToolResultCard - red/green diff card for tool calls whose raw
 * canonical event carries no diff content.
 *
 * OpenAI Codex SDK's `file_change` tool emits an item.completed payload that
 * only names the file paths and kinds (`{ path, kind }`); it does not include
 * before/after content. The diff has to be fetched from local-history via the
 * synthetic edit-group ID (`nimtc|...`) that the workstream's Phase 1-3 work
 * stamps onto:
 *   - the canonical tool_call event's `providerToolCallId`
 *   - `session_files.metadata.toolUseId`
 *   - `document_history` tag IDs (`ai-edit-pending-<sessionId>-<groupId>`)
 *
 * `getToolCallDiffs(toolCallItemId, timestamp)` does the join and returns the
 * red/green pairs; we map those into the same edit-record shape `EditToolResultCard`
 * already renders for Claude's Edit tool, so the visual is identical.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import type { ToolCallDiffResult } from './CustomToolWidgets';
import { EditToolResultCard } from './EditToolResultCard';
import { toolCallDiffsToEdits } from './RichTranscriptView';

interface AsyncEditToolResultCardProps {
  toolMessage: TranscriptViewMessage;
  workspacePath?: string;
  onOpenFile?: (filePath: string) => void;
  getToolCallDiffs: (
    toolCallItemId: string,
    toolCallTimestamp?: number
  ) => Promise<ToolCallDiffResult[] | null>;
}

export const AsyncEditToolResultCard: React.FC<AsyncEditToolResultCardProps> = ({
  toolMessage,
  workspacePath,
  onOpenFile,
  getToolCallDiffs,
}) => {
  const [edits, setEdits] = useState<any[] | null>(null);
  const fetchedRef = useRef(false);

  const tool = toolMessage.toolCall;
  const lookupId = tool?.providerToolCallId || tool?.toolName || undefined;
  const timestamp = toolMessage.createdAt instanceof Date
    ? toolMessage.createdAt.getTime()
    : undefined;

  useEffect(() => {
    fetchedRef.current = false;
    setEdits(null);
  }, [lookupId, timestamp]);

  useEffect(() => {
    if (!lookupId || fetchedRef.current) return;
    fetchedRef.current = true;
    let cancelled = false;
    getToolCallDiffs(lookupId, timestamp)
      .then((result) => {
        if (cancelled) return;
        if (!result || result.length === 0) {
          setEdits([]);
          return;
        }
        setEdits(toolCallDiffsToEdits(result));
      })
      .catch(() => {
        if (!cancelled) setEdits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [lookupId, timestamp, getToolCallDiffs]);

  if (!tool) return null;
  // While loading: render nothing. The matcher resolves quickly enough that a
  // spinner would flash; ToolCallChanges takes the same approach.
  if (edits === null) return null;
  if (edits.length === 0) return null;

  return (
    <EditToolResultCard
      toolMessage={toolMessage}
      edits={edits}
      workspacePath={workspacePath}
      onOpenFile={onOpenFile}
    />
  );
};
