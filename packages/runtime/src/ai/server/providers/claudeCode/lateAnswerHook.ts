/**
 * A widget answer that reaches no live waiter while the turn is running is
 * queued, not sent, because a send would replace the running turn. Left in
 * the queue it waits for the turn to end, which in a long turn means the agent
 * works on without the user's reply. This hook hands it to the running turn at
 * its next tool boundary instead.
 *
 * It goes in as a user message with priority 'next', which Claude Code reads
 * in the same turn once the running tool calls finish. Hook `additionalContext`
 * is not usable for this: it is attached to the tool result, and the model
 * rightly ignores "the user answered" text that arrives inside a tool result
 * (seen in a live run on 2026-11-09).
 *
 * PostToolBatch fires after a batch's tool calls resolve and before the next
 * model request. The message is handed to the SDK before this hook replies,
 * so it reaches the CLI first and the next request carries it; the turn
 * cannot end in between. A turn that makes no further tool calls leaves the
 * answer to the queue at turn end, as before.
 */

import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeDeps, type LateAnswerBatch } from './dependencyInjection';
import type { PromptStreamController } from './sdkOptionsBuilder';

/** How long the SDK may take to pick up the message before it is withdrawn. */
const DELIVERY_TIMEOUT_MS = 2_000;

export function createLateAnswerHook(
  sessionId: string | undefined,
  getPromptStream: () => PromptStreamController | null,
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    const load = ClaudeCodeDeps.lateAnswerLoader;
    const stream = getPromptStream();
    // A sub-agent's batch carries agent_id. The answer is the lead's.
    if (!sessionId || !load || input.agent_id || !stream || stream.isEnded()) return {};

    let batch: LateAnswerBatch | null;
    try {
      batch = await load(sessionId);
    } catch (error) {
      // The answers stay queued for the turn end; never fail the batch over them.
      console.warn(`[CLAUDE-CODE] Could not read queued answers for the running turn of ${sessionId}:`, error);
      return {};
    }
    if (!batch) return {};

    const delivered = await stream.deliver({
      type: 'user',
      message: { role: 'user', content: batch.text },
      parent_tool_use_id: null,
      priority: 'next',
      origin: { kind: 'human' },
    }, DELIVERY_TIMEOUT_MS);
    console.log(`[CLAUDE-CODE] Queued answers ${delivered ? 'handed to' : 'could not reach'} the running turn of ${sessionId}`);
    await batch.settle(delivered).catch((error) => {
      console.error(`[CLAUDE-CODE] Could not settle queued answers for ${sessionId} (delivered=${delivered}):`, error);
    });
    return {};
  };
}
