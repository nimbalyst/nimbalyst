// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { beginQueueStopRequest, captureQueueAuthorization, holdQueueAfterStop, isQueueStopped } from '../stoppedQueueHold';

describe('explicit Stop queue hold', () => {
  it('lets concurrent authorizations share one Stop generation without mistaking another Send for a newer Stop', () => {
    const sessionId = 'shared-resume-generation';
    holdQueueAfterStop(sessionId);
    const first = captureQueueAuthorization(sessionId);
    const second = captureQueueAuthorization(sessionId);
    expect(first()).toBe(true);
    expect(second()).toBe(true);
    holdQueueAfterStop(sessionId);
    expect(first()).toBe(false);
    expect(second()).toBe(false);
    captureQueueAuthorization(sessionId)();
  });
  it.each([false, true])('does not restore a withdrawn overlapping Stop (newerFirst=%s)', newerFirst => {
    const sessionId = `withdrawn-overlap-${newerFirst}`;
    const first = beginQueueStopRequest(sessionId);
    const second = beginQueueStopRequest(sessionId);
    for (const request of newerFirst ? [second, first] : [first, second]) {
      request.restorePreviousHold();
      request.finishLookup();
    }
    expect(isQueueStopped(sessionId)).toBe(false);
  });
  it('invalidates an older authorization when a newer failed lookup restores the old hold', () => {
    const sessionId = 'restore-aba';
    holdQueueAfterStop(sessionId);
    const oldSave = captureQueueAuthorization(sessionId);
    const stop = beginQueueStopRequest(sessionId);
    stop.restorePreviousHold();
    stop.finishLookup();
    oldSave();
    expect(isQueueStopped(sessionId)).toBe(true);
    captureQueueAuthorization(sessionId)();
    expect(isQueueStopped(sessionId)).toBe(false);
  });
  it('fences provider lookup even after a later send authorizes recovery', () => {
    const sessionId = 'stop-lookup';
    const stop = beginQueueStopRequest(sessionId);
    captureQueueAuthorization(sessionId)();
    expect(isQueueStopped(sessionId)).toBe(true);
    stop.finishLookup();
    expect(isQueueStopped(sessionId)).toBe(false);
    stop.finishLookup();
    expect(isQueueStopped(sessionId)).toBe(false);
  });
  it('keeps Stop held until a later action and ignores a send whose save began before Stop', () => {
    const sessionId = 'hold-before-save';
    const oldSave = captureQueueAuthorization(sessionId);
    holdQueueAfterStop(sessionId);
    oldSave();
    expect(isQueueStopped(sessionId)).toBe(true);
    const newSave = captureQueueAuthorization(sessionId);
    newSave();
    expect(isQueueStopped(sessionId)).toBe(false);
  });

  it('does not let a late completion reopen a newer Stop or another session', () => {
    const sessionId = 'hold-second-stop';
    holdQueueAfterStop(sessionId);
    const save = captureQueueAuthorization(sessionId);
    holdQueueAfterStop(sessionId);
    save();
    expect(isQueueStopped(sessionId)).toBe(true);
    captureQueueAuthorization('unrelated')();
    expect(isQueueStopped(sessionId)).toBe(true);
    captureQueueAuthorization(sessionId)();
    expect(isQueueStopped(sessionId)).toBe(false);
    // A second completion for the old save has no effect after a third Stop.
    holdQueueAfterStop(sessionId);
    save();
    expect(isQueueStopped(sessionId)).toBe(true);
    captureQueueAuthorization(sessionId)();
  });
});
