// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, Provider } from 'jotai';
import {
  sessionHasPendingInteractivePromptAtom,
  sessionPendingPromptsAtom,
  sessionProcessingAtom,
  sessionStoreAtom,
  sessionUnreadAtom,
  sessionWakeupAtom,
} from '../../../store/atoms/sessions';
import { sessionErrorAtom, sessionQueuedPromptsAtom } from '../../../store/atoms/sessionTranscript';
import { SessionOperationalIndicator } from '../SessionOperationalIndicator';

afterEach(cleanup);

function renderIndicator(
  sessionId: string,
  configure: (store: ReturnType<typeof createStore>) => void,
) {
  const store = createStore();
  configure(store);
  render(
    <Provider store={store}>
      <SessionOperationalIndicator sessionId={sessionId} />
    </Provider>,
  );
  return store;
}

describe('SessionOperationalIndicator', () => {
  it('renders nothing for idle', () => {
    const store = createStore();
    const { container } = render(
      <Provider store={store}>
        <SessionOperationalIndicator sessionId="idle" />
      </Provider>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders exact prompt type/count and motion-safe attention', () => {
    const sessionId = 'prompt';
    renderIndicator(sessionId, (store) => {
      store.set(sessionHasPendingInteractivePromptAtom(sessionId), true);
      store.set(sessionPendingPromptsAtom(sessionId), [
        {
          id: 'q1', sessionId, promptType: 'ask_user_question_request',
          promptId: 'q1', data: {}, createdAt: 1,
        },
        {
          id: 'p1', sessionId, promptType: 'permission_request',
          promptId: 'p1', data: {}, createdAt: 2,
        },
      ]);
    });

    const indicator = screen.getByRole('img');
    expect(indicator.getAttribute('aria-label')).toBe(
      'Status: Waiting for your response: 2 prompts (question, tool permission)',
    );
    expect(indicator.getAttribute('data-state')).toBe('needs-input');
    expect(indicator.getAttribute('data-motion')).toBe('pulse');
    expect(indicator.className).toContain('motion-safe:animate-pulse');
    expect(indicator.textContent).toContain('contact_support');
  });

  it('renders a safe error category and review action', () => {
    const sessionId = 'error';
    renderIndicator(sessionId, (store) => {
      store.set(sessionErrorAtom(sessionId), {
        message: 'token-shaped private provider detail',
        isAuthError: true,
      });
    });
    const indicator = screen.getByRole('img');
    expect(indicator.getAttribute('aria-label')).toBe(
      'Status: Authentication error. Open to review',
    );
    expect(indicator.getAttribute('aria-label')).not.toContain('private provider detail');
    expect(indicator.textContent).toContain('error');
  });

  it('animates only the lead while retaining the background count', () => {
    const sessionId = 'combined';
    renderIndicator(sessionId, (store) => {
      store.set(sessionProcessingAtom(sessionId), true);
      store.set(sessionStoreAtom(sessionId), {
        metadata: { currentTasks: [{ status: 'running' }] },
      } as any);
    });
    const indicator = screen.getByRole('img');
    expect(indicator.getAttribute('data-state')).toBe('working-self');
    expect(indicator.getAttribute('data-motion')).toBe('spin');
    expect(indicator.getAttribute('aria-label')).toBe(
      'Status: Agent is working with 1 background agent',
    );
  });

  it('keeps background-only work steady', () => {
    const sessionId = 'background';
    renderIndicator(sessionId, (store) => {
      store.set(sessionStoreAtom(sessionId), {
        metadata: { currentTeammates: [{ status: 'running' }] },
      } as any);
    });
    const indicator = screen.getByRole('img');
    expect(indicator.getAttribute('data-state')).toBe('working-child');
    expect(indicator.getAttribute('data-motion')).toBe('none');
    expect(indicator.className).not.toContain('animate-');
  });

  it('uses the real queue count', () => {
    const sessionId = 'queue';
    renderIndicator(sessionId, (store) => {
      store.set(sessionQueuedPromptsAtom(sessionId), [
        { id: '1', prompt: 'one', timestamp: 1 },
        { id: '2', prompt: 'two', timestamp: 2 },
      ]);
    });
    const indicator = screen.getByRole('img');
    expect(indicator.getAttribute('aria-label')).toBe('Status: 2 prompts queued');
    expect(indicator.textContent).toContain('queue');
  });

  it('renders ready as a filled yellow circle', () => {
    const sessionId = 'ready';
    renderIndicator(sessionId, (store) => {
      store.set(sessionUnreadAtom(sessionId), true);
    });
    const indicator = screen.getByRole('img');
    expect(indicator.getAttribute('aria-label')).toBe('Status: New response ready');
    expect(indicator.className).toContain('text-[var(--nim-session-status-attention,var(--nim-warning))]');
    expect(indicator.textContent).toContain('circle');
  });

  it('includes wakeup reason and scheduled fire time', () => {
    const sessionId = 'wakeup';
    renderIndicator(sessionId, (store) => {
      store.set(sessionWakeupAtom(sessionId), {
        id: 'wake-1', sessionId, workspaceId: 'workspace', prompt: 'resume',
        reason: 'Open the workspace', fireAt: 1234,
        status: 'waiting_for_workspace', createdAt: 1, firedAt: null,
        error: null,
      });
    });
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Status: Wakeup waiting for workspace: Open the workspace',
    );
  });
});
