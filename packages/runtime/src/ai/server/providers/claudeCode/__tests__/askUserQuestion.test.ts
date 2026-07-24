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
