import { describe, expect, it, vi } from 'vitest';
import {
  resolveSaveAttempt,
  type SaveAttemptDeps,
  type SaveAttemptResult,
} from '../resolveSaveAttempt';

const PARAMS = {
  contentToSave: 'my edits',
  expectedDiskContent: 'what we last wrote',
  filePath: '/w/doc.md',
  snapshotType: 'manual' as const,
};

function makeDeps(
  results: Array<SaveAttemptResult | null>,
  confirmOverwrite = true,
): SaveAttemptDeps & { saveFile: ReturnType<typeof vi.fn> } {
  const saveFile = vi.fn(async () => results.shift() ?? null);
  return { saveFile, confirmOverwrite: () => confirmOverwrite };
}

describe('resolveSaveAttempt', () => {
  it('advances the baseline to the saved content on a clean save', async () => {
    const deps = makeDeps([{ success: true, filePath: '/w/doc.md' }]);

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toMatchObject({ kind: 'saved', forced: false, baseline: 'my edits' });
    expect(deps.saveFile).toHaveBeenCalledWith(
      'my edits',
      '/w/doc.md',
      'what we last wrote',
      'manual',
    );
  });

  // The regression this module exists to prevent: the forced write reaches
  // disk, so the baseline must advance. Leaving it rewound made the next save
  // send a stale lastKnownContent and re-prompt the conflict dialog forever.
  it('advances the baseline after the user forces an overwrite', async () => {
    const deps = makeDeps(
      [
        { success: false, filePath: '/w/doc.md', conflict: true, diskContent: 'someone else' },
        { success: true, filePath: '/w/doc.md' },
      ],
      true,
    );

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toMatchObject({ kind: 'saved', forced: true, baseline: 'my edits' });
    // The retry must skip the conflict check, otherwise it is refused again.
    expect(deps.saveFile).toHaveBeenLastCalledWith(
      'my edits',
      '/w/doc.md',
      undefined,
      'manual',
    );
  });

  it('keeps the baseline on disk content when a forced overwrite is refused', async () => {
    const deps = makeDeps(
      [
        { success: false, filePath: '/w/doc.md', conflict: true, diskContent: 'someone else' },
        { success: false, filePath: '/w/doc.md', errorType: 'permission', errorCode: 'EACCES' },
      ],
      true,
    );

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toEqual({
      kind: 'failed',
      errorType: 'permission',
      baseline: 'what we last wrote',
    });
  });

  it('reloads disk content and rebaselines onto it when the user declines to overwrite', async () => {
    const deps = makeDeps(
      [{ success: false, filePath: '/w/doc.md', conflict: true, diskContent: 'someone else' }],
      false,
    );

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toEqual({
      kind: 'reload',
      diskContent: 'someone else',
      baseline: 'someone else',
    });
    // Declining must not write anything.
    expect(deps.saveFile).toHaveBeenCalledTimes(1);
  });

  it('fails rather than reloading when a declined conflict carries no disk content', async () => {
    const deps = makeDeps([{ success: false, filePath: '/w/doc.md', conflict: true }], false);

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toEqual({
      kind: 'failed',
      errorType: 'conflict',
      baseline: 'what we last wrote',
    });
  });

  it('never prompts or overwrites on an autosave conflict', async () => {
    const confirmOverwrite = vi.fn(() => true);
    const saveFile = vi.fn(async () => ({
      success: false,
      filePath: '/w/doc.md',
      conflict: true,
      diskContent: 'someone else',
    }));

    const outcome = await resolveSaveAttempt(
      { ...PARAMS, snapshotType: 'auto' },
      { saveFile, confirmOverwrite },
    );

    expect(outcome).toEqual({
      kind: 'autosave-conflict',
      diskContent: 'someone else',
      baseline: 'what we last wrote',
    });
    expect(confirmOverwrite).not.toHaveBeenCalled();
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('reports a deleted file as not_found and preserves the baseline', async () => {
    const deps = makeDeps([{ success: false, filePath: '/w/doc.md', deleted: true }]);

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toEqual({
      kind: 'failed',
      errorType: 'not_found',
      baseline: 'what we last wrote',
    });
  });

  it('treats a null IPC result as an unknown failure', async () => {
    const deps = makeDeps([null]);

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toEqual({
      kind: 'failed',
      errorType: 'unknown',
      baseline: 'what we last wrote',
    });
  });

  it('treats a null forced-retry result as an unknown failure', async () => {
    const deps = makeDeps(
      [{ success: false, filePath: '/w/doc.md', conflict: true, diskContent: 'someone else' }, null],
      true,
    );

    const outcome = await resolveSaveAttempt(PARAMS, deps);

    expect(outcome).toEqual({
      kind: 'failed',
      errorType: 'unknown',
      baseline: 'what we last wrote',
    });
  });
});
