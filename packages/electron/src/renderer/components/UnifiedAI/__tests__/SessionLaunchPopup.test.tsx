// @vitest-environment jsdom
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentModeSettingsAtom } from '../../../store/atoms/appSettings';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { sessionLaunchPopupRequestAtom } from '../../../store/atoms/appCommands';
import { selectedWorkstreamAtom } from '../../../store/atoms/sessions';
import { initWorkstreamState } from '../../../store/atoms/workstreamState';
import { windowModeAtom } from '../../../store/atoms/windowMode';
import { SessionLaunchPopup, launchSessionPrompt } from '../SessionLaunchPopup';

vi.mock('../AIInput', () => ({
  AIInput: forwardRef(function MockAIInput(props: any, ref) {
    const input = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      focus: () => input.current?.focus(),
      textarea: input.current,
    }));
    return (
      <div data-testid="mock-ai-input">
        <textarea
          ref={input}
          data-testid={props.testId}
          data-session-id={props.sessionId}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <button type="button" onClick={() => props.onSend(props.value)}>Start Session</button>
      </div>
    );
  }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class PointerEventStub extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

describe('SessionLaunchPopup', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let ensureClaudeCliSession: ReturnType<typeof vi.fn>;
  let submitClaudeCliPrompt: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal('PointerEvent', PointerEventStub);
    invoke = vi.fn(async (channel: string, payload?: any) => {
      if (channel === 'sessions:create') {
        return { success: true, id: payload.session.id };
      }
      return { success: true };
    });
    ensureClaudeCliSession = vi.fn().mockResolvedValue({ success: true });
    submitClaudeCliPrompt = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke,
        terminal: {
          ensureClaudeCliSession,
          submitClaudeCliPrompt,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('preserves a draft across dismiss/reopen and launches without changing modes', async () => {
    const testStore = createStore();
    testStore.set(activeWorkspacePathAtom, '/workspace');
    initWorkstreamState('/workspace');
    testStore.set(selectedWorkstreamAtom('/workspace'), { type: 'session', id: 'existing-session' });
    testStore.set(windowModeAtom, 'files');
    testStore.set(agentModeSettingsAtom, {
      defaultModel: 'claude-code:sonnet',
      defaultEffortLevel: 'high',
    });
    render(
      <Provider store={testStore}>
        <SessionLaunchPopup workspacePath="/workspace" />
      </Provider>,
    );

    act(() => testStore.set(sessionLaunchPopupRequestAtom, 1));
    const input = await screen.findByTestId('session-launch-popup-input');
    expect(screen.getByText('Launch New Session')).toBeTruthy();
    const backdropClass = document.querySelector('.session-launch-popup-backdrop')?.className;
    expect(backdropClass).toContain('bg-[var(--nim-bg)]');
    expect(backdropClass).not.toContain('bg-black');
    expect(backdropClass).not.toContain('backdrop-blur');
    fireEvent.change(input, { target: { value: 'Investigate the flaky test' } });

    act(() => testStore.set(sessionLaunchPopupRequestAtom, 2));
    expect(screen.queryByTestId('session-launch-popup-input')).toBeNull();

    act(() => testStore.set(sessionLaunchPopupRequestAtom, 3));
    expect(await screen.findByDisplayValue('Investigate the flaky test')).toBeTruthy();

    let resolveBackgroundLaunch: (result: { success: boolean }) => void = () => {};
    const backgroundLaunchPending = new Promise<{ success: boolean }>((resolve) => {
      resolveBackgroundLaunch = resolve;
    });
    invoke.mockImplementation((channel: string, payload?: any) => {
      if (channel === 'sessions:create') {
        return Promise.resolve({ success: true, id: payload.session.id });
      }
      if (channel === 'ai:sendMessage') return backgroundLaunchPending;
      return Promise.resolve({ success: true });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));

    await waitFor(() => {
      expect(screen.queryByTestId('session-launch-popup-input')).toBeNull();
    });
    const createCall = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect(createCall?.[1]).toMatchObject({
      workspaceId: '/workspace',
      session: {
        provider: 'claude-code',
        model: 'claude-code:sonnet',
        mode: 'agent',
        metadata: { effortLevel: 'high', thinkingMode: 'enabled' },
      },
    });
    const createdId = createCall?.[1].session.id;
    expect(createdId).toEqual(expect.any(String));
    expect(testStore.get(selectedWorkstreamAtom('/workspace'))).toEqual({
      type: 'session',
      id: 'existing-session',
    });
    expect(testStore.get(windowModeAtom)).toBe('files');
    expect(invoke).toHaveBeenCalledWith(
      'ai:sendMessage',
      'Investigate the flaky test',
      { attachments: undefined, mode: 'agent', inputType: 'user' },
      createdId,
      '/workspace',
    );

    act(() => testStore.set(sessionLaunchPopupRequestAtom, 4));
    const nextInput = await screen.findByTestId('session-launch-popup-input');
    expect((nextInput as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => {
      expect(nextInput.getAttribute('data-session-id')).toEqual(expect.any(String));
      expect(nextInput.getAttribute('data-session-id')).not.toBe(createdId);
    });

    await act(async () => {
      resolveBackgroundLaunch({ success: true });
      await backgroundLaunchPending;
    });
  });

  it('moves the popup by dragging its title bar and closes from the title bar', async () => {
    const testStore = createStore();
    testStore.set(activeWorkspacePathAtom, '/workspace');
    initWorkstreamState('/workspace');
    testStore.set(agentModeSettingsAtom, {
      defaultModel: 'claude-code:sonnet',
      defaultEffortLevel: 'high',
    });
    render(
      <Provider store={testStore}>
        <SessionLaunchPopup workspacePath="/workspace" />
      </Provider>,
    );

    act(() => testStore.set(sessionLaunchPopupRequestAtom, 1));
    const popup = await screen.findByRole('dialog', { name: 'Launch new session' });
    const titleBar = screen.getByText('Launch New Session').parentElement as HTMLDivElement;

    fireEvent.pointerDown(titleBar, {
      button: 0,
      pointerId: 7,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(titleBar, {
      pointerId: 7,
      clientX: 140,
      clientY: 125,
    });

    await waitFor(() => {
      expect(popup.getAttribute('data-drag-offset-x')).toBe('40');
      expect(popup.getAttribute('data-drag-offset-y')).toBe('25');
    });
    fireEvent.pointerUp(titleBar, { pointerId: 7 });

    fireEvent.click(screen.getByRole('button', { name: 'Close session launch popup' }));
    expect(screen.queryByRole('dialog', { name: 'Launch new session' })).toBeNull();
  });
});

describe('launchSessionPrompt', () => {
  afterEach(() => cleanup());

  it('explicitly starts and submits genuine CLI sessions from the user-triggered popup', async () => {
    const ensureClaudeCliSession = vi.fn().mockResolvedValue({ success: true });
    const submitClaudeCliPrompt = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        terminal: { ensureClaudeCliSession, submitClaudeCliPrompt },
      },
    });

    await launchSessionPrompt({
      sessionId: 'session-1',
      workspacePath: '/workspace',
      provider: 'claude-code-cli',
      model: 'claude-code-cli:sonnet',
      prompt: 'Run the tests',
      mode: 'agent',
      attachments: [],
    });

    expect(ensureClaudeCliSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspacePath: '/workspace',
      model: 'claude-code-cli:sonnet',
    });
    expect(submitClaudeCliPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspacePath: '/workspace',
      prompt: 'Run the tests',
      attachments: [],
    });
  });
});
