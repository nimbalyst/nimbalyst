import { describe, expect, it } from 'vitest';
import type { WalkthroughState } from '../../walkthroughs/types';
import {
  getEligibleFilesEmptyTips,
  getNextTip,
} from '../filesEmptyTipSelection';
import type { TipDefinition, TipTriggerContext } from '../types';

const state: WalkthroughState = {
  enabled: true,
  completed: [],
  dismissed: [],
  history: {},
};

const context: TipTriggerContext = {
  currentMode: 'files',
  workspacePath: '/workspace',
  isGitRepo: false,
  isWorktreesAvailable: false,
  featureUsage: {},
  hasBeenUsed: () => false,
  hasReachedCount: () => false,
  toolUsage: {},
  hasUsedTool: () => false,
  toolUseCount: () => 0,
};

function createTip(
  id: string,
  priority: number,
  screen: TipDefinition['trigger']['screen'] = 'files-empty',
  condition = true,
): TipDefinition {
  return {
    id,
    name: id,
    version: 1,
    trigger: {
      screen,
      priority,
      condition: () => condition,
    },
    content: {
      title: id,
      body: id,
    },
  };
}

describe('files-empty tip selection', () => {
  it('filters by explicit screen target, persisted eligibility, and trigger condition', () => {
    const eligible = createTip('tip-eligible', 4);
    const higherPriority = createTip('tip-higher', 8);
    const wildcardOnly = createTip('tip-global', 10, '*');
    const wrongScreen = createTip('tip-agent', 10, 'agent');
    const conditionFalse = createTip('tip-condition-false', 10, 'files-empty', false);
    const completed = createTip('tip-completed', 10);

    const result = getEligibleFilesEmptyTips(
      [eligible, wildcardOnly, wrongScreen, conditionFalse, completed, higherPriority],
      { ...state, completed: ['tip-completed'] },
      context,
    );

    expect(result.map((tip) => tip.id)).toEqual(['tip-higher', 'tip-eligible']);
  });

  it('includes tips that add files-empty alongside the wildcard target', () => {
    const retargeted = createTip('tip-retargeted', 1, ['*', 'files-empty']);

    expect(getEligibleFilesEmptyTips([retargeted], state, context)).toEqual([retargeted]);
  });

  it('rotates forward and wraps to the first eligible tip', () => {
    const first = createTip('tip-first', 3);
    const second = createTip('tip-second', 2);
    const third = createTip('tip-third', 1);
    const ordered = [first, second, third];

    expect(getNextTip(ordered, first.id)).toBe(second);
    expect(getNextTip(ordered, third.id)).toBe(first);
    expect(getNextTip(ordered, 'tip-missing')).toBe(first);
  });
});
