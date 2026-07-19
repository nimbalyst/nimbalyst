import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('watcher-obligation startup ordering', () => {
  it('runs recovery after MetaAgentService and before continuation and wakeup work', () => {
    const descriptorWriteIndex = source.indexOf('writeMcpEndpointDescriptor({');
    const metaAgentGetInstanceIndex = source.indexOf('MetaAgentService.getInstance()');
    const metaAgentStartIndex = source.indexOf('metaAgentService.start(aiService)');
    const recoveryIndex = source.indexOf('runWatcherObligationStartupRecovery');
    const restartContinuationIndex = source.indexOf('checkForRestartContinuation(aiService)');
    const schedulerConfigureIndex = source.indexOf('scheduler.configure(', restartContinuationIndex);

    expect(descriptorWriteIndex).toBeGreaterThanOrEqual(0);
    expect(metaAgentGetInstanceIndex).toBeGreaterThanOrEqual(0);
    expect(metaAgentStartIndex).toBeGreaterThan(metaAgentGetInstanceIndex);
    expect(recoveryIndex).toBeGreaterThan(descriptorWriteIndex);
    expect(recoveryIndex).toBeGreaterThan(metaAgentStartIndex);
    expect(restartContinuationIndex).toBeGreaterThan(recoveryIndex);
    expect(schedulerConfigureIndex).toBeGreaterThan(restartContinuationIndex);
  });

  it('declares hostBootId before passing the same value to the descriptor and recovery', () => {
    const hostBootIdDeclarationIndex = source.indexOf('const hostBootId = randomUUID();');
    const descriptorCallIndex = source.indexOf('writeMcpEndpointDescriptor({');
    const descriptorCallEndIndex = source.indexOf('});', descriptorCallIndex);
    const descriptorCall = source.slice(descriptorCallIndex, descriptorCallEndIndex);
    const recoveryCallIndex = source.indexOf(
      'runWatcherObligationStartupRecovery({ hostBootId })'
    );

    expect(hostBootIdDeclarationIndex).toBeGreaterThanOrEqual(0);
    expect(descriptorCallIndex).toBeGreaterThan(hostBootIdDeclarationIndex);
    expect(descriptorCall).toContain('hostBootId,');
    expect(recoveryCallIndex).toBeGreaterThan(hostBootIdDeclarationIndex);
  });
});
