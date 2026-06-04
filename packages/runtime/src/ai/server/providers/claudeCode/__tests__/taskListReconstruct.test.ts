import { describe, it, expect } from 'vitest';
import { applyTaskListMutation, sortTaskList, type TaskListItem } from '../taskListReconstruct';

describe('applyTaskListMutation', () => {
  it('creates a task from TaskCreate, reading the id from the result text', () => {
    const map = new Map<string, TaskListItem>();
    const changed = applyTaskListMutation(
      map,
      'TaskCreate',
      { subject: 'Smoke-test Opus 4.8', description: 'do it', activeForm: 'Smoke-testing' },
      'Task #1 created successfully: Smoke-test Opus 4.8',
    );

    expect(changed).toBe(true);
    expect(map.get('1')).toEqual({
      id: '1',
      subject: 'Smoke-test Opus 4.8',
      description: 'do it',
      activeForm: 'Smoke-testing',
      status: 'pending',
    });
  });

  it('ignores a TaskCreate whose result has no parseable id', () => {
    const map = new Map<string, TaskListItem>();
    const changed = applyTaskListMutation(map, 'TaskCreate', { subject: 'x' }, 'something went wrong');
    expect(changed).toBe(false);
    expect(map.size).toBe(0);
  });

  it('merges a status delta from TaskUpdate onto an existing task', () => {
    const map = new Map<string, TaskListItem>([
      ['1', { id: '1', subject: 'Task', status: 'pending' }],
    ]);
    const changed = applyTaskListMutation(map, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status');
    expect(changed).toBe(true);
    expect(map.get('1')?.status).toBe('in_progress');
    // Untouched fields are preserved.
    expect(map.get('1')?.subject).toBe('Task');
  });

  it('accumulates addBlockedBy across multiple updates without duplicates', () => {
    const map = new Map<string, TaskListItem>([
      ['2', { id: '2', subject: 'Commit', status: 'pending' }],
    ]);
    applyTaskListMutation(map, 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] }, 'Updated task #2 blockedBy');
    applyTaskListMutation(map, 'TaskUpdate', { taskId: '2', addBlockedBy: ['1', '3'] }, 'Updated task #2 blockedBy');
    expect(map.get('2')?.blockedBy).toEqual(['1', '3']);
  });

  it('creates a stub when TaskUpdate arrives for an unknown task (resumed session)', () => {
    const map = new Map<string, TaskListItem>();
    const changed = applyTaskListMutation(map, 'TaskUpdate', { taskId: '7', status: 'completed' }, 'Updated task #7 status');
    expect(changed).toBe(true);
    expect(map.get('7')).toEqual({ id: '7', subject: 'Task #7', status: 'completed' });
  });

  it('removes a task when status is deleted', () => {
    const map = new Map<string, TaskListItem>([
      ['1', { id: '1', subject: 'Task', status: 'pending' }],
    ]);
    const changed = applyTaskListMutation(map, 'TaskUpdate', { taskId: '1', status: 'deleted' }, 'Deleted task #1');
    expect(changed).toBe(true);
    expect(map.has('1')).toBe(false);
  });

  it('treats TaskList and TaskGet as reads (no change)', () => {
    const map = new Map<string, TaskListItem>([
      ['1', { id: '1', subject: 'Task', status: 'pending' }],
    ]);
    expect(applyTaskListMutation(map, 'TaskList', {}, '#1 [pending] Task')).toBe(false);
    expect(applyTaskListMutation(map, 'TaskGet', { taskId: '1' }, '...')).toBe(false);
    expect(map.size).toBe(1);
  });
});

describe('sortTaskList', () => {
  it('sorts by numeric id in creation order', () => {
    const map = new Map<string, TaskListItem>([
      ['10', { id: '10', subject: 'ten', status: 'pending' }],
      ['2', { id: '2', subject: 'two', status: 'pending' }],
      ['1', { id: '1', subject: 'one', status: 'pending' }],
    ]);
    expect(sortTaskList(map.values()).map(t => t.id)).toEqual(['1', '2', '10']);
  });
});
