// @vitest-environment node
/**
 * Multi-Project Mode defaults ON, but an upgrading install with several windows
 * open would otherwise collapse to a single window + an unfamiliar rail on its
 * very next launch, with no warning. These cases pin who gets grandfathered out
 * of that change and who does not.
 *
 * Existing test file `store.upstream.test.ts` is scoped to the API-upstream
 * validator, so this lives beside it rather than inside it.
 */

import { describe, expect, it } from 'vitest';
import { shouldGrandfatherMultiProjectMode } from '../store';
import type { SessionWindow } from '../../types';

const bounds = { x: 0, y: 0, width: 800, height: 600 };

function workspaceWindow(workspacePath: string): SessionWindow {
  return { mode: 'workspace', workspacePath, bounds };
}

function documentWindow(filePath: string): SessionWindow {
  return { mode: 'document', filePath, bounds };
}

describe('shouldGrandfatherMultiProjectMode', () => {
  it('grandfathers an upgrading user who already has several workspace windows', () => {
    expect(
      shouldGrandfatherMultiProjectMode(false, [
        workspaceWindow('/ws/a'),
        workspaceWindow('/ws/b'),
      ]),
    ).toBe(true);
  });

  it('never overrides an explicit preference, however many windows are open', () => {
    // Someone who deliberately turned the mode on keeps it on.
    expect(
      shouldGrandfatherMultiProjectMode(true, [
        workspaceWindow('/ws/a'),
        workspaceWindow('/ws/b'),
        workspaceWindow('/ws/c'),
      ]),
    ).toBe(false);
  });

  it('does not grandfather a single-window user, who sees no change in shape', () => {
    expect(shouldGrandfatherMultiProjectMode(false, [workspaceWindow('/ws/a')])).toBe(false);
  });

  it('does not grandfather a fresh install with no saved session', () => {
    expect(shouldGrandfatherMultiProjectMode(false, undefined)).toBe(false);
    expect(shouldGrandfatherMultiProjectMode(false, [])).toBe(false);
  });

  it('counts only workspace-mode windows, not document windows', () => {
    // Several loose file windows are not the multi-project situation this
    // protects against -- document windows keep their own windows regardless.
    expect(
      shouldGrandfatherMultiProjectMode(false, [
        workspaceWindow('/ws/a'),
        documentWindow('/notes/one.md'),
        documentWindow('/notes/two.md'),
      ]),
    ).toBe(false);
  });

  it('treats agentic-coding windows as workspace windows', () => {
    expect(
      shouldGrandfatherMultiProjectMode(false, [
        workspaceWindow('/ws/a'),
        { mode: 'agentic-coding', workspacePath: '/ws/b', bounds },
      ]),
    ).toBe(true);
  });
});
