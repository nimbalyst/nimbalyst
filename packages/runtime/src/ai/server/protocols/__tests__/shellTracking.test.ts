// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { observeCodexShellTracking } from '../codexAppServer/shellTracking';
import type { JsonRpcClient } from '../codexAppServer/jsonRpcClient';

it('fences foreign and ended turns while retaining yielded processes until their actual exit', () => {
  let emit!: (method: string, params: unknown) => void;
  const registration = {
    command: '',
    env: {},
    toolStarted: vi.fn(),
    toolCompleted: vi.fn(),
    turnStarted: vi.fn(),
    endTurn: vi.fn(),
    dispose: vi.fn(),
  };
  observeCodexShellTracking(
    {
      onNotification: (callback: typeof emit) => {
        emit = callback;
      },
    } as JsonRpcClient,
    registration,
    () => 'root'
  );
  const turn = (method: string, id: string) => emit(method, { threadId: 'root', turn: { id } });
  const item = (method: string, turnId: string, value: object) =>
    emit(method, { threadId: 'root', turnId, item: value });
  turn('turn/started', 'first');
  item('item/started', 'first', { type: 'commandExecution', id: 'shell' });
  item('item/started', 'first', { type: 'fileChange', id: 'patch' });
  item('item/started', 'first', { type: 'mcpToolCall', id: 'question' });
  item('item/completed', 'first', {
    type: 'commandExecution',
    id: 'shell',
    status: 'completed',
    exitCode: null,
  });
  expect(registration.toolCompleted).not.toHaveBeenCalled();
  emit('item/completed', {
    threadId: 'child',
    turnId: 'first',
    item: { type: 'mcpToolCall', id: 'child-call', status: 'failed' },
  });
  item('item/completed', 'first', {
    type: 'commandExecution',
    id: 'shell',
    status: 'completed',
    exitCode: 0,
  });
  item('item/completed', 'first', { type: 'mcpToolCall', id: 'declined', status: 'declined' });
  turn('turn/failed', 'first');
  turn('turn/started', 'second');
  turn('turn/completed', 'first');
  item('item/started', 'first', { type: 'commandExecution', id: 'late' });
  expect(registration.endTurn).toHaveBeenCalledTimes(1);
  expect(registration.toolStarted.mock.calls).toEqual([['shell', 'shell'], ['patch', 'patch'], ['question', 'mcp']]);
  expect(registration.toolCompleted.mock.calls).toEqual([['shell'], ['declined']]);
  turn('turn/completed', 'second');
  expect(registration.endTurn).toHaveBeenCalledTimes(2);
});


it('requires a turn identity and defers to the protocol active turn for late start events', () => {
  let emit!: (method: string, params: unknown) => void;
  const endTurn = vi.fn(), toolStarted = vi.fn(), turnStarted = vi.fn();
  observeCodexShellTracking({ onNotification: (callback: typeof emit) => { emit = callback; } } as JsonRpcClient,
    { command: '', env: {}, endTurn, toolStarted, turnStarted, toolCompleted: vi.fn(), dispose: vi.fn() }, () => 'root', () => 'current');
  emit('turn/completed', { threadId: 'root' });
  emit('turn/started', { threadId: 'root', turn: { id: 'old' } });
  emit('item/started', { threadId: 'root', item: { type: 'commandExecution', id: 'unknown' } });
  expect(endTurn).not.toHaveBeenCalled();
  expect(turnStarted).not.toHaveBeenCalled();
  expect(toolStarted).not.toHaveBeenCalled();
});
