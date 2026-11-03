// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../../../services/ErrorNotificationService', () => ({ errorNotificationService: { showError: vi.fn() } }));
import { PromptQueueList } from '../PromptQueueList';
import { requestTurnControl } from '../requestTurnControl';

afterEach(cleanup);

it('lets a retained idle queue invoke the real Send Now route without copying its text', async () => {
  window.electronAPI = { invoke: vi.fn(async () => ({ success: true })) } as any;
  const cancel = vi.fn();
  render(<PromptQueueList queue={[{ id: 'retained', prompt: 'Original unsent instruction', timestamp: 1 }, { id: 'correction', prompt: 'Newer correction', timestamp: 2 }]}
    onCancel={cancel} onSendNow={() => { void requestTurnControl('stopped-session', 'send-now'); }} />);
  expect(screen.getAllByRole('button', { name: 'Send now' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await waitFor(() => expect(window.electronAPI.invoke).toHaveBeenCalledExactlyOnceWith('ai:interruptCurrentTurn', 'stopped-session'));
  expect(cancel).not.toHaveBeenCalled();
});
