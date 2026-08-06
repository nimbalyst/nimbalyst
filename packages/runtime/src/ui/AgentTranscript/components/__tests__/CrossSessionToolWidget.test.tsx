/**
 * CrossSessionToolWidget + SessionReferenceChip rendering contract.
 */

import React from 'react';
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import * as rtl from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { CrossSessionToolWidget } from '../CustomToolWidgets/CrossSessionToolWidget';
import {
  sessionRefMapAtom,
  type SessionRefMeta,
} from '../../session/sessionRefAtoms';

const { render, screen, fireEvent } = rtl;

const CHILD = '72989f55-3c63-48e3-9abc-0123456789ab';

let idc = 1;
function toolMessage(
  toolName: string,
  args: Record<string, unknown>,
  result?: unknown,
): TranscriptViewMessage {
  return {
    id: idc++,
    sequence: idc,
    createdAt: new Date(),
    type: 'tool_call',
    subagentId: null,
    toolCall: {
      toolName,
      toolDisplayName: toolName,
      status: result !== undefined ? 'completed' : 'running',
      description: null,
      arguments: args,
      targetFilePath: null,
      mcpServer: null,
      mcpTool: toolName.replace(/^mcp__[^_]+__/, ''),
      providerToolCallId: `tool-${idc}`,
      progress: [],
      result:
        result != null
          ? typeof result === 'string'
            ? result
            : JSON.stringify(result)
          : undefined,
    },
  } as TranscriptViewMessage;
}

function renderWidget(
  message: TranscriptViewMessage,
  meta?: SessionRefMeta,
  onToggle = () => {},
  isExpanded = false,
) {
  const store = createStore();
  if (meta) store.set(sessionRefMapAtom, new Map([[meta.id, meta]]));
  return render(
    <JotaiProvider store={store}>
      <CrossSessionToolWidget
        message={message}
        isExpanded={isExpanded}
        onToggle={onToggle}
        sessionId="host"
      />
    </JotaiProvider>,
  );
}

describe('CrossSessionToolWidget', () => {
  let dispatchSpy: MockInstance<(event: Event) => boolean>;
  beforeEach(() => {
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });
  afterEach(() => {
    dispatchSpy.mockRestore();
    rtl.cleanup();
  });

  it('renders the resolved child session name for send_prompt', () => {
    renderWidget(
      toolMessage('mcp__nimbalyst-host__send_prompt', {
        sessionId: CHILD,
        prompt: 'Approved — proceed to the next step',
      }),
      { id: CHILD, title: 'Implementer session', phase: 'implementing' },
    );
    expect(screen.getByText('Send prompt')).toBeDefined();
    expect(screen.getByText('Implementer session')).toBeDefined();
  });

  it('resolves the spawned session id from the result JSON', () => {
    renderWidget(
      toolMessage(
        'spawn_session',
        { prompt: 'Do the thing' },
        { sessionId: CHILD },
      ),
      { id: CHILD, title: 'Child A' },
    );
    expect(screen.getByText('Spawn session')).toBeDefined();
    expect(screen.getByText('Child A')).toBeDefined();
  });

  it('shows resolved launch settings and provenance at a glance', () => {
    renderWidget(
      toolMessage(
        'spawn_session',
        {
          prompt: 'Do the thing',
          effortLevel: 'max',
        },
        {
          sessionId: CHILD,
          launchConfiguration: {
            requested: {
              provider: null,
              model: null,
              effortLevel: 'max',
              thinkingMode: null,
              toolScope: null,
              inheritModel: false,
              isolated: true,
              useWorktree: false,
              notifyOnComplete: false,
            },
            resolved: {
              provider: 'openai-codex',
              model: 'openai-codex:gpt-5.6-sol',
              effortLevel: 'max',
              thinkingMode: null,
              toolScope: 'full',
              isolated: true,
              worktreeMode: 'none',
              notifyOnComplete: false,
              sources: {
                provider: 'inherited',
                model: 'inherited',
                effortLevel: 'requested',
                thinkingMode: null,
                toolScope: 'default',
              },
            },
            effectiveness: 'not-provider-confirmed',
          },
        },
      ),
    );

    expect(screen.getByText('Model: openai-codex:gpt-5.6-sol · inherited')).toBeDefined();
    expect(screen.getByText('Effort: max · requested')).toBeDefined();
    expect(screen.getByText('Scope: full · default')).toBeDefined();
    expect(screen.getByText('Workspace: isolated')).toBeDefined();
    expect(screen.getByText('Notify: off')).toBeDefined();
  });

  it('keeps the full launch receipt in expanded details', () => {
    renderWidget(
      toolMessage(
        'create_session',
        { prompt: 'Create a child', thinkingMode: 'disabled' },
        {
          sessionId: CHILD,
          launchConfiguration: {
            requested: {},
            resolved: {
              provider: 'claude-code',
              model: 'claude-code:opus',
              effortLevel: 'high',
              thinkingMode: 'disabled',
              toolScope: 'full',
              isolated: false,
              worktreeMode: 'none',
              notifyOnComplete: true,
              sources: {
                provider: 'requested',
                model: 'requested',
                effortLevel: 'app-default',
                thinkingMode: 'requested',
                toolScope: 'default',
              },
            },
            effectiveness: 'not-provider-confirmed',
          },
        },
      ),
      undefined,
      () => {},
      true,
    );

    expect(screen.getByText(/not-provider-confirmed/)).toBeDefined();
  });

  it('opens the session via open-ai-session when the chip is clicked', () => {
    renderWidget(
      toolMessage('send_prompt', { sessionId: CHILD, prompt: 'hi' }),
      { id: CHILD, title: 'Child A' },
    );
    fireEvent.click(screen.getByText('Child A'));
    const events = dispatchSpy.mock.calls.map((c: unknown[]) => c[0] as Event);
    const openEvent = events.find((e: Event) => e.type === 'open-ai-session') as
      | CustomEvent
      | undefined;
    expect(openEvent).toBeDefined();
    expect(openEvent!.detail.sessionId).toBe(CHILD);
  });

  it('falls back to a shortened id when the session is unresolved', () => {
    renderWidget(
      toolMessage('get_session_status', { sessionId: CHILD }),
      undefined,
    );
    expect(screen.getByText('72989f55')).toBeDefined();
  });
});
