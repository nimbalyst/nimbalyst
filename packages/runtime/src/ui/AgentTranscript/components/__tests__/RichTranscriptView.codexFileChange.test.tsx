import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { RichTranscriptView } from '../RichTranscriptView';

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: () => 0,
        scrollToIndex: vi.fn(),
      }));
      return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
    }),
  };
});

function makeFileChangeMessage(changes: unknown[]): TranscriptViewMessage {
  return {
    id: 1,
    sequence: 1,
    createdAt: new Date(1_784_648_445_000),
    type: 'tool_call',
    subagentId: null,
    toolCall: {
      toolName: 'file_change',
      toolDisplayName: 'apply_patch',
      status: 'completed',
      description: null,
      arguments: { changes },
      targetFilePath: (changes[0] as { path?: string })?.path ?? null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: 'nimtc|item_0|1730000000000|42',
      progress: [],
      result: `Applied ${changes.length} file change(s)`,
    },
  };
}

// A Codex edit must land on the red/green EditToolResultCard, not the generic
// tool card that dumps the arguments as JSON. The patch text lives in the tool
// arguments, so this holds without any main-side history-diff enrichment --
// which is what regressed when lazy diff loading landed (#1191).
describe('RichTranscriptView Codex file_change routing', () => {
  beforeEach(() => {
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('renders an update as a diff card showing both sides of the hunk', () => {
    const { container } = render(
      <RichTranscriptView
        sessionId="codex-1"
        sessionStatus="idle"
        messages={[makeFileChangeMessage([
          {
            path: '/workspace/src/app.ts',
            kind: 'update',
            move_path: null,
            diff: '@@ -1,1 +1,1 @@\n-export const x = 1;\n+export const x = 2;\n',
          },
        ])]}
        provider="openai-codex"
        workspacePath="/workspace"
        persistScrollState={false}
        settings={{
          showToolCalls: true,
          showThinking: true,
          compactMode: false,
          collapseTools: false,
          showSessionInit: false,
          collapseEditCards: false,
        }}
      />,
    );

    expect(container.querySelector('.rich-transcript-edit-card')).not.toBeNull();
    expect(container.querySelector('.rich-transcript-tool-card')).toBeNull();
    expect(screen.getByText('export const x = 1;')).toBeDefined();
    expect(screen.getByText('export const x = 2;')).toBeDefined();

    // A start-open card still closes and reopens like the other tool cards.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse edit' }));
    expect(screen.queryByText('export const x = 2;')).toBeNull();
    fireEvent.click(container.querySelector('.rich-transcript-edit-row__button')!);
    expect(screen.getByText('export const x = 2;')).toBeDefined();
  });

  it('falls back to the generic tool card when the changes carry no diff', () => {
    // The legacy @openai/codex-sdk transport passes the SDK's `changes` through
    // verbatim and they have no patch text -- an empty diff card would be worse
    // than the raw arguments.
    const { container } = render(
      <RichTranscriptView
        sessionId="codex-2"
        sessionStatus="idle"
        messages={[makeFileChangeMessage([{ path: '/workspace/src/app.ts', kind: 'update' }])]}
        provider="openai-codex"
        workspacePath="/workspace"
        persistScrollState={false}
      />,
    );

    expect(container.querySelector('.rich-transcript-edit-card')).toBeNull();
    expect(container.querySelector('.rich-transcript-tool-card')).not.toBeNull();
  });

  // Mobile web views pass no settings, so this is the mobile default.
  it('starts the diff card closed when no settings are passed', () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <RichTranscriptView
        sessionId="codex-4"
        sessionStatus="idle"
        messages={[makeFileChangeMessage([
          {
            path: '/workspace/src/app.ts',
            kind: 'update',
            move_path: null,
            diff: '@@ -1,1 +1,1 @@\n-export const x = 1;\n+export const x = 2;\n',
          },
        ])]}
        provider="openai-codex"
        workspacePath="/workspace"
        persistScrollState={false}
        onOpenFile={onOpenFile}
      />,
    );

    expect(screen.queryByText('export const x = 2;')).toBeNull();
    // A tap on the path text opens the diff; it must not leave the transcript.
    fireEvent.click(container.querySelector('.rich-transcript-edit-row__summary')!);
    expect(screen.getByText('export const x = 2;')).toBeDefined();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('starts the diff card closed and toggles it from either header when collapseEditCards is on', () => {
    const { container } = render(
      <RichTranscriptView
        sessionId="codex-3"
        sessionStatus="idle"
        messages={[makeFileChangeMessage([
          {
            path: '/workspace/src/app.ts',
            kind: 'update',
            move_path: null,
            diff: '@@ -1,1 +1,1 @@\n-export const x = 1;\n+export const x = 2;\n',
          },
        ])]}
        provider="openai-codex"
        workspacePath="/workspace"
        persistScrollState={false}
        settings={{
          showToolCalls: true,
          showThinking: true,
          compactMode: false,
          collapseTools: false,
          showSessionInit: false,
          collapseEditCards: true,
        }}
      />,
    );

    expect(screen.queryByText('export const x = 2;')).toBeNull();

    fireEvent.click(container.querySelector('.rich-transcript-edit-row__button')!);
    expect(screen.getByText('export const x = 2;')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse edit' }));
    expect(screen.queryByText('export const x = 2;')).toBeNull();
  });
});

const UPDATE_CHANGE = {
  path: '/workspace/src/app.ts',
  kind: 'update',
  move_path: null,
  diff: '@@ -1,1 +1,1 @@\n-export const x = 1;\n+export const x = 2;\n',
};

function settingsWith(collapseEditCards: boolean) {
  return {
    showToolCalls: true,
    showThinking: true,
    compactMode: false,
    collapseTools: false,
    showSessionInit: false,
    collapseEditCards,
  };
}

describe('RichTranscriptView edit card toggling', () => {
  beforeEach(() => {
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('toggles edit cards without a provider call id one at a time', () => {
    const withoutCallId = (id: number) => {
      const message = makeFileChangeMessage([UPDATE_CHANGE]);
      return { ...message, id, sequence: id, toolCall: { ...message.toolCall!, providerToolCallId: null } };
    };
    const { container } = render(
      <RichTranscriptView
        sessionId="codex-5"
        sessionStatus="idle"
        messages={[withoutCallId(1), withoutCallId(2)]}
        provider="openai-codex"
        workspacePath="/workspace"
        persistScrollState={false}
        settings={settingsWith(false)}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse edit' })[0]);
    expect(container.querySelectorAll('.rich-transcript-edit-row')).toHaveLength(1);
    expect(container.querySelectorAll('.rich-transcript-edit-card')).toHaveLength(1);
  });

  it('does not close the card when a header click ends a text selection', () => {
    const { container } = render(
      <RichTranscriptView
        sessionId="codex-6"
        sessionStatus="idle"
        messages={[makeFileChangeMessage([UPDATE_CHANGE])]}
        provider="openai-codex"
        workspacePath="/workspace"
        persistScrollState={false}
        settings={settingsWith(false)}
      />,
    );
    const title = container.querySelector('.rich-transcript-edit-card__title')!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(title);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.click(title);
    expect(screen.getByText('export const x = 2;')).toBeDefined();

    selection.removeAllRanges();
    fireEvent.click(title);
    expect(screen.queryByText('export const x = 2;')).toBeNull();
  });

  it('gives Write cards the same closed default and toggle as Edit cards', () => {
    const write: TranscriptViewMessage = {
      id: 1,
      sequence: 1,
      createdAt: new Date(1_784_648_445_000),
      type: 'tool_call',
      subagentId: null,
      toolCall: {
        toolName: 'Write',
        toolDisplayName: 'Write',
        status: 'completed',
        description: null,
        arguments: { file_path: '/workspace/src/new.ts', content: 'export const created = true;\n' },
        targetFilePath: '/workspace/src/new.ts',
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: 'write-1',
        progress: [],
        result: 'File created successfully',
      },
    };
    const view = (collapseEditCards: boolean) => (
      <RichTranscriptView
        sessionId="claude-write"
        sessionStatus="idle"
        messages={[write]}
        provider="claude-code"
        workspacePath="/workspace"
        persistScrollState={false}
        settings={settingsWith(collapseEditCards)}
      />
    );
    const { container, rerender } = render(view(true));

    expect(container.textContent).not.toContain('export const created = true;');
    fireEvent.click(container.querySelector('.rich-transcript-edit-row__button')!);
    expect(container.textContent).toContain('export const created = true;');

    rerender(view(false));
    expect(container.textContent).toContain('export const created = true;');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse edit' }));
    expect(container.textContent).not.toContain('export const created = true;');
  });

  it('resets toggled edit cards to the new default when the setting changes', () => {
    const messages = [makeFileChangeMessage([UPDATE_CHANGE])];
    const view = (collapseEditCards: boolean) => (
      <RichTranscriptView
        sessionId="codex-7"
        sessionStatus="idle"
        messages={messages}
        provider="openai-codex"
        workspacePath="/workspace"
        persistScrollState={false}
        settings={settingsWith(collapseEditCards)}
      />
    );
    const { rerender } = render(view(false));

    fireEvent.click(screen.getByRole('button', { name: 'Collapse edit' }));
    expect(screen.queryByText('export const x = 2;')).toBeNull();

    // Closed by the user, then the default becomes "closed": it stays closed
    // instead of inverting to open.
    rerender(view(true));
    expect(screen.queryByText('export const x = 2;')).toBeNull();

    rerender(view(false));
    expect(screen.getByText('export const x = 2;')).toBeDefined();
  });
});
