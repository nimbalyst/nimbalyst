// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// The registry pulls in AnalyticsService for the submit_agent_prompt event.
// Mock it so these run without posthog/electron app side effects.
vi.mock('../../../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

import { VoiceToolRegistry, type VoiceToolDispatchContext } from '../voiceToolRegistry';

const ctx = (over: Partial<VoiceToolDispatchContext> = {}): VoiceToolDispatchContext => ({
  sessionId: 'voice-session',
  supportsDeferredCalls: false,
  injectImage: () => true,
  ...over,
});

describe('VoiceToolRegistry', () => {
  it('executes a tool with no transport present', async () => {
    // The point of the extraction: a Responses controller can run the same
    // handlers with no Realtime client, socket, or session in existence.
    const registry = new VoiceToolRegistry();
    registry.handlers.onNavigateToSession = vi.fn(async (id: string) => ({ success: true, title: `session ${id}` }));

    const outcome = await registry.dispatch('c1', 'navigate_to_session', '{"sessionId":"s-7"}', ctx());

    expect(outcome).toEqual({ deferred: false, result: { success: true, title: 'session s-7' } });
  });

  it('defers a long-running submission only when the engine can hold a call open', async () => {
    const registry = new VoiceToolRegistry();
    const submit = vi.fn(async () => ({ success: true, sessionId: 'session-a' }) as const);
    registry.handlers.onSubmitPrompt = submit;

    const held = await registry.dispatch('c1', 'submit_agent_prompt', '{"prompt":"do x"}', ctx({ supportsDeferredCalls: true }));
    // The session it went to travels with the held call: only that session's
    // completion may answer it.
    expect(held).toEqual({ deferred: true, submission: { sessionId: 'session-a' } });

    const immediate = await registry.dispatch('c2', 'submit_agent_prompt', '{"prompt":"do y"}', ctx());
    expect(immediate.deferred).toBe(false);
    // The synthetic result must describe the queue, not a pending approval.
    expect((immediate as { result: { message: string } }).result.message).toContain('auto-sends');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('reports a failed submission as a failure instead of a queued task', async () => {
    const registry = new VoiceToolRegistry();
    registry.handlers.onSubmitPrompt = async () => ({
      success: false,
      error: 'That task was already queued a moment ago.',
    });

    // Nothing was queued, so no call may be held open waiting for work that
    // does not exist and nothing may be reported as accepted.
    const outcome = await registry.dispatch(
      'c1',
      'submit_agent_prompt',
      '{"prompt":"do x"}',
      ctx({ supportsDeferredCalls: true }),
    );
    expect(outcome).toEqual({
      deferred: false,
      result: { success: false, error: 'That task was already queued a moment ago.' },
    });
  });

  it('fails a screenshot capture when the engine cannot show the model an image', async () => {
    // GPT-Live accepts audio and text only. Returning the metadata anyway would
    // tell the agent it had seen a screen it never saw.
    const registry = new VoiceToolRegistry();
    registry.handlers.onCaptureUiScreenshot = vi.fn(async () => ({
      success: true,
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      width: 100,
    }));

    const outcome = await registry.dispatch(
      'c1',
      'capture_ui_screenshot',
      JSON.stringify({ userConfirmed: true, reason: 'inspect settings' }),
      ctx({ injectImage: undefined }),
    );

    expect(outcome).toEqual({
      deferred: false,
      result: {
        success: false,
        error: 'The screenshot was captured but could not be sent to the voice model.',
      },
    });
  });
});
