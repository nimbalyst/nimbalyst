import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertMainProcessImportProofHarnessDrained,
  mainProcessImportProofModules,
  resetMainProcessImportProofHarness,
} from '../../../__tests__/mainProcessImportProofHarness';

vi.mock('electron', () => ({
  ...mainProcessImportProofModules.electron,
  app: {
    ...mainProcessImportProofModules.electron.app,
    getVersion: () => '0.0.0-test',
  },
}));
vi.mock('../../../window/WindowManager', () => mainProcessImportProofModules.windowManager);
vi.mock('../../../utils/logger', () => mainProcessImportProofModules.logger);
vi.mock('electron-log/main', () => mainProcessImportProofModules.electronLog);
vi.mock('../../analytics/AnalyticsService', () => mainProcessImportProofModules.analytics);
vi.mock('electron-store', () => mainProcessImportProofModules.electronStore);

import { database, PGLiteDatabaseWorker } from '../../../database/PGLiteDatabaseWorker';
import { repositoryManager } from '../../RepositoryManager';
import { compareUpdateSessionMetadataWithHostControlAuthority } from '../../PGLiteSessionStore';

beforeEach(() => {
  resetMainProcessImportProofHarness();
});

afterEach(() => {
  assertMainProcessImportProofHarnessDrained();
  resetMainProcessImportProofHarness();
});

