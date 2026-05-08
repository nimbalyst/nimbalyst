import { describe, it, expect } from 'vitest';
import { createPersistentPromptStream } from '../sdkOptionsBuilder';

/**
 * Tests for the PromptStreamController used to keep the Claude Code SDK's
 * binary stdin pipe open until we explicitly close it via end(). Background:
 * passing a string prompt makes the SDK set isSingleUserTurn=true and force-
 * close stdin on the first `result` chunk -- causing late can_use_tool
 * requests to hit "Tool permission request failed: Error: Stream closed".
 *
 * The controller wraps a generator that yields the initial user message and
 * then awaits an end() signal. Tests verify:
 * - generator yields the initial message exactly once before blocking
 * - end() is idempotent
 * - isEnded() flips after end()
 * - calling end() lets the generator return
 *
 * See nimbalyst-local/plans/stream-closed-native-binary-investigation.md.
 */

const makeMessage = () => ({
  type: 'user' as const,
  message: { role: 'user' as const, content: 'hello' },
  parent_tool_use_id: null,
});

describe('createPersistentPromptStream', () => {
  it('yields the initial message and blocks until end() is called', async () => {
    const initial = makeMessage();
    const { iterable, controller } = createPersistentPromptStream(initial);
    const iterator = iterable[Symbol.asyncIterator]();

    // First call yields the initial message.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe(initial);

    // Second call blocks indefinitely until end() is called -- race with a
    // timeout to assert we are in fact pending.
    let nextResolved = false;
    const nextPromise = iterator.next().then((v) => {
      nextResolved = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(nextResolved).toBe(false);
    expect(controller.isEnded()).toBe(false);

    controller.end('test');
    const second = await nextPromise;
    expect(second.done).toBe(true);
    expect(controller.isEnded()).toBe(true);
  });

  it('end() is idempotent and only logs/resolves once', async () => {
    const { iterable, controller } = createPersistentPromptStream(makeMessage());
    const iterator = iterable[Symbol.asyncIterator]();

    await iterator.next();

    controller.end('first');
    expect(controller.isEnded()).toBe(true);

    // Second call must not throw; isEnded stays true.
    controller.end('second');
    expect(controller.isEnded()).toBe(true);

    // The iterator finishes cleanly.
    const final = await iterator.next();
    expect(final.done).toBe(true);
  });

  it('isEnded() is false until end() is called', () => {
    const { controller } = createPersistentPromptStream(makeMessage());
    expect(controller.isEnded()).toBe(false);
    controller.end('test');
    expect(controller.isEnded()).toBe(true);
  });

  it('calling end() before the iterator starts still lets the iterator finish', async () => {
    const initial = makeMessage();
    const { iterable, controller } = createPersistentPromptStream(initial);

    controller.end('before-iteration');

    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe(initial);

    const second = await iterator.next();
    expect(second.done).toBe(true);
  });
});
