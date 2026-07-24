import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { sessionMessagesAtom, isInteractivePromptTool } from '../../store/atoms/sessions';
import {
  getCustomToolWidget,
  ToolWidgetErrorBoundary,
} from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets';

export interface ClaudeCliPromptSurfaceProps {
  sessionId: string;
  workspacePath: string;
}

/**
 * Slim durable-prompt surface for `claude-code-cli` sessions (NIM-806, Phase 1).
 *
 * The genuine CLI runs terminal-only, so the full `AgentTranscriptPanel` (which
 * normally renders interactive widgets) is not mounted. But the CLI still calls
 * the same sessionId-bearing `mcp__nimbalyst-mcp__*` interactive tools the Agent
 * SDK does (commit proposal, AskUserQuestion, PromptForUserInput, ExitPlanMode,
 * tool permission) — and those MCP handlers BLOCK until a Nimbalyst widget answers
 * them. This surface renders just the *pending* interactive prompts above the
 * terminal so the user can answer them; the `InteractiveWidgetHost` that wires the
 * answer back is already registered for every session in `SessionTranscript`.
 *
 * It reuses the exact widget dispatch (`getCustomToolWidget`) and the exact
 * pending-prompt predicate (`isInteractivePromptTool` + missing `result`) the
 * transcript uses, so behavior matches the SDK path. When nothing is pending it
 * renders nothing and the terminal gets the full height.
 */
const readFile = async (
  filePath: string
): Promise<{ success: boolean; content?: string; error?: string }> => {
  try {
    const result = await window.electronAPI.readFileContent(filePath);
    if (!result) return { success: false, error: `File not found: ${filePath}` };
    if (!result.success) return { success: false, error: result.error || 'Failed to read file' };
    return { success: true, content: result.content };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to read file' };
  }
};

export const ClaudeCliPromptSurface: React.FC<ClaudeCliPromptSurfaceProps> = ({
  sessionId,
  workspacePath,
}) => {
  const messages = useAtomValue(sessionMessagesAtom(sessionId));

  const pendingPrompts = useMemo(
    () =>
      messages.filter(
        (m) =>
          !!m.toolCall?.toolName &&
          isInteractivePromptTool(m.toolCall.toolName) &&
          !m.toolCall.result
      ),
    [messages]
  );

  if (pendingPrompts.length === 0) return null;

  return (
    <div
      className="claude-cli-prompt-surface flex-shrink-0 overflow-y-auto border-b border-nim-border bg-nim-bg-secondary"
      style={{ maxHeight: '50%' }}
      data-testid="claude-cli-prompt-surface"
    >
      <div className="flex flex-col gap-2 p-2">
        {pendingPrompts.map((message, index) => {
          const toolName = message.toolCall!.toolName!;
          const Widget = getCustomToolWidget(toolName);
          if (!Widget) return null;
          return (
            <ToolWidgetErrorBoundary
              key={message.toolCall!.providerToolCallId ?? toolName ?? index}
              toolName={toolName}
            >
              <Widget
                message={message}
                isExpanded={true}
                onToggle={() => {}}
                workspacePath={workspacePath}
                sessionId={sessionId}
                readFile={readFile}
              />
            </ToolWidgetErrorBoundary>
          );
        })}
      </div>
    </div>
  );
};

export default ClaudeCliPromptSurface;
