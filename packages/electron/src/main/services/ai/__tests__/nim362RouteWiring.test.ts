import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const aiServiceSource = readFileSync(new URL('../AIService.ts', import.meta.url), 'utf8');
const sessionHandlersSource = readFileSync(
  new URL('../../../ipc/SessionHandlers.ts', import.meta.url),
  'utf8',
);
const sessionContextMenuSource = readFileSync(
  new URL('../../../../renderer/components/AgenticCoding/SessionContextMenu.tsx', import.meta.url),
  'utf8',
);
const supervisorRendererBridgeSource = readFileSync(
  new URL('../../../../renderer/services/attentionSupervisorAuthorization.ts', import.meta.url),
  'utf8',
);
const mobilePromptDeliverySource = readFileSync(
  new URL('../MobilePromptDelivery.ts', import.meta.url),
  'utf8',
);
const iosSyncManagerSource = readFileSync(
  new URL('../../../../../../ios/NimbalystNative/Sources/Sync/SyncManager.swift', import.meta.url),
  'utf8',
);
const iosAttentionTestsSource = readFileSync(
  new URL('../../../../../../ios/NimbalystNative/Tests/AttentionStateTests.swift', import.meta.url),
  'utf8',
);

function handlerBlock(source: string, channel: string): string {
  const start = source.indexOf(`safeHandle('${channel}'`);
  if (start < 0) throw new Error(`Handler not found: ${channel}`);
  const next = source.indexOf("safeHandle('", start + channel.length + 20);
  return source.slice(start, next < 0 ? source.length : next);
}

function expectGuardBefore(block: string, guard: string, sideEffects: string[]): void {
  const guardIndex = block.indexOf(guard);
  expect(guardIndex, `missing ownership guard ${guard}`).toBeGreaterThanOrEqual(0);
  for (const sideEffect of sideEffects) {
    const sideEffectIndex = block.indexOf(sideEffect);
    expect(sideEffectIndex, `missing side-effect marker ${sideEffect}`).toBeGreaterThanOrEqual(0);
    expect(guardIndex, `${guard} must precede ${sideEffect}`).toBeLessThan(sideEffectIndex);
  }
}

