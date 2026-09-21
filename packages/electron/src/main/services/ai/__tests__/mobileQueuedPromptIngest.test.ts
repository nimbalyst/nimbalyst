// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ingestMobileQueuedPrompts } from '../mobileQueuedPromptIngest';

function makeDeps(overrides: Partial<Parameters<typeof ingestMobileQueuedPrompts>[0]> = {}) {
  const existing = new Set<string>();
  return {
    existing,
    deps: {
      getExisting: vi.fn(async (id: string) => (existing.has(id) ? { id, status: 'pending' } : null)),
      createPrompt: vi.fn(async (input: { id: string }) => {
        existing.add(input.id);
        return input;
      }),
      publishQueueState: vi.fn(async () => {}),
      getSession: vi.fn(async () => ({ provider: 'claude-code', workspacePath: '/w' })),
      trackQueued: vi.fn(),
      notifyWindow: vi.fn(),
      requestDrive: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      ...overrides,
    },
  };
}

describe('ingestMobileQueuedPrompts', () => {
  it('publishes the pending queue back to sync before driving, so the phone sees its own prompt as queued', async () => {
    // #1193: the phone inserts no local row when it sends, and the index room
    // excludes the sender from its own broadcast, so this push is the only thing
    // that can render the prompt in the iOS queue pane while it is pending.
    const { deps } = makeDeps();
    const order: string[] = [];
    deps.publishQueueState = vi.fn(async () => {
      order.push('publish');
    });
    deps.requestDrive = vi.fn(() => {
      order.push('drive');
    });

    const inserted = await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-1', prompt: 'from the phone' },
    ]);

    expect(inserted).toBe(1);
    expect(deps.publishQueueState).toHaveBeenCalledWith('session-1');
    // Publishing after the drive could send a snapshot that a fast claim has
    // already superseded with its own empty publish.
    expect(order).toEqual(['publish', 'drive']);
  });

  it('does not re-insert or re-publish an unchanged pending prompt', async () => {
    const { existing, deps } = makeDeps();
    existing.add('mobile-1');

    const inserted = await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-1', prompt: 'from the phone' },
      { id: 'local-2', prompt: 'composed on this desktop' },
    ]);

    expect(inserted).toBe(0);
    expect(deps.createPrompt).not.toHaveBeenCalled();
    expect(deps.publishQueueState).not.toHaveBeenCalled();
    expect(deps.requestDrive).not.toHaveBeenCalled();
  });

  it.each(['executing', 'completed', 'failed'])('repairs a replayed %s prompt without executing it again', async (status) => {
    const { deps } = makeDeps({ getExisting: vi.fn(async () => ({ status })) });
    expect(await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-1', prompt: 'old' }, { id: 'local-2', prompt: 'old desktop prompt' },
    ])).toBe(0);
    expect(deps.publishQueueState).toHaveBeenCalledOnce();
    expect(deps.createPrompt).not.toHaveBeenCalled();
    expect(deps.requestDrive).not.toHaveBeenCalled();
  });

  it('serializes duplicate listeners and retains a new prompt alongside a consumed replay', async () => {
    const { existing, deps } = makeDeps();
    deps.getExisting = vi.fn(async (id: string) => id === 'old'
      ? { id, status: 'completed' }
      : existing.has(id) ? { id, status: 'pending' } : null);
    const prompts = [{ id: 'old', prompt: 'consumed' }, { id: 'new', prompt: 'still needed' }];
    await Promise.all([
      ingestMobileQueuedPrompts(deps, 'session-1', prompts),
      ingestMobileQueuedPrompts(deps, 'session-1', prompts),
    ]);
    expect(deps.createPrompt).toHaveBeenCalledOnce();
    expect(deps.createPrompt).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }));
    expect(deps.requestDrive).toHaveBeenCalledOnce();
  });

  it('still confirms the queue to the phone when the session row is missing', async () => {
    const { deps } = makeDeps({ getSession: vi.fn(async () => null) });

    const inserted = await ingestMobileQueuedPrompts(deps, 'session-1', [
      { id: 'mobile-1', prompt: 'from the phone' },
    ]);

    expect(inserted).toBe(1);
    expect(deps.publishQueueState).toHaveBeenCalledWith('session-1');
    expect(deps.requestDrive).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith(expect.stringContaining('Session not found'));
  });

  it('refuses to route a session with no workspacePath rather than guessing a window', async () => {
    const { deps } = makeDeps({
      getSession: vi.fn(async () => ({ provider: 'claude-code', workspacePath: undefined })),
    });

    await ingestMobileQueuedPrompts(deps, 'session-1', [{ id: 'mobile-1', prompt: 'p' }]);

    expect(deps.notifyWindow).not.toHaveBeenCalled();
    expect(deps.requestDrive).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('no workspacePath'));
  });
});
