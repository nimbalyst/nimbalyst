/**
 * Production wiring for `submitClaudeCliPrompt` (NIM-806 — input integration).
 *
 * Keeps the pure submit core (`claudeCliSubmit.ts`) free of electron/runtime
 * singletons so it unit-tests with injected deps. This module binds the real
 * terminal manager, the transcript user-prompt log, and PostHog analytics.
 */

import type { ChatAttachment, PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import { getTerminalSessionManager } from '../TerminalSessionManager';
import { AnalyticsService } from '../analytics/AnalyticsService';
import { bucketMessageLength } from './aiServiceUtils';
import { broadcastMessageLogged, logClaudeCliUserPrompt } from './claudeCliUserPromptLog';
import { submitClaudeCliPrompt, type SubmitClaudeCliPromptInput } from './claudeCliSubmit';
import { detectInteractiveCliCommand } from './claudeCliInteractiveCommands';
import { broadcastClaudeCliRevealTerminal } from './claudeCliRevealTerminal';
import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { findAttachmentDenyRule } from '@nimbalyst/runtime/ai/server';
import { ClaudeSettingsManager } from '../ClaudeSettingsManager';
import { getAttachmentStagingConfig } from '../../utils/store';

/** Submit a CLI prompt using the real terminal/log/analytics deps. */
export async function submitClaudeCliPromptProduction(
  input: SubmitClaudeCliPromptInput,
): Promise<{ submitted: boolean }> {
  const manager = getTerminalSessionManager();
  const result = await submitClaudeCliPrompt(input, {
    writeToTerminal: (sessionId: string, data: string) => manager.writeToTerminal(sessionId, data),
    logUserPrompt: (p: {
      sessionId: string;
      workspacePath: string;
      prompt: string;
      attachments?: ChatAttachment[];
      promptProvenance?: PromptProvenance;
    }) => logClaudeCliUserPrompt(p),
    sendAnalytics: ({ messageLength, hasAttachments, attachmentCount, hasDocumentContext }) => {
      // Analytics parity with the SDK path (MessageStreamingHandler fires
      // ai_message_sent per send). Document-context and attachment flags are real
      // (NIM-818).
      try {
        AnalyticsService.getInstance().sendEvent('ai_message_sent', {
          provider: 'claude-code-cli',
          hasDocumentContext,
          hasAttachments,
          attachmentCount,
          messageLength: bucketMessageLength(messageLength),
          contentMode: 'unknown',
        });
      } catch {
        // analytics is best-effort; never block the send
      }
    },
    delay: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  if (result.submitted && input.attachments?.length) {
    try {
      const effective = await ClaudeSettingsManager.getInstance().getEffectiveSettings(input.workspacePath);
      const blockedAttachment = input.attachments.find((attachment) =>
        findAttachmentDenyRule(attachment.filepath, effective.permissions.deny));
      if (blockedAttachment) {
        const denyRule = findAttachmentDenyRule(blockedAttachment.filepath, effective.permissions.deny)!;
        const mode = getAttachmentStagingConfig().mode;
        await AgentMessagesRepository.create({
          sessionId: input.sessionId,
          source: 'claude-code',
          direction: 'output',
          content: JSON.stringify({
            type: 'system',
            subtype: 'permission_denied',
            tool_name: 'Read',
            tool_input: { file_path: blockedAttachment.filepath },
            decision_reason: `Attachment staging matches ${denyRule}`,
            decision_reason_type: 'rule',
            message: `Claude Code may be unable to read ${blockedAttachment.filename} because ${denyRule} denies its staging directory.`,
            is_attachment_staging_denied: true,
            attachment_path: blockedAttachment.filepath,
            attachment_filename: blockedAttachment.filename,
            attachment_staging_mode: mode,
            attachment_deny_rule: denyRule,
            attachment_detection: 'preflight',
          }),
          hidden: false,
          createdAt: new Date(),
        });
        broadcastMessageLogged(input.sessionId, input.workspacePath);
      }
    } catch (error) {
      console.warn('[ClaudeCliSubmit] Attachment deny pre-flight failed:', error);
    }
  }

  // NIM-810: tell the renderer whether this submit was an interactive slash
  // command so it can reveal the raw-terminal drawer (and focus it) for the
  // native picker — or collapse an auto-revealed drawer on a normal prompt.
  // Only signal for real sends; a no-op (empty prompt) leaves the drawer alone.
  if (result.submitted) {
    const command = detectInteractiveCliCommand(input.prompt);
    broadcastClaudeCliRevealTerminal({
      sessionId: input.sessionId,
      interactive: command !== null,
      source: 'input',
      ...(command ? { command } : {}),
    });
  }

  return result;
}
