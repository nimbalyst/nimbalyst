/**
 * CrossSessionToolWidget + SessionReferenceChip rendering contract.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
) {
  const store = createStore();
  if (meta) store.set(sessionRefMapAtom, new Map([[meta.id, meta]]));
  return render(
    <JotaiProvider store={store}>
      <CrossSessionToolWidget
        message={message}
        isExpanded={false}
        onToggle={onToggle}
        sessionId="host"
      />
    </JotaiProvider>,
  );
}

describe('CrossSessionToolWidget', () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;
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