describe('NIM-362 route wiring', () => {
  it('wires ai:updateSessionMetadata through the guarded route implementation', () => {
    expect(handlerBlock(aiServiceSource, 'ai:updateSessionMetadata'))
      .toContain('handleAIUpdateSessionMetadata');
  });

  it('generation-gates AskUserQuestion auto-resume at the actual answer handler', () => {
    const block = handlerBlock(aiServiceSource, 'claude-code:answer-question');
    expect(block).toContain('runClaimedPendingPromptAction');
    expect(block).toContain('schedulePromptOwnedCurrentAction');
  });

  it('installs the production queued-chain generation settlement callback in AIService', () => {
    expect(aiServiceSource).toContain('createAIServiceQueuedChainSettlement');
    expect(aiServiceSource).toContain('onChainSettled: chainSettlement.onChainSettled');
  });

  it.each([
    'claude-code:cancel-question',
    'claude-code:cancel-tool-permission',
  ])('generation-gates provider abort at the actual %s handler', (channel) => {
    const block = handlerBlock(aiServiceSource, channel);
    expect(block).toContain('runClaimedPendingPromptAction');
    expect(block).toContain('runPromptOwnedCurrentAction');
  });

  it.each([
    'ai:exitPlanModeConfirmResponse',
    'claude-code:answer-question',
    'claude-code:cancel-question',
    'claude-code:answer-tool-permission',
    'claude-code:cancel-tool-permission',
  ])('claims exact prompt ownership before side effects in %s', (channel) => {
    expect(handlerBlock(aiServiceSource, channel))
      .toContain('runClaimedPendingPromptAction');
  });

  it.each([
    ['ai:exitPlanModeConfirmResponse', [
      'resolveExitPlanModeConfirmation(requestId',
      'AISessionsRepository.updateMetadata(sessionId',
      'BrowserWindow.getAllWindows()',
    ]],
    ['claude-code:answer-question', [
      'resolveAskUserQuestion(questionId',
      'ipcMain.emit(',
      'AgentMessagesRepository.create(',
      'schedulePromptOwnedCurrentAction(',
    ]],
    ['claude-code:cancel-question', [
      'AgentMessagesRepository.create(',
      'rejectAskUserQuestion(questionId',
      'ipcMain.emit(',
      'provider?.abort()',
    ]],
    ['claude-code:answer-tool-permission', [
      'resolveToolPermission(requestId',
      'AgentMessagesRepository.create(',
      'ipcMain.emit(',
    ]],
    ['claude-code:cancel-tool-permission', [
      'rejectToolPermission(requestId',
      'provider.abort()',
      'AgentMessagesRepository.create(',
      'ipcMain.emit(',
    ]],
  ] as const)(
    'places the exact ownership claim before provider/persistence/IPC effects in %s',
    (channel, markers) => {
      expectGuardBefore(
        handlerBlock(aiServiceSource, channel),
        'runClaimedPendingPromptAction',
        [...markers],
      );
    },
  );

  it('claims every public generic interactive response before persistence/provider delivery', () => {
    const start = aiServiceSource.indexOf('public async respondToInteractivePrompt');
    const end = aiServiceSource.indexOf('\n  /**', start + 20);
    const block = aiServiceSource.slice(start, end);
    expect(block).toContain('runClaimedPendingPromptAction');
    expect(block.indexOf('runClaimedPendingPromptAction'))
      .toBeLessThan(block.indexOf('INSERT INTO ai_agent_messages'));
  });

  it('routes an orphaned git proposal through exact-generation terminal settlement', () => {
    const block = handlerBlock(sessionHandlersSource, 'messages:respond-to-prompt');
    expectGuardBefore(block, 'runOwnedPendingPromptAction', [
      'INSERT INTO ai_agent_messages',
      'ipcMain.emit(',
      'event.sender.send(',
      'TrayManager.getInstance().onPromptResolved(',
    ]);
    expect(block).toContain('promptClear = await clearPrompt()');
    expect(block).toContain('settleOrphanedPromptTurn');
    expect(block).not.toMatch(/endSession\(sessionId\s*\)/);
  });

  it('claims mobile prompt ownership before persistence, provider, IPC, renderer, or tray effects', () => {
    const start = mobilePromptDeliverySource.indexOf('export async function deliverMobilePromptResponse');
    const end = -1;
    const block = mobilePromptDeliverySource.slice(start, end < 0 ? mobilePromptDeliverySource.length : end);
    expectGuardBefore(block, 'runClaimedPendingPromptAction', [
      'resolveSessionProvider(sessionId)',
      'AgentMessagesRepository.create(',
      'ipcMain.emit(',
      'descriptor.notify()',
      'TrayManager.getInstance().onPromptResolved(',
    ]);
  });

  it('exposes grant and revoke from the session context menu through the dedicated confirmed route', () => {
    expect(sessionContextMenuSource).toContain('Authorize attention supervisor…');
    expect(sessionContextMenuSource).toContain('Revoke attention supervisor…');
    expect(sessionContextMenuSource).toContain('requestAttentionSupervisorAuthorization');
    expect(supervisorRendererBridgeSource)
      .toContain("sessions:set-attention-supervisor-authorization");
  });

  it('wires iOS draft updates through opaque-state preservation before encryption and index send', () => {
    const start = iosSyncManagerSource.indexOf('public func updateDraftInput');
    const block = iosSyncManagerSource.slice(start, iosSyncManagerSource.indexOf('\n    // MARK:', start + 20));
    expectGuardBefore(block, 'ClientMetadata.preservingOpaqueState', [
      'JSONEncoder().encode(clientMeta)',
      'crypto.encrypt(plaintext: metaString)',
      'indexClient.sendRaw(json)',
    ]);
    expect(iosAttentionTestsSource).toContain('testDraftWireMetadataPreservesPendingPromptAndAttention');
    expect(iosAttentionTestsSource).toContain('testDraftWireMetadataPreservesExplicitPromptAndAttentionCancellation');
    expect(iosAttentionTestsSource).toContain('crypto.decrypt(');
  });
});
