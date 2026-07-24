import { describe, expect, it } from 'vitest';
import { getDiffPeekSizeForInteractiveWidgetHost } from '../interactiveWidgetHostProxy';

function makeHost(
  diffPeekSize: { width: number; height: number } | null,
) {
  return {
    sessionId: 'session-1',
    workspacePath: '/workspace',
    worktreeId: null,
    askUserQuestionSubmit: async () => {},
    askUserQuestionCancel: async () => {},
    requestUserInputSubmit: async () => {},
    requestUserInputCancel: async () => {},
    exitPlanModeApprove: async () => {},
    exitPlanModeStartNewSession: async () => {},
    exitPlanModeDeny: async () => {},
    exitPlanModeCancel: async () => {},
    toolPermissionSubmit: async () => {},
    toolPermissionCancel: async () => {},
    autoCommitEnabled: false,
    setAutoCommitEnabled: () => {},
    gitCommit: async () => ({ success: true }),
    gitCommitCancel: async () => {},
    superLoopBlockedFeedback: async () => ({ success: true }),
    openFile: async () => {},
    trackEvent: () => {},
    diffPeekSize,
  };
}

describe('getDiffPeekSizeForInteractiveWidgetHost', () => {
  it('preserves the unset state so diff peek surfaces can use their default size', () => {
    expect(getDiffPeekSizeForInteractiveWidgetHost(makeHost(null))).toBeNull();
  });

  it('returns a persisted diff peek size when one exists', () => {
    expect(
      getDiffPeekSizeForInteractiveWidgetHost(makeHost({ width: 720, height: 420 })),
    ).toEqual({ width: 720, height: 420 });
  });
});
