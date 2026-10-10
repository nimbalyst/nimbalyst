/**
 * Teammate-to-lead messages queued during the lead's turn are delivered after
 * its loop exits, each as a new user turn on the same query. Moved out of
 * ClaudeCodeProvider.sendMessage unchanged.
 */

import type { StreamChunk } from '../../types';
import type { TeammateManager } from '../TeammateManager';
import type { TurnState } from './turnState';

type LeadQuery = AsyncIterable<any> & { streamInput(stream: AsyncIterable<any>): Promise<void> };

export interface TeammateInjectionHost {
  teammateManager: TeammateManager;
  getLeadQuery(): LeadQuery | null;
  wasInterrupted(): boolean;
  isAborted(): boolean;
  markTransportDied(): void;
  logAgentMessageNonBlocking(
    sessionId: string,
    source: string,
    direction: 'input' | 'output',
    content: string,
    metadata?: Record<string, unknown>,
  ): void;
}

// Skip if the query was interrupted — after interrupt() the transport is dead
// and streamInput will always fail. Messages stay queued for the finally block
// to re-trigger via a fresh sendMessage.
export async function* injectPendingTeammateMessages(
  host: TeammateInjectionHost,
  state: TurnState,
  sessionId: string | undefined,
): AsyncGenerator<StreamChunk> {
  let leadQuery: LeadQuery | null;
  while (host.teammateManager.hasPendingTeammateMessages() && (leadQuery = host.getLeadQuery()) && !host.wasInterrupted()) {
    const nextMsg = host.teammateManager.drainNextTeammateMessage();
    if (!nextMsg) break;

    const formattedMessage = `[Teammate message from "${nextMsg.teammateName}"]\n\n${nextMsg.content}`;
    console.log(`[CLAUDE-CODE] Processing queued teammate message via streamInput: "${nextMsg.summary}"`);

    // Log the injected user message to the DB so the conversation is complete.
    // Uses non-blocking since we're mid-turn and don't need to await persistence.
    if (sessionId) {
      host.logAgentMessageNonBlocking(
        sessionId, 'claude-code', 'input',
        JSON.stringify({ prompt: formattedMessage }),
        { messageType: 'teammate_message_injected', teammateName: nextMsg.teammateName }
      );
    }

    try {
      await leadQuery.streamInput(
        host.teammateManager.createInjectedUserMessageStream(formattedMessage)
      );
    } catch (streamErr) {
      console.warn('[CLAUDE-CODE] streamInput failed for teammate message:', streamErr);
      // Lead transport is dead. Re-queue the message so the finally block
      // can re-trigger delivery via a fresh sendMessage call.
      host.teammateManager.requeueTeammateMessage(nextMsg);
      host.markTransportDied();
      break;
    }

    // Consume output from the new turn (same chunk processing)
    try {
      for await (const rawChunk of (leadQuery as AsyncIterable<any>)) {
        if (host.isAborted()) {
          console.log('[CLAUDE-CODE] Abort signal detected during teammate message processing');
          break;
        }
        const chunk = typeof rawChunk === 'string' ? rawChunk : rawChunk;

        if (typeof chunk === 'string') {
          state.fullContent += chunk;
          yield { type: 'text', content: chunk };
        } else if (chunk && typeof chunk === 'object') {
          if (chunk.type === 'result') {
            if (chunk.usage) {
              state.usageData = {
                ...(state.usageData || {}),
                input_tokens: (state.usageData?.input_tokens || 0) + (chunk.usage.input_tokens || 0),
                output_tokens: (state.usageData?.output_tokens || 0) + (chunk.usage.output_tokens || 0),
              };
            }
          } else if (chunk.type === 'assistant' && chunk.message?.content) {
            for (const block of chunk.message.content) {
              if (block.type === 'text' && block.text) {
                state.fullContent += block.text;
                yield { type: 'text', content: block.text };
              } else if (block.type === 'tool_use') {
                state.toolCallCount++;
                if (sessionId) {
                  host.logAgentMessageNonBlocking(
                    sessionId, 'claude-code', 'output',
                    JSON.stringify(block),
                    { messageType: 'tool_use', toolName: block.name }
                  );
                }
              } else if (block.type === 'tool_result') {
                if (sessionId) {
                  host.logAgentMessageNonBlocking(
                    sessionId, 'claude-code', 'output',
                    JSON.stringify(block),
                    { messageType: 'tool_result' }
                  );
                }
              }
            }
          }
        }
      }
    } catch (iterError) {
      const errMessage = (iterError as Error).message || '';
      const isAbort = (iterError as any).name === 'AbortError' || errMessage.includes('aborted');
      if (!isAbort) {
        console.error('[CLAUDE-CODE] Error during teammate message iteration:', iterError);
      }
      throw iterError;
    }
  }
}
