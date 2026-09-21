import { describe, it, expect, vi } from 'vitest';
import { handleAskUserQuestionTool } from '../askUserQuestion';

function assertZodCompliantAllow(result: { behavior: string; updatedInput?: any; message?: string }) {
  expect(result.behavior).toBe('allow');
  expect(result.updatedInput).toBeDefined();
}

function assertZodCompliantDeny(result: { behavior: string; updatedInput?: any; message?: string }) {
  expect(result.behavior).toBe('deny');
  expect(result.message).toBeDefined();
  expect(typeof result.message).toBe('string');
}

function createDeps(overrides?: any) {
  return {
    emit: vi.fn(),
    logAgentMessage: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    pendingAskUserQuestions: new Map(),
    pollForResponse: vi.fn().mockResolvedValue(undefined),
    sessionId: 'test-session',
    ...overrides,
  };
}

describe('handleAskUserQuestionTool', () => {
  describe('Zod schema compliance', () => {
    it('empty questions returns allow with updatedInput', async () => {
      const deps = createDeps();
      const result = await handleAskUserQuestionTool(deps, {
        input: { questions: [] },
        signal: new AbortController().signal,
      });
      assertZodCompliantAllow(result);
      expect(result.updatedInput.answers).toEqual({});
    });

    it('no questions field returns allow with updatedInput', async () => {
      const deps = createDeps();
      const result = await handleAskUserQuestionTool(deps, {
        input: {},
        signal: new AbortController().signal,
      });
      assertZodCompliantAllow(result);
    });

    it('answered question returns allow with updatedInput containing answers', async () => {
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      const pending = deps.pendingAskUserQuestions.get('tool-1');
      pending.resolve({ q1: 'yes' });

      const result = await resultPromise;
      assertZodCompliantAllow(result);
      expect(result.updatedInput.answers).toEqual({ q1: 'yes' });
    });

    it('cancelled question returns deny with message', async () => {
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: new AbortController().signal,
        toolUseID: 'tool-2',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      const pending = deps.pendingAskUserQuestions.get('tool-2');
      pending.reject(new Error('User cancelled the question'));

      const result = await resultPromise;
      assertZodCompliantDeny(result);
      expect(result.message).toBe('User cancelled the question');
    });

    it('abort signal returns deny with message', async () => {
      const controller = new AbortController();
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: controller.signal,
        toolUseID: 'tool-3',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      controller.abort();

      const result = await resultPromise;
      assertZodCompliantDeny(result);
    });

    it('non-Error rejection returns deny with fallback message', async () => {
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: new AbortController().signal,
        toolUseID: 'tool-4',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      const pending = deps.pendingAskUserQuestions.get('tool-4');
      pending.reject('string error' as any);

      const result = await resultPromise;
      assertZodCompliantDeny(result);
      expect(result.message).toBe('Question cancelled');
    });
  });

  describe('question lifecycle cleanup', () => {
    // Regression: GitHub #1549. `signal.addEventListener('abort')` never fires
    // on an ALREADY-aborted signal, so a question raised after the turn was
    // torn down registered a waiter nothing could ever reject: the tool call
    // hung and the session sat on "waiting for your input" forever.
    it('denies immediately when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const deps = createDeps();

      const result = await Promise.race([
        handleAskUserQuestionTool(deps, {
          input: { questions: [{ id: 'q1', text: 'Continue?' }] },
          signal: controller.signal,
          toolUseID: 'tool-aborted',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('waiter never settled')), 500)),
      ]) as { behavior: string; message?: string };

      assertZodCompliantDeny(result);
      expect(deps.pendingAskUserQuestions.size).toBe(0);
    });

    // The host clears its "waiting for your input" state on
    // askUserQuestion:answered. Cancellation and abort emitted no matching
    // event, so the pending flag and the session's waiting_for_input status
    // outlived the question.
    it('emits a cancelled event so the host can clear its pending state', async () => {
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: new AbortController().signal,
        toolUseID: 'tool-cancel-event',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      deps.pendingAskUserQuestions.get('tool-cancel-event').reject(new Error('User cancelled the question'));
      await resultPromise;

      const events = deps.emit.mock.calls.map((c: any[]) => c[0]);
      expect(events).toContain('askUserQuestion:cancelled');
      expect(events).not.toContain('askUserQuestion:answered');
      const cancelled = deps.emit.mock.calls.find((c: any[]) => c[0] === 'askUserQuestion:cancelled');
      expect(cancelled[1].questionId).toBe('tool-cancel-event');
      expect(cancelled[1].sessionId).toBe('test-session');
    });

    it('emits the cancelled event on the abort path too', async () => {
      const controller = new AbortController();
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: controller.signal,
        toolUseID: 'tool-abort-event',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      controller.abort();
      await resultPromise;

      expect(deps.emit.mock.calls.map((c: any[]) => c[0])).toContain('askUserQuestion:cancelled');
      expect(deps.pendingAskUserQuestions.size).toBe(0);
    });

    // The abort can land while the synthetic tool_use is being persisted. The
    // transcript already carries the question at that point, so it has to be
    // closed out or the widget renders forever in "pending".
    it('denies and terminalizes when the abort lands during persistence', async () => {
      const controller = new AbortController();
      const deps = createDeps({
        logAgentMessage: vi.fn(async () => {
          controller.abort();
        }),
      });

      const result = await handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: controller.signal,
        toolUseID: 'tool-abort-mid-persist',
      });

      assertZodCompliantDeny(result);
      expect(deps.pendingAskUserQuestions.size).toBe(0);
      expect(deps.emit.mock.calls.map((c: any[]) => c[0])).not.toContain('askUserQuestion:pending');
      const cancelLog = deps.logAgentMessage.mock.calls.find((c: any[]) => {
        try { return JSON.parse(c[1]).type === 'nimbalyst_tool_result'; } catch { return false; }
      });
      expect(cancelLog).toBeDefined();
      expect(JSON.parse(cancelLog![1]).tool_use_id).toBe('tool-abort-mid-persist');
    });

    // The zero-question fast path is the one place the tool completes without a
    // waiter. It must not look like a human answered anything, and it must not
    // leave the host advertising a prompt.
    it('never advertises a prompt for a question-less invocation', async () => {
      const deps = createDeps();
      const result = await handleAskUserQuestionTool(deps, {
        input: { questions: [] },
        signal: new AbortController().signal,
        toolUseID: 'tool-empty',
      });

      assertZodCompliantAllow(result);
      expect(deps.emit).not.toHaveBeenCalled();
      expect(deps.pendingAskUserQuestions.size).toBe(0);
    });

    // A real human answer still resolves normally and reports the answers it
    // was actually given — the cleanup work must not change that.
    it('resolves with the host-supplied answers and no cancelled event', async () => {
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: new AbortController().signal,
        toolUseID: 'tool-answered',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      deps.pendingAskUserQuestions.get('tool-answered').resolve({ q1: 'Option B' });

      const result = await resultPromise;
      assertZodCompliantAllow(result);
      expect(result.updatedInput.answers).toEqual({ q1: 'Option B' });
      expect(deps.emit.mock.calls.map((c: any[]) => c[0])).not.toContain('askUserQuestion:cancelled');
      expect(deps.pendingAskUserQuestions.size).toBe(0);
    });
  });

  describe('cancellation logging', () => {
    it('logs cancelled tool result on rejection', async () => {
      const deps = createDeps();
      const resultPromise = handleAskUserQuestionTool(deps, {
        input: { questions: [{ id: 'q1', text: 'Continue?' }] },
        signal: new AbortController().signal,
        toolUseID: 'tool-5',
      });

      await vi.waitFor(() => {
        expect(deps.pendingAskUserQuestions.size).toBe(1);
      });
      const pending = deps.pendingAskUserQuestions.get('tool-5');
      pending.reject(new Error('cancelled'));

      await resultPromise;

      const logCalls = deps.logAgentMessage.mock.calls;
      const cancelLog = logCalls.find((c: any[]) => {
        try { return JSON.parse(c[1]).type === 'nimbalyst_tool_result'; } catch { return false; }
      });
      expect(cancelLog).toBeDefined();
      const parsed = JSON.parse(cancelLog![1]);
      expect(parsed.is_error).toBe(true);
      expect(parsed.tool_use_id).toBe('tool-5');
    });
  });
});
