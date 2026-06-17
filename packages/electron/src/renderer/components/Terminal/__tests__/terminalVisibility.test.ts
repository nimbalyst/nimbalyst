import { describe, it, expect } from 'vitest';
import {
  isElementMeasurable,
  waitUntilElementMeasurable,
  type MeasurableElement,
} from '../terminalVisibility';

/**
 * NIM-826 — a hidden container is a state to wait through, not an init error.
 * The old `waitForVisibleTerminalDimensions` threw after 1.5s, which killed the
 * terminal strip on every remount with a collapsed CLI drawer ("disconnects
 * when I switch sessions"). These tests pin the replacement contract.
 */

function elementWithRect(getRect: () => { width: number; height: number }): MeasurableElement {
  return { getBoundingClientRect: getRect };
}

describe('isElementMeasurable', () => {
  it('is true only when both dimensions are non-zero', () => {
    expect(isElementMeasurable(elementWithRect(() => ({ width: 800, height: 300 })))).toBe(true);
    expect(isElementMeasurable(elementWithRect(() => ({ width: 0, height: 0 })))).toBe(false);
    expect(isElementMeasurable(elementWithRect(() => ({ width: 800, height: 0 })))).toBe(false);
    expect(isElementMeasurable(elementWithRect(() => ({ width: 0, height: 300 })))).toBe(false);
  });
});

describe('waitUntilElementMeasurable', () => {
  it('resolves immediately when the element is already measurable', async () => {
    let sleeps = 0;
    const result = await waitUntilElementMeasurable(
      elementWithRect(() => ({ width: 640, height: 200 })),
      { isDisposed: () => false, sleep: async () => { sleeps += 1; } },
    );
    expect(result).toBe('measurable');
    expect(sleeps).toBe(0);
  });

  it('keeps waiting through a long hidden stretch (no timeout) and resolves when the drawer expands', async () => {
    // 50 polls hidden — well past the old 1.5s deadline — then measurable.
    let polls = 0;
    const element = elementWithRect(() =>
      polls >= 50 ? { width: 640, height: 200 } : { width: 0, height: 0 },
    );
    const result = await waitUntilElementMeasurable(element, {
      isDisposed: () => false,
      sleep: async () => { polls += 1; },
    });
    expect(result).toBe('measurable');
    expect(polls).toBe(50);
  });

  it('resolves disposed when the component tears down while hidden', async () => {
    let polls = 0;
    const result = await waitUntilElementMeasurable(
      elementWithRect(() => ({ width: 0, height: 0 })),
      {
        isDisposed: () => polls >= 3,
        sleep: async () => { polls += 1; },
      },
    );
    expect(result).toBe('disposed');
    expect(polls).toBe(3);
  });

  it('checks disposal before measurability so teardown wins a tie', async () => {
    const result = await waitUntilElementMeasurable(
      elementWithRect(() => ({ width: 640, height: 200 })),
      { isDisposed: () => true, sleep: async () => {} },
    );
    expect(result).toBe('disposed');
  });
});
