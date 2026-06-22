/**
 * Transcript UI Widget Tests
 *
 * Tests the rendering contract of transcript widgets:
 * - MessageSegment (user, assistant, system, error, tool calls)
 * - BashWidget (command display, output, status indicators)
 * - EditToolResultCard (file path, edit count, status)
 * - ToolPermissionWidget (pending, granted, denied states)
 * - AskUserQuestionWidget (questions, options, completed states)
 * - GitCommitConfirmationWidget (pending, committed, cancelled states)
 * - ExitPlanModeWidget (pending, approved, denied states)
 * - ContextLimitWidget (error display, compact button)
 * - FileChangeWidget (collapsed/expanded, file list)
 * - InteractivePromptWidget (permission and question prompt types)
 * - UpdateSessionMetaWidget (name/phase/tags transitions, fallback states)
 * - TrackerToolWidget (structured tracker results, legacy tag normalization)
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as rtl from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import type { CustomToolWidgetProps } from '../CustomToolWidgets/index';

const { render, screen, fireEvent } = rtl;

// Mock clipboard
vi.mock('../../../../utils/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

// Mock unwrapShellCommand (pass-through)
vi.mock('../../utils/unwrapShellCommand', () => ({
  unwrapShellCommand: (cmd: string) => cmd,
}));

// Mock posthog-js/react
vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

// ============================================================================
// Type Helpers (mirrors internal types from widgets for test clarity)
// ============================================================================

interface StructuredSessionMetaResult {
  summary: string;
  before: { name: string | null; tags: string[]; phase: string | null };
  after: { name: string | null; tags: string[]; phase: string | null };
}

// ============================================================================
// Test Helpers
// ============================================================================

function createStore_() {
  return createStore();
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const store = createStore_();
  return <JotaiProvider store={store}>{children}</JotaiProvider>;
}

let nextTestId = 1;

function makeMessage(overrides: Partial<TranscriptViewMessage> = {}): TranscriptViewMessage {
  return {
    id: nextTestId++,
    sequence: nextTestId,
    createdAt: new Date(),
    type: 'assistant_message',
    subagentId: null,
    ...overrides,
  };
}

function makeToolMessage(
  toolName: string,
  args: Record<string, unknown> = {},
  result?: unknown,
  overrides: Partial<TranscriptViewMessage> = {}
): TranscriptViewMessage {
  return makeMessage({
    type: 'tool_call',
    toolCall: {
      toolName,
      toolDisplayName: toolName,
      status: result !== undefined ? 'completed' : 'running',
      description: null,
      arguments: args,
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: `tool-${Date.now()}`,
      progress: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result: result != null ? (typeof result === 'string' ? result : JSON.stringify(result)) : undefined,
    },
    ...overrides,
  });
}

// ============================================================================
// MessageSegment Tests
// ============================================================================

describe('MessageSegment', () => {
  let MessageSegment: React.FC<any>;

  beforeEach(async () => {
    const mod = await import('../MessageSegment');
    MessageSegment = mod.MessageSegment;
  });

  it('renders user message text', () => {
    const message = makeMessage({ type: 'user_message', text: 'Hello world' });
    render(
      <MessageSegment
        message={message}
        isUser={true}
        showToolCalls={false}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
      />
    );
    expect(screen.getByText('Hello world')).toBeDefined();
  });

  it('strips NIMBALYST_SYSTEM_MESSAGE from user messages', () => {
    const message = makeMessage({
      type: 'user_message',
      text: 'User text\n<NIMBALYST_SYSTEM_MESSAGE>hidden</NIMBALYST_SYSTEM_MESSAGE>',
    });
    render(
      <MessageSegment
        message={message}
        isUser={true}
        showToolCalls={false}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
      />
    );
    expect(screen.getByText('User text')).toBeDefined();
    expect(screen.queryByText('hidden')).toBeNull();
  });

  it('renders error messages with error styling', () => {
    const message = makeMessage({
      type: 'assistant_message',
      text: 'Something went wrong',
      isError: true,
    });
    const { container } = render(
      <MessageSegment
        message={message}
        isUser={false}
        showToolCalls={false}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
      />
    );
    expect(screen.getByText('Something went wrong')).toBeDefined();
    // Should have error styling (red background)
    const errorDiv = container.querySelector('.text-nim-error');
    expect(errorDiv).not.toBeNull();
  });

  it('renders the Codex auth required CTA when isCodexAuthRequired is set', () => {
    const message = makeMessage({
      type: 'system_message',
      text: 'Error: Sign in to OpenAI Codex to continue.',
      isError: true,
      isCodexAuthRequired: true,
    });
    const { container } = render(
      <MessageSegment
        message={message}
        isUser={false}
        showToolCalls={false}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
        shouldShowLoginWidget={true}
      />
    );
    const widget = container.querySelector('[data-testid="codex-auth-required-widget"]');
    expect(widget).not.toBeNull();
    expect(widget?.textContent ?? '').toMatch(/Sign in to OpenAI Codex to continue/i);
    const signInBtn = container.querySelector('[data-testid="codex-auth-required-sign-in"]') as HTMLButtonElement | null;
    expect(signInBtn).not.toBeNull();

    // Generic error styling MUST NOT appear when the CTA takes over.
    expect(container.querySelector('.text-nim-error')).toBeNull();

    const events: Array<{ anchor?: string }> = [];
    const listener = (e: Event) => {
      events.push((e as CustomEvent<{ anchor?: string }>).detail);
    };
    window.addEventListener('nimbalyst:open-codex-auth-settings', listener);
    try {
      fireEvent.click(signInBtn!);
    } finally {
      window.removeEventListener('nimbalyst:open-codex-auth-settings', listener);
    }
    expect(events).toEqual([{ anchor: 'codex-auth-section' }]);
  });

  it('suppresses the Codex auth CTA when shouldShowLoginWidget is false', () => {
    const message = makeMessage({
      type: 'system_message',
      text: 'Error: Sign in to OpenAI Codex to continue.',
      isError: true,
      isCodexAuthRequired: true,
    });
    const { container } = render(
      <MessageSegment
        message={message}
        isUser={false}
        showToolCalls={false}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
        shouldShowLoginWidget={false}
      />
    );
    expect(container.querySelector('[data-testid="codex-auth-required-widget"]')).toBeNull();
  });

  it('renders context limit widget for context limit errors', () => {
    const message = makeMessage({
      type: 'assistant_message',
      text: 'Prompt is too long for this model',
      isError: true,
    });
    const { container } = render(
      <MessageSegment
        message={message}
        isUser={false}
        showToolCalls={false}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
      />
    );
    expect(container.querySelector('.context-limit-widget')).not.toBeNull();
  });

  it('renders tool call card with expand/collapse', () => {
    const toolId = 'test-tool-1';
    const message = makeToolMessage(
      'Read',
      { file_path: '/test.ts' },
      'file contents here',
      { toolCall: { toolName: 'Read', toolDisplayName: 'Read', status: 'completed', description: null, arguments: { file_path: '/test.ts' }, targetFilePath: null, mcpServer: null, mcpTool: null, providerToolCallId: toolId, progress: [], result: 'file contents here' } }
    );

    // Initially collapsed
    const { rerender } = render(
      <MessageSegment
        message={message}
        isUser={false}
        showToolCalls={true}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
      />
    );
    // Tool name should be visible
    expect(screen.getByText('Read')).toBeDefined();
    // Status should show "Succeeded"
    expect(screen.getByText('Succeeded')).toBeDefined();
    // Result should not be visible when collapsed
    expect(screen.queryByText('file contents here')).toBeNull();

    // Expand it
    rerender(
      <MessageSegment
        message={message}
        isUser={false}
        showToolCalls={true}
        showThinking={false}
        expandedTools={new Set([toolId])}
        onToggleToolExpand={() => {}}
      />
    );
    // Result should now be visible
    expect(screen.getByText('file contents here')).toBeDefined();
  });

  it('shows failed status for error tool calls', () => {
    const message = makeToolMessage(
      'Write',
      {},
      JSON.stringify({ success: false, error: 'Permission denied' }),
      { isError: true }
    );
    render(
      <MessageSegment
        message={message}
        isUser={false}
        showToolCalls={true}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
      />
    );
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('renders attachments for user messages', () => {
    const message = makeMessage({
      type: 'user_message',
      text: 'Check this image',
      attachments: [
        {
          id: 'att-1',
          filename: 'screenshot.png',
          filepath: '/tmp/screenshot.png',
          mimeType: 'image/png',
          size: 1024,
          type: 'image',
        },
      ],
    });
    render(
      <MessageSegment
        message={message}
        isUser={true}
        showToolCalls={false}
        showThinking={false}
        expandedTools={new Set()}
        onToggleToolExpand={() => {}}
      />
    );
    expect(screen.getByText('screenshot.png')).toBeDefined();
    expect(screen.getByText('1.0 KB')).toBeDefined();
  });
});

// ============================================================================
// BashWidget Tests
// ============================================================================

describe('BashWidget', () => {
  let BashWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/BashWidget');
    BashWidget = mod.BashWidget;
  });

  it('renders collapsed view with command and success indicator', () => {
    const message = makeToolMessage('Bash', { command: 'git status', description: 'Check git status' }, 'On branch main');
    const { container } = render(
      <Wrapper>
        <BashWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="s1"
        />
      </Wrapper>
    );
    expect(screen.getByText('Check git status')).toBeDefined();
    // Should show the command
    expect(screen.getByText('git status')).toBeDefined();
    // Should be a button (clickable to expand)
    expect(container.querySelector('button.bash-widget')).not.toBeNull();
  });

  it('renders running state with spinner', () => {
    const message = makeToolMessage('Bash', { command: 'npm install' }, undefined);
    const { container } = render(
      <Wrapper>
        <BashWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="s1"
        />
      </Wrapper>
    );
    // Should show spinner (animate-spin class)
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('renders expanded view with command, output, and copy button', () => {
    const message = makeToolMessage(
      'Bash',
      { command: 'echo hello', description: 'Say hello' },
      'hello'
    );
    const { container } = render(
      <Wrapper>
        <BashWidget
          message={message}
          isExpanded={true}
          onToggle={() => {}}
          sessionId="s1"
        />
      </Wrapper>
    );
    // Shows "Terminal" label in expanded header
    expect(screen.getByText('Terminal')).toBeDefined();
    // Shows the $ prompt with command
    expect(screen.getByText('echo hello')).toBeDefined();
    // Shows output
    expect(screen.getByText('hello')).toBeDefined();
    // Copy button present
    expect(container.querySelector('[aria-label="Copy command"]')).not.toBeNull();
  });

  it('renders error state with error styling', () => {
    const message = makeToolMessage(
      'Bash',
      { command: 'false' },
      { exit_code: 1, output: 'command failed' },
      { isError: true }
    );
    const { container } = render(
      <Wrapper>
        <BashWidget
          message={message}
          isExpanded={true}
          onToggle={() => {}}
          sessionId="s1"
        />
      </Wrapper>
    );
    // Error output should have error text styling
    const errorPre = container.querySelector('.text-nim-error');
    expect(errorPre).not.toBeNull();
  });

  it('shows "show more" button for long output', () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const message = makeToolMessage('Bash', { command: 'cat file.txt' }, longOutput);
    render(
      <Wrapper>
        <BashWidget
          message={message}
          isExpanded={true}
          onToggle={() => {}}
          sessionId="s1"
        />
      </Wrapper>
    );
    // Should show "Show N more lines" button
    expect(screen.getByText(/Show \d+ more lines/)).toBeDefined();
  });
});

// ============================================================================
// EditToolResultCard Tests
// ============================================================================

describe('EditToolResultCard', () => {
  let EditToolResultCard: React.FC<any>;

  beforeEach(async () => {
    const mod = await import('../EditToolResultCard');
    EditToolResultCard = mod.EditToolResultCard;
  });

  it('renders file path and edit count for single edit', () => {
    const message = makeToolMessage('Edit', {
      file_path: '/workspace/src/app.ts',
    }, { success: true }); // tool_result observed -> "Applied" (NIM-806 gating)
    const edits = [{ old_string: 'foo', new_string: 'bar' }];
    render(
      <EditToolResultCard
        toolMessage={message}
        edits={edits}
        workspacePath="/workspace"
      />
    );
    expect(screen.getByText('1 edit')).toBeDefined();
    // File path should be shown (project-relative) - use getAllByText since path may appear in multiple places
    const appTsElements = screen.getAllByText(/app\.ts/);
    expect(appTsElements.length).toBeGreaterThan(0);
    expect(screen.getByText('Applied')).toBeDefined();
  });

  it('renders "Created" status for new file edits', () => {
    const message = makeToolMessage('Write', {
      file_path: '/workspace/new-file.ts',
    }, { success: true }); // tool_result observed -> "Created" (NIM-806 gating)
    const edits = [{ content: 'export const x = 1;\n' }];
    render(
      <EditToolResultCard
        toolMessage={message}
        edits={edits}
        workspacePath="/workspace"
      />
    );
    expect(screen.getByText('Created')).toBeDefined();
  });

  it('renders "Pending" status while no tool_result is observed yet (awaiting approval/execution)', () => {
    // NIM-806: for the genuine claude-code-cli, the proxy emits the Write
    // tool_use at message_stop — BEFORE the user approves the native/widget
    // permission prompt and before the file is actually written. The real
    // tool_result only rides the NEXT request body. So a card with no result
    // must NOT claim "Created"/"Applied"; it shows a pending state until the
    // tool_result arrives (or "Failed" if it errors).
    const message = makeToolMessage('Write', {
      file_path: '/workspace/new-file.ts',
    }); // no result -> status 'running', toolCall.result undefined
    const edits = [{ content: 'export const x = 1;\n' }];
    render(
      <EditToolResultCard
        toolMessage={message}
        edits={edits}
        workspacePath="/workspace"
      />
    );
    expect(screen.getByText('Pending')).toBeDefined();
    expect(screen.queryByText('Created')).toBeNull();
    expect(screen.queryByText('Applied')).toBeNull();
  });

  it('renders "Failed" status for error', () => {
    const message = makeToolMessage('Edit', {
      file_path: '/workspace/src/app.ts',
    }, undefined, { isError: true });
    const edits = [{ old_string: 'foo', new_string: 'bar' }];
    render(
      <EditToolResultCard
        toolMessage={message}
        edits={edits}
        workspacePath="/workspace"
      />
    );
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('returns null when no edits', () => {
    const message = makeToolMessage('Edit', {});
    const { container } = render(
      <EditToolResultCard
        toolMessage={message}
        edits={[]}
        workspacePath="/workspace"
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('does not append embedded secondary files when the primary edited file is markdown', () => {
    const message = makeToolMessage('Edit', {
      file_path: '/workspace/nimbalyst-local/plans/formula-sheet-editor.md',
    });
    const edits = [
      {
        filePath: '/workspace/nimbalyst-local/plans/formula-sheet-editor.md',
        old_string: 'old',
        new_string: 'new',
      },
      {
        filePath: '/workspace/nimbalyst-local/plans/formula-sheet-editor.excalidraw',
        content: '{"type":"excalidraw"}',
      },
    ];
    const renderEmbeddedFile = vi.fn(({ filePath }: { filePath: string }) => (
      <div data-testid="embedded-preview">{filePath}</div>
    ));

    render(
      <EditToolResultCard
        toolMessage={message}
        edits={edits}
        workspacePath="/workspace"
        renderEmbeddedFile={renderEmbeddedFile}
        canEmbedFile={(filePath: string) => filePath.endsWith('.excalidraw')}
      />
    );

    expect(renderEmbeddedFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('embedded-preview')).toBeNull();
    expect(screen.getAllByText(/formula-sheet-editor\.md/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/formula-sheet-editor\.excalidraw/)).toBeNull();
  });
});

// ============================================================================
// ToolPermissionWidget Tests
// ============================================================================

describe('ToolPermissionWidget', () => {
  let ToolPermissionWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/ToolPermissionWidget');
    ToolPermissionWidget = mod.ToolPermissionWidget;
  });

  it('renders pending state with action buttons and reconnecting note when host is null', () => {
    // Before #276: the widget rendered a button-less "Waiting..." shell when
    // the interactiveWidgetHost atom captured a null host, leaving the user
    // stuck with no way to approve or deny. After: the full interactive
    // action row renders, plus a visible "Reconnecting" note so the user
    // knows what's happening. Click handlers fall back to an imperative
    // host lookup at click time, so the buttons stay actionable.
    const message = makeToolMessage('ToolPermission', {
      requestId: 'req-1',
      toolName: 'Bash',
      rawCommand: 'git push',
      pattern: 'Bash(git push:*)',
    });
    render(
      <Wrapper>
        <ToolPermissionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="no-host-session"
        />
      </Wrapper>
    );
    expect(screen.getByTestId('tool-permission-widget')).toBeDefined();
    expect(screen.getByTestId('tool-permission-widget').dataset.state).toBe('pending');
    expect(screen.getByTestId('tool-permission-host-reconnecting')).toBeDefined();
    expect(screen.getByTestId('tool-permission-deny')).toBeDefined();
    expect(screen.getByTestId('tool-permission-allow-once')).toBeDefined();
  });

  it('renders granted state from tool result', () => {
    const message = makeToolMessage(
      'ToolPermission',
      {
        requestId: 'req-2',
        toolName: 'Bash',
        rawCommand: 'git status',
        pattern: 'Bash(git status:*)',
      },
      JSON.stringify({ decision: 'allow', scope: 'session' })
    );
    render(
      <Wrapper>
        <ToolPermissionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="completed-session"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('tool-permission-widget');
    expect(widget.dataset.state).toBe('granted');
    expect(screen.getByText('Permission Granted')).toBeDefined();
    expect(screen.getByText('This Session')).toBeDefined();
  });

  it('renders denied state from tool result', () => {
    const message = makeToolMessage(
      'ToolPermission',
      {
        requestId: 'req-3',
        toolName: 'Bash',
        rawCommand: 'rm -rf /',
        pattern: 'Bash',
        isDestructive: true,
      },
      JSON.stringify({ decision: 'deny', scope: 'once' })
    );
    render(
      <Wrapper>
        <ToolPermissionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="denied-session"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('tool-permission-widget');
    expect(widget.dataset.state).toBe('denied');
    expect(screen.getByText('Permission Denied')).toBeDefined();
  });

  it('shows command in the code block', () => {
    const message = makeToolMessage(
      'ToolPermission',
      {
        requestId: 'req-4',
        toolName: 'Bash',
        rawCommand: 'npm test',
        pattern: 'Bash(npm:*)',
      },
      JSON.stringify({ decision: 'allow', scope: 'once' })
    );
    render(
      <Wrapper>
        <ToolPermissionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="cmd-session"
        />
      </Wrapper>
    );
    expect(screen.getByText('npm test')).toBeDefined();
  });
});

// ============================================================================
// AskUserQuestionWidget Tests
// ============================================================================

describe('AskUserQuestionWidget', () => {
  let AskUserQuestionWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/AskUserQuestionWidget');
    AskUserQuestionWidget = mod.AskUserQuestionWidget;
  });

  it('renders pending state without host', () => {
    const message = makeToolMessage('AskUserQuestion', {
      questions: [
        {
          question: 'Which framework?',
          header: 'Framework',
          options: [
            { label: 'React', description: 'Component library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
          multiSelect: false,
        },
      ],
    });
    render(
      <Wrapper>
        <AskUserQuestionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="no-host"
        />
      </Wrapper>
    );
    expect(screen.getByTestId('ask-user-question-widget')).toBeDefined();
    expect(screen.getByTestId('ask-user-question-widget').dataset.state).toBe('pending');
    expect(screen.getByText('Waiting...')).toBeDefined();
    // Regression: even without a host, the question options must render so the
    // user can read them. Previously the no-host branch returned a bare
    // "Waiting..." header with no body, which left the widget looking broken
    // after switching to Files mode and back.
    const options = screen.getAllByTestId('ask-user-question-option');
    expect(options.length).toBe(2);
    expect(screen.getByText('React')).toBeDefined();
    expect(screen.getByText('Vue')).toBeDefined();
    // Submit must stay disabled until the host arrives.
    expect((screen.getByTestId('ask-user-question-submit') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('ask-user-question-cancel') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders completed state with answers', () => {
    const message = makeToolMessage(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: '' },
              { label: 'Vue', description: '' },
            ],
            multiSelect: false,
          },
        ],
      },
      JSON.stringify({ answers: { 'Which framework?': 'React' } })
    );
    render(
      <Wrapper>
        <AskUserQuestionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="answered"
        />
      </Wrapper>
    );
    expect(screen.getByText('Questions Answered')).toBeDefined();
    expect(screen.getByText('Submitted')).toBeDefined();
  });

  it('renders cancelled state', () => {
    const message = makeToolMessage(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [{ label: 'React', description: '' }],
            multiSelect: false,
          },
        ],
      },
      JSON.stringify({ cancelled: true })
    );
    render(
      <Wrapper>
        <AskUserQuestionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="cancelled"
        />
      </Wrapper>
    );
    expect(screen.getByText('Question Cancelled')).toBeDefined();
    expect(screen.getByText('Cancelled')).toBeDefined();
  });

  it('returns null when no questions', () => {
    const message = makeToolMessage('AskUserQuestion', { questions: [] });
    const { container } = render(
      <Wrapper>
        <AskUserQuestionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="empty"
        />
      </Wrapper>
    );
    expect(container.innerHTML).toBe('');
  });

  it('persists draft selections across unmount/remount via jotai atom', async () => {
    // Bug: switching sessions or virtual-scroll churn unmounts the widget and
    // user selections were lost. Draft state now lives in a per-toolCallId
    // jotai atom so it survives remount when the same jotai store is reused.
    const { interactiveWidgetHostAtom } = await import('../../../../store/atoms/interactiveWidgetHost');
    const { askUserQuestionDraftAtom, clearAskUserQuestionDraft } = await import(
      '../../../../store/atoms/askUserQuestionDraft'
    );

    const toolCallId = 'persist-test-tool-id';
    const message = makeToolMessage(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'Component library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
            multiSelect: false,
          },
        ],
      },
      undefined,
      {
        toolCall: {
          toolName: 'AskUserQuestion',
          toolDisplayName: 'AskUserQuestion',
          status: 'running',
          description: null,
          arguments: {
            questions: [
              {
                question: 'Which framework?',
                header: 'Framework',
                options: [
                  { label: 'React', description: 'Component library' },
                  { label: 'Vue', description: 'Progressive framework' },
                ],
                multiSelect: false,
              },
            ],
          },
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
          providerToolCallId: toolCallId,
          progress: [],
          result: undefined,
        },
      }
    );

    const testStore = createStore();
    // Install a stub host so the widget renders the interactive UI (not the
    // "Waiting..." fallback shown when no host is present).
    const stubHost = {
      sessionId: 'persist-session',
      workspacePath: '/',
      worktreeId: null,
      askUserQuestionSubmit: vi.fn().mockResolvedValue(undefined),
      askUserQuestionCancel: vi.fn().mockResolvedValue(undefined),
      requestUserInputSubmit: vi.fn().mockResolvedValue(undefined),
      requestUserInputCancel: vi.fn().mockResolvedValue(undefined),
      exitPlanModeApprove: vi.fn().mockResolvedValue(undefined),
      exitPlanModeStartNewSession: vi.fn().mockResolvedValue(undefined),
      exitPlanModeDeny: vi.fn().mockResolvedValue(undefined),
      exitPlanModeCancel: vi.fn().mockResolvedValue(undefined),
      toolPermissionSubmit: vi.fn().mockResolvedValue(undefined),
      toolPermissionCancel: vi.fn().mockResolvedValue(undefined),
      autoCommitEnabled: false,
      setAutoCommitEnabled: vi.fn(),
      gitCommit: vi.fn().mockResolvedValue({ success: true }),
      gitCommitCancel: vi.fn().mockResolvedValue(undefined),
      superLoopBlockedFeedback: vi.fn().mockResolvedValue({ success: true }),
      openFile: vi.fn().mockResolvedValue(undefined),
      trackEvent: vi.fn(),
    };
    testStore.set(interactiveWidgetHostAtom('persist-session'), stubHost);

    // Ensure atom starts empty in case a previous test left state behind.
    clearAskUserQuestionDraft(toolCallId);

    const renderWidget = () =>
      render(
        <JotaiProvider store={testStore}>
          <AskUserQuestionWidget
            message={message}
            isExpanded={false}
            onToggle={() => {}}
            sessionId="persist-session"
          />
        </JotaiProvider>
      );

    // Mount 1: pick "React".
    const first = renderWidget();
    const reactOption = first.getByText('React').closest('button');
    expect(reactOption).not.toBeNull();
    fireEvent.click(reactOption!);
    expect(reactOption!.dataset.selected).toBe('true');

    // Atom should now hold the selection.
    const afterClick = testStore.get(askUserQuestionDraftAtom(toolCallId));
    expect(afterClick.selections['Which framework?']).toEqual(['React']);

    // Simulate session switch / virtual-scroll unmount.
    first.unmount();

    // Mount 2: selection should still be "React" without any user action.
    const second = renderWidget();
    const reactOptionAgain = second.getByText('React').closest('button');
    expect(reactOptionAgain).not.toBeNull();
    expect(reactOptionAgain!.dataset.selected).toBe('true');

    second.unmount();
    clearAskUserQuestionDraft(toolCallId);
  });

  it('returns null and warns when providerToolCallId is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = makeToolMessage('AskUserQuestion', {
      questions: [
        {
          question: 'Q?',
          header: 'Q',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
        },
      ],
    });
    // Force providerToolCallId to empty.
    if (message.toolCall) {
      message.toolCall.providerToolCallId = '';
    }
    const { container } = render(
      <Wrapper>
        <AskUserQuestionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="no-id"
        />
      </Wrapper>
    );
    expect(container.innerHTML).toBe('');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not crash when a question is missing its options array (issue #618)', () => {
    // Regression: the model called AskUserQuestion with a non-select field shape
    // (e.g. editText/confirm) that has no `options`. Before the parseQuestions
    // hardening this threw "Cannot read properties of undefined (reading 'map')"
    // in both the pending and completed render branches. A malformed question
    // must be dropped, and any valid sibling question must still render.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = makeToolMessage('AskUserQuestion', {
      questions: [
        // Malformed: no options array at all.
        { question: 'Free text?', header: 'Text', type: 'editText' },
        // Valid sibling that must survive.
        {
          question: 'Which framework?',
          header: 'Framework',
          options: [
            { label: 'React', description: 'Component library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(() =>
      render(
        <Wrapper>
          <AskUserQuestionWidget
            message={message}
            isExpanded={false}
            onToggle={() => {}}
            sessionId="issue-618"
          />
        </Wrapper>
      )
    ).not.toThrow();
    // The valid question renders; the malformed one is dropped.
    expect(screen.getByText('Which framework?')).toBeDefined();
    expect(screen.queryByText('Free text?')).toBeNull();
    expect(screen.getAllByTestId('ask-user-question-option').length).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns null when every question is malformed (issue #618)', () => {
    // All questions lack options -> nothing renderable -> widget renders nothing
    // rather than a "Widget failed to render" error card.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = makeToolMessage('AskUserQuestion', {
      questions: [
        { question: 'Confirm?', header: 'Confirm', type: 'confirm' },
        { question: 'Free text?', header: 'Text', type: 'editText' },
      ],
    });
    const { container } = render(
      <Wrapper>
        <AskUserQuestionWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="issue-618-all-bad"
        />
      </Wrapper>
    );
    expect(container.innerHTML).toBe('');
    warnSpy.mockRestore();
  });
});

// ============================================================================
// GitCommitConfirmationWidget Tests
// ============================================================================

describe('GitCommitConfirmationWidget', () => {
  let GitCommitConfirmationWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/GitCommitConfirmationWidget');
    GitCommitConfirmationWidget = mod.GitCommitConfirmationWidget;
  });

  it('renders pending state with commit message and files', () => {
    const message = makeToolMessage('git_commit_proposal', {
      commitMessage: 'fix: resolve null check\n\nAdded guard clause',
      filesToStage: [
        { path: 'src/app.ts', status: 'modified' },
        { path: 'src/utils.ts', status: 'added' },
      ],
    });
    render(
      <Wrapper>
        <GitCommitConfirmationWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="pending-commit"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('git-commit-widget');
    expect(widget.dataset.state).toBe('pending');
    expect(screen.getByText('Commit Proposal')).toBeDefined();
    // Commit message should be in textarea
    const textarea = screen.getByTestId('git-commit-message-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('fix: resolve null check\n\nAdded guard clause');
    // Files should be listed
    expect(screen.getByText('app.ts')).toBeDefined();
    expect(screen.getByText('utils.ts')).toBeDefined();
    // Confirm and Cancel buttons
    expect(screen.getByTestId('git-commit-confirm')).toBeDefined();
    expect(screen.getByTestId('git-commit-cancel')).toBeDefined();
  });

  it('renders committed state from tool result', () => {
    const message = makeToolMessage(
      'git_commit_proposal',
      {
        commitMessage: 'feat: add feature',
        filesToStage: ['src/feature.ts'],
      },
      'committed - commit hash: abc1234567890, commit date: 2025-03-26T12:00:00Z'
    );
    render(
      <Wrapper>
        <GitCommitConfirmationWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="committed"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('git-commit-widget');
    expect(widget.dataset.state).toBe('committed');
    expect(screen.getByText('Changes Committed')).toBeDefined();
    // Should show short hash
    expect(screen.getByText('abc1234')).toBeDefined();
  });

  it('renders cancelled state from tool result', () => {
    const message = makeToolMessage(
      'git_commit_proposal',
      {
        commitMessage: 'feat: cancelled',
        filesToStage: ['src/file.ts'],
      },
      { action: 'cancelled' }
    );
    render(
      <Wrapper>
        <GitCommitConfirmationWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="cancelled-commit"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('git-commit-widget');
    expect(widget.dataset.state).toBe('cancelled');
    expect(screen.getByTestId('git-commit-cancelled')).toBeDefined();
  });

  it('renders error state from tool result', () => {
    const message = makeToolMessage(
      'git_commit_proposal',
      {
        commitMessage: 'feat: failing commit',
        filesToStage: ['src/file.ts'],
      },
      { action: 'error', error: 'HOOK_DETAIL: lint failed' }
    );
    render(
      <Wrapper>
        <GitCommitConfirmationWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="error-commit"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('git-commit-widget');
    expect(widget.dataset.state).toBe('error');
    expect(screen.getByText('Commit Failed')).toBeDefined();
    expect(screen.getByTestId('git-commit-error').textContent).toContain('HOOK_DETAIL: lint failed');
  });

  it('sends cancel through the interactive host', async () => {
    const { interactiveWidgetHostAtom } = await import('../../../../store/atoms/interactiveWidgetHost');

    const message = makeToolMessage('git_commit_proposal', {
      commitMessage: 'fix: cancel from mobile',
      filesToStage: ['src/file.ts'],
    });

    const testStore = createStore();
    const gitCommitCancel = vi.fn().mockResolvedValue(undefined);
    testStore.set(interactiveWidgetHostAtom('cancel-session'), {
      sessionId: 'cancel-session',
      workspacePath: '/',
      worktreeId: null,
      askUserQuestionSubmit: vi.fn().mockResolvedValue(undefined),
      askUserQuestionCancel: vi.fn().mockResolvedValue(undefined),
      requestUserInputSubmit: vi.fn().mockResolvedValue(undefined),
      requestUserInputCancel: vi.fn().mockResolvedValue(undefined),
      exitPlanModeApprove: vi.fn().mockResolvedValue(undefined),
      exitPlanModeStartNewSession: vi.fn().mockResolvedValue(undefined),
      exitPlanModeDeny: vi.fn().mockResolvedValue(undefined),
      exitPlanModeCancel: vi.fn().mockResolvedValue(undefined),
      toolPermissionSubmit: vi.fn().mockResolvedValue(undefined),
      toolPermissionCancel: vi.fn().mockResolvedValue(undefined),
      autoCommitEnabled: false,
      setAutoCommitEnabled: vi.fn(),
      gitCommit: vi.fn().mockResolvedValue({ success: true }),
      gitCommitCancel,
      superLoopBlockedFeedback: vi.fn().mockResolvedValue({ success: true }),
      openFile: vi.fn().mockResolvedValue(undefined),
      trackEvent: vi.fn(),
    });

    render(
      <JotaiProvider store={testStore}>
        <GitCommitConfirmationWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="cancel-session"
        />
      </JotaiProvider>
    );

    fireEvent.click(screen.getByTestId('git-commit-cancel'));

    expect(gitCommitCancel).toHaveBeenCalledTimes(1);
  });

  it('returns null when no tool call', () => {
    const message = makeMessage({ type: 'tool_call' });
    const { container } = render(
      <Wrapper>
        <GitCommitConfirmationWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="no-tool"
        />
      </Wrapper>
    );
    expect(container.innerHTML).toBe('');
  });
});

// ============================================================================
// ExitPlanModeWidget Tests
// ============================================================================

describe('ExitPlanModeWidget', () => {
  let ExitPlanModeWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/ExitPlanModeWidget');
    ExitPlanModeWidget = mod.ExitPlanModeWidget;
  });

  it('renders pending state without host', () => {
    const message = makeToolMessage('ExitPlanMode', {
      planFilePath: 'plan.md',
    });
    render(
      <Wrapper>
        <ExitPlanModeWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="no-host-plan"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('exit-plan-mode-widget');
    expect(widget.dataset.state).toBe('pending');
    expect(screen.getByText('Ready to exit planning mode?')).toBeDefined();
    expect(screen.getByText('Waiting...')).toBeDefined();
  });

  it('renders approved state from tool result', () => {
    const message = makeToolMessage(
      'ExitPlanMode',
      { planFilePath: 'plan.md' },
      'Approved - exited planning mode'
    );
    render(
      <Wrapper>
        <ExitPlanModeWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="approved-plan"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('exit-plan-mode-widget');
    expect(widget.dataset.state).toBe('approved');
    expect(screen.getByText('Exited Planning Mode')).toBeDefined();
    expect(screen.getByTestId('exit-plan-mode-approved')).toBeDefined();
  });

  it('renders denied state from tool result', () => {
    const message = makeToolMessage(
      'ExitPlanMode',
      { planFilePath: 'plan.md' },
      'Denied - continue planning'
    );
    render(
      <Wrapper>
        <ExitPlanModeWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="denied-plan"
        />
      </Wrapper>
    );
    const widget = screen.getByTestId('exit-plan-mode-widget');
    expect(widget.dataset.state).toBe('denied');
    expect(screen.getByText('Continued Planning')).toBeDefined();
  });

  it('shows plan file path as clickable link', () => {
    const message = makeToolMessage(
      'ExitPlanMode',
      { planFilePath: 'docs/plan.md' },
      'Approved - exited planning mode'
    );
    render(
      <Wrapper>
        <ExitPlanModeWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="plan-link"
          workspacePath="/workspace"
        />
      </Wrapper>
    );
    expect(screen.getByText('docs/plan.md')).toBeDefined();
  });
});

// ============================================================================
// ContextLimitWidget Tests
// ============================================================================

describe('ContextLimitWidget', () => {
  let ContextLimitWidget: React.FC<any>;

  beforeEach(async () => {
    const mod = await import('../ContextLimitWidget');
    ContextLimitWidget = mod.ContextLimitWidget;
  });

  it('renders error indicator and message', () => {
    const { container } = render(<ContextLimitWidget />);
    expect(container.querySelector('.context-limit-widget')).not.toBeNull();
    expect(screen.getByText('Context limit exceeded')).toBeDefined();
  });

  it('shows compact button only on last message', () => {
    const onCompact = vi.fn();
    render(<ContextLimitWidget isLastMessage={true} onCompact={onCompact} />);
    const compactButton = screen.getByText('Compact');
    expect(compactButton).toBeDefined();
    fireEvent.click(compactButton);
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it('does not show compact button when not last message', () => {
    render(<ContextLimitWidget isLastMessage={false} />);
    expect(screen.queryByText('Compact')).toBeNull();
  });

  it('shows "Compacting..." after clicking compact', () => {
    const onCompact = vi.fn();
    render(<ContextLimitWidget isLastMessage={true} onCompact={onCompact} />);
    fireEvent.click(screen.getByText('Compact'));
    expect(screen.getByText('Compacting...')).toBeDefined();
  });
});

// ============================================================================
// FileChangeWidget Tests (Codex)
// ============================================================================

describe('FileChangeWidget', () => {
  let FileChangeWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/FileChangeWidget');
    FileChangeWidget = mod.FileChangeWidget;
  });

  it('renders collapsed view with file summary', () => {
    const message = makeToolMessage('file_change', {
      changes: [
        { path: '/workspace/src/app.ts', kind: 'update' },
        { path: '/workspace/src/utils.ts', kind: 'create' },
      ],
    }, { status: 'completed' });
    const { container } = render(
      <Wrapper>
        <FileChangeWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="fc-collapsed"
          workspacePath="/workspace"
        />
      </Wrapper>
    );
    // Should show summary
    expect(screen.getByText('Changed 2 files')).toBeDefined();
    // Should show file names
    expect(screen.getByText('app.ts, utils.ts')).toBeDefined();
    // Should be a button
    expect(container.querySelector('button.file-change-widget')).not.toBeNull();
  });

  it('renders expanded view with file list and kind badges', () => {
    const message = makeToolMessage('file_change', {
      changes: [
        { path: '/workspace/src/new-file.ts', kind: 'create' },
        { path: '/workspace/src/deleted.ts', kind: 'delete' },
      ],
    }, { status: 'completed' });
    render(
      <Wrapper>
        <FileChangeWidget
          message={message}
          isExpanded={true}
          onToggle={() => {}}
          sessionId="fc-expanded"
          workspacePath="/workspace"
        />
      </Wrapper>
    );
    expect(screen.getByText('File Changes')).toBeDefined();
    expect(screen.getByText('Created')).toBeDefined();
    expect(screen.getByText('Deleted')).toBeDefined();
  });

  it('shows running indicator when no result', () => {
    const message = makeToolMessage('file_change', {
      changes: [],
    }, undefined);
    const { container } = render(
      <Wrapper>
        <FileChangeWidget
          message={message}
          isExpanded={true}
          onToggle={() => {}}
          sessionId="fc-running"
        />
      </Wrapper>
    );
    // Should show dot pulse animation
    expect(container.querySelector('.animate-bash-dot-pulse')).not.toBeNull();
  });
});

// ============================================================================
// InteractivePromptWidget Tests
// ============================================================================

describe('InteractivePromptWidget', () => {
  let InteractivePromptWidget: React.FC<any>;

  beforeEach(async () => {
    const mod = await import('../InteractivePromptWidget');
    InteractivePromptWidget = mod.InteractivePromptWidget;
  });

  it('renders permission request in pending state with action buttons', () => {
    const onSubmit = vi.fn();
    render(
      <InteractivePromptWidget
        promptType="permission_request"
        content={{
          type: 'permission_request',
          requestId: 'perm-1',
          toolName: 'Bash',
          rawCommand: 'git push',
          pattern: 'Bash(git push:*)',
          patternDisplayName: 'git push commands',
          isDestructive: false,
          warnings: [],
          status: 'pending',
        }}
        onSubmitResponse={onSubmit}
      />
    );
    expect(screen.getByText('Allow this tool?')).toBeDefined();
    expect(screen.getByText('git push')).toBeDefined();
    expect(screen.getByText('Deny')).toBeDefined();
    expect(screen.getByText('Allow Once')).toBeDefined();
    expect(screen.getByText('Session')).toBeDefined();
    expect(screen.getByText('Always')).toBeDefined();
  });

  it('renders resolved permission state', () => {
    render(
      <InteractivePromptWidget
        promptType="permission_request"
        content={{
          type: 'permission_request',
          requestId: 'perm-2',
          toolName: 'Read',
          rawCommand: 'Read file',
          pattern: 'Read',
          patternDisplayName: 'Read files',
          isDestructive: false,
          warnings: [],
          status: 'resolved',
        }}
        onSubmitResponse={() => {}}
      />
    );
    expect(screen.getByText('Permission Resolved')).toBeDefined();
  });

  it('renders destructive permission with warning icon', () => {
    const { container } = render(
      <InteractivePromptWidget
        promptType="permission_request"
        content={{
          type: 'permission_request',
          requestId: 'perm-3',
          toolName: 'Bash',
          rawCommand: 'rm -rf /tmp/test',
          pattern: 'Bash',
          patternDisplayName: 'Run shell commands',
          isDestructive: true,
          warnings: ['This command could delete files'],
          status: 'pending',
        }}
        onSubmitResponse={() => {}}
      />
    );
    // Should have destructive styling
    expect(container.querySelector('.interactive-prompt--destructive')).not.toBeNull();
    // Warning should be visible
    expect(screen.getByText('This command could delete files')).toBeDefined();
  });

  it('renders ask_user_question prompt with options', () => {
    render(
      <InteractivePromptWidget
        promptType="ask_user_question_request"
        content={{
          type: 'ask_user_question_request',
          questionId: 'q-1',
          questions: [
            {
              question: 'Pick a color',
              header: 'Color',
              options: [
                { label: 'Red', description: 'Warm' },
                { label: 'Blue', description: 'Cool' },
              ],
              multiSelect: false,
            },
          ],
          status: 'pending',
        }}
        onSubmitResponse={() => {}}
      />
    );
    expect(screen.getByText('Claude has questions for you')).toBeDefined();
    expect(screen.getByText('Pick a color')).toBeDefined();
    expect(screen.getByText('Red')).toBeDefined();
    expect(screen.getByText('Blue')).toBeDefined();
    expect(screen.getByText('Warm')).toBeDefined();
    expect(screen.getByText('Cool')).toBeDefined();
  });

  it('calls onSubmitResponse with correct permission response', () => {
    const onSubmit = vi.fn();
    render(
      <InteractivePromptWidget
        promptType="permission_request"
        content={{
          type: 'permission_request',
          requestId: 'perm-click',
          toolName: 'Bash',
          rawCommand: 'ls',
          pattern: 'Bash(ls:*)',
          patternDisplayName: 'ls commands',
          isDestructive: false,
          warnings: [],
          status: 'pending',
        }}
        onSubmitResponse={onSubmit}
      />
    );
    fireEvent.click(screen.getByText('Allow Once'));
    expect(onSubmit).toHaveBeenCalledOnce();
    const response = onSubmit.mock.calls[0][0];
    expect(response.type).toBe('permission_response');
    expect(response.decision).toBe('allow');
    expect(response.scope).toBe('once');
    expect(response.requestId).toBe('perm-click');
  });
});

// ============================================================================
// ToolCallChanges Tests (unit - getOperationBadge logic)
// ============================================================================

describe('ToolCallChanges', () => {
  let ToolCallChanges: React.FC<any>;

  beforeEach(async () => {
    const mod = await import('../ToolCallChanges');
    ToolCallChanges = mod.ToolCallChanges;
  });

  it('returns null when not expanded', () => {
    const { container } = render(
      <ToolCallChanges
        diffs={null}
        isExpanded={false}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('does not render embedded secondary files when the first changed file is markdown', async () => {
    const renderEmbeddedFile = vi.fn(({ filePath }: { filePath: string }) => (
      <div data-testid="embedded-preview">{filePath}</div>
    ));

    render(
      <ToolCallChanges
        diffs={[
          {
            filePath: '/workspace/nimbalyst-local/plans/formula-sheet-editor.md',
            operation: 'edit',
            diffs: [{ oldString: 'old', newString: 'new' }],
            linesAdded: 1,
            linesRemoved: 1,
          },
          {
            filePath: '/workspace/nimbalyst-local/plans/formula-sheet-editor.excalidraw',
            operation: 'create',
            diffs: [],
            content: '{"type":"excalidraw"}',
            linesAdded: 1,
            linesRemoved: 0,
          },
        ]}
        isExpanded={true}
        workspacePath="/workspace"
        renderEmbeddedFile={renderEmbeddedFile}
        canEmbedFile={(filePath: string) => filePath.endsWith('.excalidraw')}
      />
    );

    fireEvent.click(screen.getByText('File Changes'));

    expect(renderEmbeddedFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('embedded-preview')).toBeNull();
    expect(screen.getAllByText(/formula-sheet-editor\.md/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/formula-sheet-editor\.excalidraw/)).toBeNull();
  });
});

// ============================================================================
// UpdateSessionMetaWidget Tests
// ============================================================================

describe('UpdateSessionMetaWidget', () => {
  let UpdateSessionMetaWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/UpdateSessionMetaWidget');
    UpdateSessionMetaWidget = mod.UpdateSessionMetaWidget;
  });

  it('renders structured result with name, phase, and tags', () => {
    const result: StructuredSessionMetaResult = {
      summary: 'Set name, added tags, set phase',
      before: { name: null, tags: [], phase: null },
      after: { name: 'Dark mode implementation', tags: ['feature', 'ui'], phase: 'implementing' },
    };
    const message = makeToolMessage(
      'update_session_meta',
      { name: 'Dark mode implementation', add: ['feature', 'ui'], phase: 'implementing' },
      JSON.stringify(result)
    );
    const { container } = render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-full"
        />
      </Wrapper>
    );
    // Header
    expect(screen.getByText('Session Meta')).toBeDefined();
    // Name with "set" badge
    expect(screen.getByText('Dark mode implementation')).toBeDefined();
    expect(screen.getByText('set')).toBeDefined();
    // Phase badge
    expect(screen.getByText('implementing')).toBeDefined();
    // Tags with added prefix
    expect(screen.getByText(/feature/)).toBeDefined();
    expect(screen.getByText(/ui/)).toBeDefined();
    // Should NOT render raw JSON
    expect(container.textContent).not.toContain('"before"');
    expect(container.textContent).not.toContain('"after"');
  });

  it('renders phase transition with arrow', () => {
    const result: StructuredSessionMetaResult = {
      summary: 'Updated phase',
      before: { name: 'My session', tags: ['feature'], phase: 'planning' },
      after: { name: 'My session', tags: ['feature'], phase: 'implementing' },
    };
    const message = makeToolMessage(
      'update_session_meta',
      { phase: 'implementing' },
      JSON.stringify(result)
    );
    const { container } = render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-phase"
        />
      </Wrapper>
    );
    // Both phases should appear
    expect(screen.getByText('planning')).toBeDefined();
    expect(screen.getByText('implementing')).toBeDefined();
    // Arrow between them
    expect(container.textContent).toContain('\u2192');
  });

  it('renders tag additions and removals', () => {
    const result: StructuredSessionMetaResult = {
      summary: 'Updated tags',
      before: { name: 'My session', tags: ['uncommitted', 'feature'], phase: 'implementing' },
      after: { name: 'My session', tags: ['committed', 'feature'], phase: 'implementing' },
    };
    const message = makeToolMessage(
      'mcp__nimbalyst-session-naming__update_session_meta',
      { add: ['committed'], remove: ['uncommitted'] },
      JSON.stringify(result)
    );
    render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-tags"
        />
      </Wrapper>
    );
    // Kept tag
    expect(screen.getByText('#feature')).toBeDefined();
    // Added tag (with + prefix)
    expect(screen.getByText('#committed')).toBeDefined();
    // Removed tag (with - prefix and strikethrough)
    expect(screen.getByText('#uncommitted')).toBeDefined();
  });

  it('renders "already set" note when name was already set', () => {
    const result: StructuredSessionMetaResult = {
      summary: 'Name already set',
      before: { name: 'Existing name', tags: [], phase: null },
      after: { name: 'Existing name', tags: [], phase: null },
    };
    const message = makeToolMessage(
      'update_session_meta',
      { name: 'New name attempt' },
      JSON.stringify(result)
    );
    render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-name-skip"
        />
      </Wrapper>
    );
    expect(screen.getByText('Existing name')).toBeDefined();
    expect(screen.getByText('(already set)')).toBeDefined();
  });

  it('renders compact card when result is still pending (no result)', () => {
    const message = makeToolMessage(
      'update_session_meta',
      { name: 'New session', add: ['feature'], phase: 'planning' },
      undefined
    );
    render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-pending"
        />
      </Wrapper>
    );
    expect(screen.getByText('Session Meta')).toBeDefined();
    expect(screen.getByText('New session')).toBeDefined();
  });

  it('renders fallback text for old-format (non-JSON) results', () => {
    const message = makeToolMessage(
      'update_session_meta',
      { name: 'Old format' },
      'Session named: Old format'
    );
    render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-fallback"
        />
      </Wrapper>
    );
    expect(screen.getByText('Session Meta')).toBeDefined();
    expect(screen.getByText('Session named: Old format')).toBeDefined();
  });

  it('returns null when no tool call', () => {
    const message = makeMessage({ type: 'tool_call' });
    const { container } = render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-no-tool"
        />
      </Wrapper>
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders "No metadata set" for empty result', () => {
    const result: StructuredSessionMetaResult = {
      summary: 'No changes',
      before: { name: null, tags: [], phase: null },
      after: { name: null, tags: [], phase: null },
    };
    const message = makeToolMessage(
      'update_session_meta',
      {},
      JSON.stringify(result)
    );
    render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-empty"
        />
      </Wrapper>
    );
    expect(screen.getByText('No metadata set')).toBeDefined();
  });

  it('renders structured result when tool.result is already a parsed object (canonical transcript path)', () => {
    // When loading Claude Code sessions from the canonical transcript,
    // parseToolResult() parses the stored JSON string back into an object.
    // The widget must handle this shape directly (not just JSON strings or MCP arrays).
    const result = {
      summary: 'Set name: "Bug fix"\nAdded tags: #bug-fix\nSet phase: implementing',
      before: { name: null, tags: [] as string[], phase: null },
      after: { name: 'Bug fix', tags: ['bug-fix'], phase: 'implementing' },
    };
    const message = makeToolMessage(
      'mcp__nimbalyst-session-naming__update_session_meta',
      { name: 'Bug fix', add: ['bug-fix'], phase: 'implementing' },
      result // Pass the object directly, not JSON.stringify
    );
    const { container } = render(
      <Wrapper>
        <UpdateSessionMetaWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="meta-parsed-object"
        />
      </Wrapper>
    );
    expect(screen.getByText('Bug fix')).toBeDefined();
    expect(screen.getByText('#bug-fix')).toBeDefined();
    expect(screen.getByText('implementing')).toBeDefined();
    // Should show the "set" badge since name changed from null
    expect(container.textContent).toContain('set');
  });
});

describe('TrackerToolWidget', () => {
  let TrackerToolWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/TrackerToolWidget');
    TrackerToolWidget = mod.TrackerToolWidget;
  });

  it('normalizes legacy string tag values before rendering tracker_update diffs', () => {
    const result = {
      structured: {
        action: 'updated',
        id: 'bug_123',
        type: 'bug',
        typeTags: ['bug'],
        title: 'Fix transcript widget crash',
        changes: {
          tags: {
            from: 'alpha, beta',
            to: ['beta', 'gamma'],
          },
        },
      },
      summary: 'Updated tracker item',
    };

    render(
      <Wrapper>
        <TrackerToolWidget
          message={makeToolMessage('tracker_update', { id: 'bug_123' }, JSON.stringify(result))}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="tracker-tag-normalization"
        />
      </Wrapper>
    );

    expect(screen.getByText('Tracker Updated')).toBeDefined();
    expect(screen.getByText('#alpha')).toBeDefined();
    expect(screen.getByText('#beta')).toBeDefined();
    expect(screen.getByText('#gamma')).toBeDefined();
  });
});

describe('EditorScreenshotWidget', () => {
  let EditorScreenshotWidget: React.FC<CustomToolWidgetProps>;

  beforeEach(async () => {
    const mod = await import('../CustomToolWidgets/EditorScreenshotWidget');
    EditorScreenshotWidget = mod.EditorScreenshotWidget;
  });

  it('renders inline image when result is the canonical JSON-stringified MCP image array', () => {
    // Canonical transcript stores MCP content arrays as JSON strings on tool_call.result.
    // The widget must parse the string back into an array to extract image data.
    const mcpContent = [
      {
        type: 'image',
        source: {
          type: 'base64',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          media_type: 'image/png',
        },
      },
    ];
    const message = makeToolMessage(
      'mcp__nimbalyst-mcp__capture_editor_screenshot',
      { file_path: '/tmp/feedback-intake-dialog.mockup.html' },
      mcpContent,
    );
    const { container } = render(
      <Wrapper>
        <EditorScreenshotWidget
          message={message}
          isExpanded={false}
          onToggle={() => {}}
          sessionId="screenshot-inline"
        />
      </Wrapper>
    );
    expect(screen.getByText('feedback-intake-dialog.mockup.html')).toBeDefined();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('data:image/png;base64,');
  });
});