describe.sequential('PJCR-1 persisted Jean cleanup/replay production worker', () => {
  const key = 'attention-reply:pjcr1-worker';
  const sessionId = 'pjcr1-session';
  const promptId = 'p1';
  const generationA = 'pjcr1:A';
  const generationB = 'pjcr1:B';
  const owner = 'pjcr1-owner';
  let root: string;
  let priorPath: string | undefined;
  let priorDatabase: ReturnType<typeof database.getActiveDatabase>;
  let priorEngine: ReturnType<typeof database.getEngine>;
  let authority: NonNullable<Awaited<ReturnType<ReturnType<typeof repositoryManager.getHostControlReceiptsStore>['reserveReceipt']>>['mutationAuthority']>;
  let mutationId: string;
  let mutationFence: number;
  let nativeEntries = 0;
  const metadataB = {
    hasPendingPrompt: true,
    pendingPromptId: promptId,
    pendingPromptGeneration: generationB,
    attentionEvents: [{
      id: 'event-b', kind: 'interactive_prompt', promptId,
      attentionGeneration: generationB, status: 'pending',
    }],
    unrelated: { preserved: true },
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim364-pjcr1-worker-'));
    priorPath = process.env.NIMBALYST_USER_DATA_PATH;
    priorDatabase = database.getActiveDatabase();
    priorEngine = database.getEngine();
    await repositoryManager.cleanup();
    await database.close();
    process.env.NIMBALYST_USER_DATA_PATH = root;
    database.useDatabase(new PGLiteDatabaseWorker({ userDataPathOverride: root }), 'pglite');
    await database.initialize();
    await repositoryManager.initialize();
  }, 30_000);

  afterAll(async () => {
    await repositoryManager.cleanup();
    await database.close();
    database.useDatabase(priorDatabase, priorEngine);
    if (priorPath === undefined) delete process.env.NIMBALYST_USER_DATA_PATH;
    else process.env.NIMBALYST_USER_DATA_PATH = priorPath;
    await database.initialize();
    await repositoryManager.initialize();
    fs.rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it('PJCR-01 authority and immutable applied effect are persisted', async () => {
    await repositoryManager.getSessionStore().create({
      id: sessionId, workspaceId: 'pjcr1-workspace', provider: 'claude-code',
      metadata: metadataB,
    } as any);
    const reservation = await repositoryManager.getHostControlReceiptsStore().reserveReceipt({
      reservationKey: key, requestDigest: 'a'.repeat(64), operation: 'inject_attention_reply',
      sessionId, eventIdentity: promptId, attentionGeneration: generationA,
      reservationOwner: owner, now: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    authority = reservation.mutationAuthority!;
    mutationId = reservation.row.mutationId!;
    const reservedMutationFence = reservation.row.mutationFence;
    if (reservedMutationFence === undefined) {
      throw new Error('pjcr_missing_mutation_fence');
    }
    mutationFence = reservedMutationFence;
    expect((await authority.begin(new Date(), generationA)).started).toBe(true);
    const entered = await authority.enterNative(generationA, async () => {
      nativeEntries += 1;
      return 'acknowledged';
    });
    expect(entered).toEqual({ owned: true, value: 'acknowledged' });
    await authority.recordApplied('applied', {
      nativeCertainty: 'applied', nativeEntered: true, cleanupVerified: false,
    }, new Date());
    expect(await repositoryManager.getHostControlReceiptsStore().getByReservationKey(key))
      .toMatchObject({ mutationState: 'applied', attentionGeneration: generationA });
  });

  it('PJCR-02 zero-effect prompt cleanup stores absence and preserves replacement B', async () => {
    expect(await authority.claimCleanupStep('prompt', generationA)).toEqual({ status: 'claimed' });
    expect(await compareUpdateSessionMetadataWithHostControlAuthority({
      sessionId, expectedMetadata: metadataB, nextMetadata: metadataB,
      authority: authority.metadataCleanupAuthority('prompt', generationA),
      promptResult: 'already_absent', promptEventIdentity: promptId,
    })).toBe(true);
    expect((await repositoryManager.getSessionStore().get(sessionId))?.metadata).toEqual(metadataB);
  });

  it('PJCR-03 reconstructed production composition resumes the same applied row without native re-entry', async () => {
    await repositoryManager.cleanup();
    await database.close();
    database.useDatabase(new PGLiteDatabaseWorker({ userDataPathOverride: root }), 'pglite');
    await database.initialize();
    await repositoryManager.initialize();
    const replay = await repositoryManager.getHostControlReceiptsStore().reserveReceipt({
      reservationKey: key, requestDigest: 'a'.repeat(64), operation: 'inject_attention_reply',
      sessionId, eventIdentity: promptId, attentionGeneration: generationA,
      reservationOwner: owner, now: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    authority = replay.mutationAuthority!;
    expect(replay.status).toMatch(/same_owner|reconcile|replay/);
    expect(nativeEntries).toBe(1);
  }, 30_000);

  it('PJCR-04 stored attention result gates one exact terminal winner', async () => {
    expect(await authority.claimCleanupStep('attention', generationA)).toEqual({ status: 'claimed' });
    expect(await compareUpdateSessionMetadataWithHostControlAuthority({
      sessionId, expectedMetadata: metadataB, nextMetadata: metadataB,
      authority: authority.metadataCleanupAuthority('attention', generationA),
      attentionResult: 'already_absent',
      attentionOccurrence: { eventIdentity: promptId, attentionGeneration: generationA },
    })).toBe(true);
    expect(await authority.claimCleanupStep('terminal', generationA)).toEqual({ status: 'claimed' });
    const receipt = { outcome: 'injected', verified: true, receipt: {
      route: 'host-attention-answer', event_cleared: false, event_not_current: true,
    } };
    const terminal = await repositoryManager.getHostControlReceiptsStore().finalizeReceipt({
      id: (await repositoryManager.getHostControlReceiptsStore().getByReservationKey(key))!.id,
      reservationKey: key, reservationOwner: owner, mutationId, mutationFence,
      state: 'injected', receipt, now: new Date(),
    });
    expect(terminal).toMatchObject({ state: 'injected', cleanupAttentionResult: 'already_absent' });
    expect(terminal.receipt).toEqual(receipt);
  });

  it('PJCR-05 replacement B and its exact occurrence survive cleanup', async () => {
    expect((await repositoryManager.getSessionStore().get(sessionId))?.metadata).toEqual(metadataB);
    expect(nativeEntries).toBe(1);
  });

  it('PJCR-06 production facade and RepositoryManager expose the persisted winner after reopen', async () => {
    await repositoryManager.cleanup();
    await database.close();
    database.useDatabase(new PGLiteDatabaseWorker({ userDataPathOverride: root }), 'pglite');
    await database.initialize();
    await repositoryManager.initialize();
    const winner = await repositoryManager.getHostControlReceiptsStore().getByReservationKey(key);
    expect(winner).toMatchObject({ state: 'injected', cleanupPromptState: 'complete',
      cleanupAttentionState: 'complete', cleanupAttentionResult: 'already_absent',
      cleanupTerminalState: 'complete' });
  }, 30_000);

  it('PJCR-07 replay is byte-stable and lifecycle owns every resource', async () => {
    const first = await repositoryManager.getHostControlReceiptsStore().getByReservationKey(key);
    const second = await repositoryManager.getHostControlReceiptsStore().getByReservationKey(key);
    expect(second).toEqual(first);
    expect(nativeEntries).toBe(1);
    expect(database.isInitialized()).toBe(true);
    expect(fs.existsSync(path.join(root, 'pglite-db'))).toBe(true);
  });
});
