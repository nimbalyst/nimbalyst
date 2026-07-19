import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const aiServiceSource = readFileSync(new URL('../AIService.ts', import.meta.url), 'utf8');
const dispatcherSource = readFileSync(new URL('../queuedPromptDispatcher.ts', import.meta.url), 'utf8');
const claudeCliDispatchSource = readFileSync(
  new URL('../claudeCliQueueDispatch.ts', import.meta.url),
  'utf8',
);
const settlementSource = readFileSync(
  new URL('../aiServiceQueuedChainSettlement.ts', import.meta.url),
  'utf8',
);
const messageHandlerSource = readFileSync(
  new URL('../MessageStreamingHandler.ts', import.meta.url),
  'utf8',
);
const metaAgentSource = readFileSync(
  new URL('../../MetaAgentService.ts', import.meta.url),
  'utf8',
);

function methodBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing method marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

describe('NIM-363 route and lifecycle wiring', () => {
  it('routes both MetaAgentService trigger sites through canonical workspace identity', () => {
    const createBlock = methodBlock(
      metaAgentSource,
      'private async createChildSessionInternal',
      'private async spawnSession',
    );
    expect(createBlock).toMatch(
      /triggerQueuedPromptProcessingForSession\(\s*sessionId,\s*workspaceId,?\s*\)/,
    );
    expect(createBlock).not.toContain(
      'triggerQueuedPromptProcessingForSession(sessionId, worktreePath || workspaceId)',
    );

    const followUpBlock = methodBlock(
      metaAgentSource,
      'private async sendPromptToSession',
      'private async respondToPrompt',
    );
    expect(followUpBlock).toContain('session.workspacePath || workspaceId');
    expect(followUpBlock).not.toContain('session.worktreePath || session.workspacePath');
    expect(followUpBlock).toContain('processingTriggerAccepted');
    expect(followUpBlock).toContain('dispatchScheduled');
  });

  it('installs alias-aware canonical target resolution before central queue claim', () => {
    const dispatchBlock = methodBlock(
      aiServiceSource,
      'public async tryDispatchNextQueuedPrompt',
      'private async dispatchQueuedPromptToClaudeCliSession',
    );
    expect(dispatchBlock).toContain("dispatchSession?.provider === 'claude-code-cli'");
    expect(dispatchBlock).toContain('resolveQueuedPromptDispatchTarget');
    expect(dispatchBlock).toContain('worktreeIsArchived?: boolean | null');
    expect(dispatchBlock).toContain('resolveTarget:');
    const tryClaimBlock = methodBlock(
      dispatcherSource,
      'export async function tryClaimAndDispatchNextQueuedPrompt',
      'return dispatchClaimedQueuedPrompt({',
    );
    expect(tryClaimBlock.indexOf('await resolveTarget({'))
      .toBeLessThan(tryClaimBlock.indexOf('queueStore.listPending(sessionId)'));
    expect(tryClaimBlock.indexOf('queueStore.listPending(sessionId)'))
      .toBeLessThan(tryClaimBlock.indexOf('queueStore.claim(nextPrompt.id)'));
  });

  it('keeps canonical permissions and lifecycle routing separate from provider cwd', () => {
    const reloadAssertion = messageHandlerSource.indexOf('assertQueuedPromptReloadTarget(');
    const watcherConstruction = messageHandlerSource.indexOf('hooklessWatcher.ensureForSession(');
    expect(reloadAssertion).toBeGreaterThan(-1);
    expect(reloadAssertion).toBeLessThan(watcherConstruction);
    expect(messageHandlerSource).toContain(
      'const canonicalWorkspacePath = session.workspacePath || workspacePath',
    );
    expect(messageHandlerSource).toContain(
      'let effectiveWorkspacePath = session.worktreePath || canonicalWorkspacePath',
    );
    expect(messageHandlerSource).toContain(
      'let permissionsPath = canonicalWorkspacePath',
    );
    expect(messageHandlerSource).toContain(
      'buildClaudeCodeRuntimeConfig(session, canonicalWorkspacePath)',
    );
    expect(messageHandlerSource).toContain(
      'getApiKeyForProvider(session.provider, canonicalWorkspacePath)',
    );
    expect(messageHandlerSource).toContain(
      'registerWorkspaceWindow(canonicalWorkspacePath, window.id)',
    );
    expect(messageHandlerSource).toMatch(
      /decryptMobileAttachments\(\s*attachments,\s*canonicalWorkspacePath,/,
    );
    expect(messageHandlerSource).toMatch(
      /attachMentionedFiles\(\s*message,\s*effectiveWorkspacePath,/,
    );
    expect(messageHandlerSource).toContain('workspacePath: canonicalWorkspacePath');
    expect(messageHandlerSource).toContain('markQueuedHandlerValidationFailure');
    expect(messageHandlerSource).toContain('createDeferredSessionDrainHandlers');
    expect(messageHandlerSource).toContain(
      'turnContext?.registerDeferredDrainReplay?.(deferredDrainHandlers.replayPendingDrain)',
    );
    const replayRegistration = messageHandlerSource.indexOf(
      'turnContext?.registerDeferredDrainReplay?.(deferredDrainHandlers.replayPendingDrain)',
    );
    const teammatesDrainListener = messageHandlerSource.indexOf(
      "this.installListener(provider, 'teammates:allCompleted'",
    );
    const subagentsDrainListener = messageHandlerSource.indexOf(
      "this.installListener(provider, 'subagents:drainSettled'",
    );
    expect(replayRegistration).toBeGreaterThan(-1);
    expect(replayRegistration).toBeLessThan(teammatesDrainListener);
    expect(replayRegistration).toBeLessThan(subagentsDrainListener);
    expect(messageHandlerSource).toContain("deferredDrainOutcome = 'completed'");
    expect(messageHandlerSource).toContain("deferredDrainOutcome = 'error'");
    expect(settlementSource).toContain('pendingDrain ??= { attentionGeneration, source }');
    const claimedDispatchBlock = methodBlock(
      dispatcherSource,
      'export async function dispatchClaimedQueuedPrompt',
      'interface TryClaimAndDispatchNextQueuedPromptOptions',
    );
    expect(claimedDispatchBlock.indexOf('await continueQueuedPromptChain('))
      .toBeLessThan(claimedDispatchBlock.indexOf('let hasQueuedSuccessor'));
    expect(claimedDispatchBlock.indexOf('let hasQueuedSuccessor'))
      .toBeLessThan(claimedDispatchBlock.indexOf('await runDeferredDrainReplay();'));
    expect(settlementSource).toContain('codexEditWindowRegistry.clearSession(id)');
  });

  it('revalidates the exact active worktree before handing a queued turn to the CLI rail', () => {
    const cliBlock = methodBlock(
      aiServiceSource,
      'private async dispatchQueuedPromptToClaudeCliSession',
      '/**\n   * Process the next queued prompt',
    );
    expect(cliBlock).toContain('dispatchQueuedPromptToClaudeCliWithTarget');
    expect(cliBlock).toContain('target,');
    expect(cliBlock).toContain('createWorktreeStore(db).get(worktreeId)');
    expect(claudeCliDispatchSource).toContain('worktree.id !== target.expectedWorktreeId');
    expect(claudeCliDispatchSource).toContain('worktree.path !== target.expectedWorktreePath');
    expect(claudeCliDispatchSource).toContain('Boolean(worktree.isArchived)');
    expect(claudeCliDispatchSource).toContain('return false;');
  });

  it('threads explicit failed outcomes without importing a strict prompt-target service', () => {
    expect(dispatcherSource).toContain(
      "export type QueuedPromptDispatchOutcome = 'completed' | 'failed'",
    );
    expect(dispatcherSource).toContain('outcome: QueuedPromptDispatchOutcome');
    expect(settlementSource).toContain("outcome === 'failed'");
    expect(settlementSource).toContain("status: 'error'");
    expect(settlementSource).toContain('chain settlement has no owned generation');
    expect(settlementSource).toContain("state.status === 'error'");
    expect(dispatcherSource).toContain('expectedWorktreeId');
    expect(dispatcherSource).toContain('assertQueuedPromptReloadTarget');
    expect(aiServiceSource).toContain(
      'if (chainSettlement.settledChildErrored) return;',
    );
    expect(existsSync(new URL('../WorktreePromptTargetService.ts', import.meta.url))).toBe(false);
  });
});
