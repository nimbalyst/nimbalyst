/**
 * Shared pending-interactive-prompt extraction and formatting for session
 * summaries. The session-context MCP reads raw ai_agent_messages while voice
 * summaries receive projected transcript messages, so both paths normalize to
 * the same short human-readable descriptions here.
 */

interface RawSummaryRow {
  content: string;
}

interface PendingToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, any>;
}

const INTERACTIVE_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'PromptForUserInput',
  'RequestUserInput',
  'ToolPermission',
  'ExitPlanMode',
  'developer_git_commit_proposal',
]);

function normalizedToolName(toolName: unknown): string {
  if (typeof toolName !== 'string') return '';
  const parts = toolName.split('__');
  return parts[parts.length - 1] || toolName;
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim();
}

function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (typeof option === 'string') return option.trim();
      if (typeof option?.label === 'string') return option.label.trim();
      if (typeof option?.title === 'string') return option.title.trim();
      return '';
    })
    .filter(Boolean);
}

/** Describe one canonical prompt payload or one pending transcript tool call. */
export function describePendingPrompt(prompt: any): string | null {
  if (!prompt || typeof prompt !== 'object') return null;

  const promptType = typeof prompt.promptType === 'string' ? prompt.promptType : '';
  const toolName = normalizedToolName(prompt.toolName ?? prompt.name);
  const args = (prompt.arguments ?? prompt.input ?? prompt) as Record<string, any>;

  if (promptType === 'ask_user_question' || toolName === 'AskUserQuestion') {
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const parts = questions
      .map((question: any) => {
        const text = typeof question?.question === 'string'
          ? question.question.trim()
          : typeof question?.text === 'string'
            ? question.text.trim()
            : '';
        if (!text) return null;
        const options = optionLabels(question.options);
        return options.length > 0 ? `${text} (options: ${options.join(', ')})` : text;
      })
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? `Question: ${parts.join(' ')}` : null;
  }

  if (toolName === 'PromptForUserInput' || toolName === 'RequestUserInput') {
    const title = typeof args.title === 'string' && args.title.trim()
      ? args.title.trim()
      : typeof args.intro === 'string' && args.intro.trim()
        ? firstLine(args.intro)
        : 'Input requested';
    const fieldLabels = Array.isArray(args.fields)
      ? args.fields
        .map((field: any) => typeof field?.label === 'string' ? field.label.trim() : '')
        .filter(Boolean)
      : [];
    return `Question: ${title}${fieldLabels.length > 0 ? ` (${fieldLabels.join('; ')})` : ''}`;
  }

  if (promptType === 'permission_request' || toolName === 'ToolPermission') {
    const tool = typeof args.toolName === 'string' && args.toolName.trim()
      ? args.toolName.trim()
      : 'a tool';
    const command = typeof args.rawCommand === 'string' ? args.rawCommand.trim() : '';
    return `Permission needed to run ${tool}${command ? `: ${command}` : ''}`;
  }

  if (promptType === 'git_commit_proposal' || toolName === 'developer_git_commit_proposal') {
    const files = Array.isArray(args.stagedFiles)
      ? args.stagedFiles
      : Array.isArray(args.filesToStage)
        ? args.filesToStage
        : [];
    const commitMessage = typeof args.commitMessage === 'string'
      ? firstLine(args.commitMessage)
      : '';
    return `Approval needed to commit ${files.length} file${files.length === 1 ? '' : 's'}`
      + `${commitMessage ? `: ${commitMessage}` : ''}`;
  }

  if (promptType === 'exit_plan_mode' || toolName === 'ExitPlanMode') {
    const planFilePath = typeof args.planFilePath === 'string' ? args.planFilePath.trim() : '';
    return `Approval needed for the proposed plan${planFilePath ? `: ${planFilePath}` : ''}`;
  }

  return null;
}

function addPendingTool(
  pending: Map<string, PendingToolCall>,
  id: unknown,
  toolName: unknown,
  args: unknown,
): void {
  if (typeof id !== 'string' || !id) return;
  const normalized = normalizedToolName(toolName);
  if (!INTERACTIVE_TOOL_NAMES.has(normalized)) return;
  pending.set(id, {
    id,
    toolName: normalized,
    arguments: args && typeof args === 'object' ? args as Record<string, any> : {},
  });
}

function settlePrompt(pending: Map<string, PendingToolCall>, ...ids: unknown[]): void {
  for (const id of ids) {
    if (typeof id === 'string' && id) pending.delete(id);
  }
}

