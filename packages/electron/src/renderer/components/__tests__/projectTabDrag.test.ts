import { describe, expect, it } from 'vitest';
import { PROJECT_TAB_DRAG_MIME } from '../../../shared/projectTabs';
import {
  hasProjectTabDragType,
  parseProjectTabDragPayload,
  serializeProjectTabDragPayload,
  shouldDetachProjectTabAfterDrag,
  waitForProjectTabPreparation,
} from '../projectTabDrag';

const strip = { left: 0, right: 1000, top: 0, bottom: 40 };

describe('shouldDetachProjectTabAfterDrag', () => {
  it('keeps a tab attached when released inside the strip', () => {
    expect(shouldDetachProjectTabAfterDrag({ clientX: 400, clientY: 20 }, strip)).toBe(false);
  });

  it('detaches after a verified release outside the strip tolerance', () => {
    expect(shouldDetachProjectTabAfterDrag({ clientX: 400, clientY: 100 }, strip)).toBe(true);
  });

  it('does not detach a cancelled or coordinate-less drag', () => {
    expect(shouldDetachProjectTabAfterDrag({ clientX: 0, clientY: 0 }, strip)).toBe(false);
  });

  it('does not detach when Chromium supplies invalid coordinates', () => {
    expect(shouldDetachProjectTabAfterDrag({ clientX: Number.NaN, clientY: 80 }, strip)).toBe(false);
  });

  it('does not detach after another project rail accepted the move', () => {
    expect(shouldDetachProjectTabAfterDrag({
      clientX: 400,
      clientY: 100,
      dropEffect: 'move',
    }, strip)).toBe(false);
  });
});

describe('project tab drag payload', () => {
  it('round-trips the custom project-tab payload', () => {
    const payload = { version: 1 as const, dragId: 'drag-1' };
    expect(parseProjectTabDragPayload(serializeProjectTabDragPayload(payload))).toEqual(payload);
  });

  it('rejects malformed and unsupported payloads', () => {
    expect(parseProjectTabDragPayload('{bad json')).toBeNull();
    expect(parseProjectTabDragPayload(JSON.stringify({
      version: 2,
      dragId: 'drag-1',
    }))).toBeNull();
  });

  it('distinguishes project tabs from ordinary text and file drags', () => {
    expect(hasProjectTabDragType(['text/plain', PROJECT_TAB_DRAG_MIME])).toBe(true);
    expect(hasProjectTabDragType(['text/plain', 'Files'])).toBe(false);
  });
});

describe('waitForProjectTabPreparation', () => {
  it('returns a successful preparation result', async () => {
    await expect(waitForProjectTabPreparation(Promise.resolve({ success: true }), 10))
      .resolves.toEqual({ success: true });
  });

  it('times out a hung preparation instead of blocking tear-out forever', async () => {
    await expect(waitForProjectTabPreparation(new Promise(() => {}), 1))
      .resolves.toEqual({
        success: false,
        error: 'Timed out while saving the project before moving it.',
      });
  });
});
