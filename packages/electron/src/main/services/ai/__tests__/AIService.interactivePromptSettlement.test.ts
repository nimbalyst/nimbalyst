import { describe, expect, it, vi } from 'vitest';
import { AIService } from '../AIService';

type Settlement = { success: boolean; error?: string };

function serviceWithSettlement(settle: () => Promise<Settlement>): AIService {
  const service = Object.create(AIService.prototype) as any;
  service.interactivePromptSettlements = new Map();
  service.respondToInteractivePromptOnce = settle;
  return service;
}

describe('AIService.respondToInteractivePrompt settlement ownership', () => {
  const params = {
    sessionId: 'session-a',
    promptId: 'question-a',
    promptType: 'ask_user_question_request' as const,
    response: { answers: { answer: 'Continue' } },
  };

  it('claims concurrent answers once and shares the resulting settlement', async () => {
    let release!: (value: Settlement) => void;
    const settle = vi.fn(() => new Promise<Settlement>((resolve) => { release = resolve; }));
    const service = serviceWithSettlement(settle);

    const first = service.respondToInteractivePrompt(params);
    const second = service.respondToInteractivePrompt(params);
    expect(settle).toHaveBeenCalledTimes(1);

    release({ success: true });
    await expect(Promise.all([first, second])).resolves.toEqual([{ success: true }, { success: true }]);
    expect((service as any).interactivePromptSettlements).toHaveLength(0);
  });

  it('releases a cancelled or failed settlement so exactly one later replay can resume', async () => {
    const settle = vi
      .fn<() => Promise<Settlement>>()
      .mockResolvedValueOnce({ success: false, error: 'cancelled' })
      .mockResolvedValueOnce({ success: true });
    const service = serviceWithSettlement(settle);

    await expect(service.respondToInteractivePrompt(params)).resolves.toEqual({ success: false, error: 'cancelled' });
    await expect(service.respondToInteractivePrompt(params)).resolves.toEqual({ success: true });
    expect(settle).toHaveBeenCalledTimes(2);
  });
});