/**
 * Find unresolved interactive prompts in raw ai_agent_messages rows. Rows must
 * be ordered oldest-to-newest. Both structured assistant tool_use blocks and
 * Nimbalyst's synthetic prompt/response records are supported.
 */
export function collectPendingPromptDescriptionsFromRawRows(
  rows: RawSummaryRow[],
): string[] {
  const pending = new Map<string, PendingToolCall>();

  for (const row of rows) {
    let parsed: any;
    try {
      parsed = JSON.parse(row.content);
    } catch {
      continue;
    }

    if (parsed?.type === 'nimbalyst_tool_use') {
      addPendingTool(pending, parsed.id ?? parsed.input?.requestId, parsed.name, parsed.input);
    }

    if (parsed?.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      for (const block of parsed.message.content) {
        if (block?.type === 'tool_use') {
          addPendingTool(pending, block.id, block.name, block.input ?? block.arguments);
        } else if (block?.type === 'tool_result') {
          settlePrompt(pending, block.tool_use_id ?? block.id);
        }
      }
    }

    if (parsed?.type === 'user' && Array.isArray(parsed.message?.content)) {
      for (const block of parsed.message.content) {
        if (block?.type === 'tool_result') {
          settlePrompt(pending, block.tool_use_id ?? block.id);
        }
      }
    }

    if (parsed?.type === 'nimbalyst_tool_result') {
      settlePrompt(pending, parsed.tool_use_id ?? parsed.id);
    } else if (parsed?.type === 'ask_user_question_response') {
      settlePrompt(pending, parsed.questionId, parsed.requestId);
    } else if (parsed?.type === 'permission_response') {
      settlePrompt(pending, parsed.requestId);
    } else if (parsed?.type === 'request_user_input_response') {
      settlePrompt(pending, parsed.promptId, parsed.rawPromptId);
    } else if (parsed?.type === 'git_commit_proposal_response') {
      settlePrompt(pending, parsed.proposalId, parsed.toolUseId);
    } else if (parsed?.type === 'exit_plan_mode_response') {
      settlePrompt(pending, parsed.requestId);
    }

    if (parsed?.type === 'git_commit_proposal' && parsed.status === 'pending') {
      addPendingTool(
        pending,
        parsed.proposalId ?? parsed.toolUseId,
        'developer_git_commit_proposal',
        {
          filesToStage: parsed.filesToStage,
          commitMessage: parsed.commitMessage,
        },
      );
    } else if (parsed?.type === 'exit_plan_mode_request' && parsed.status === 'pending') {
      addPendingTool(pending, parsed.requestId, 'ExitPlanMode', parsed);
    }
  }

  return [...new Set(
    [...pending.values()]
      .map((prompt) => describePendingPrompt(prompt))
      .filter((description): description is string => Boolean(description)),
  )];
}

/** Collect unresolved prompts from renderer-projected transcript messages. */
export function collectPendingPromptDescriptionsFromTranscript(messages: any[]): string[] {
  const descriptions: string[] = [];

  for (const message of messages) {
    if (message?.type === 'interactive_prompt') {
      const prompt = message.interactivePrompt;
      if (prompt?.status === 'pending') {
        const description = describePendingPrompt(prompt);
        if (description) descriptions.push(description);
      }
      continue;
    }

    const toolCall = message?.toolCall;
    if (!toolCall || !INTERACTIVE_TOOL_NAMES.has(normalizedToolName(toolCall.toolName))) {
      continue;
    }
    if (
      toolCall.status === 'completed'
      || toolCall.status === 'error'
      || toolCall.status === 'resolved'
      || toolCall.status === 'cancelled'
      || (toolCall.result !== undefined && toolCall.result !== null && toolCall.result !== '')
    ) {
      continue;
    }

    const description = describePendingPrompt({
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
    });
    if (description) descriptions.push(description);
  }

  return [...new Set(descriptions)];
}

/** Append actionable pending prompts after every other summary section. */
export function appendPendingPromptSection(
  summary: string,
  pendingPrompts: string[],
): string {
  if (pendingPrompts.length === 0) return summary;
  const section = `This session is waiting for your input:\n${pendingPrompts
    .map((prompt) => `- ${prompt}`)
    .join('\n')}`;
  return summary.length > 0 ? `${summary.trimEnd()}\n\n${section}` : section;
}
