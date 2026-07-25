import { describe, expect, it } from 'vitest';
import {
  clampAgentRightPanelWidth,
  MIN_AGENT_MAIN_PANEL_WIDTH,
  MIN_AGENT_RIGHT_PANEL_WIDTH,
} from '../agentMode';

describe('clampAgentRightPanelWidth', () => {
  it('allows the right panel to occupy all but the reserved main-panel strip', () => {
    expect(clampAgentRightPanelWidth(2_000, 1_200)).toBe(
      1_200 - MIN_AGENT_MAIN_PANEL_WIDTH,
    );
  });

  it('preserves widths inside the available range', () => {
    expect(clampAgentRightPanelWidth(840, 1_200)).toBe(840);
  });

  it('retains the minimum usable right-panel width', () => {
    expect(clampAgentRightPanelWidth(40, 1_200)).toBe(MIN_AGENT_RIGHT_PANEL_WIDTH);
  });
});
