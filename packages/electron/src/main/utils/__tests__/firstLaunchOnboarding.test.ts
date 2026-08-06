import { describe, expect, it } from 'vitest';
import { shouldShowFirstLaunchOnboarding } from '../firstLaunchOnboarding';

describe('shouldShowFirstLaunchOnboarding', () => {
  it('shows onboarding on a brand-new first launch', () => {
    expect(shouldShowFirstLaunchOnboarding({
      unifiedOnboardingCompleted: false,
      launchCount: 1,
    })).toBe(true);
  });

  it('treats an absent completion flag as brand-new on the first launch', () => {
    expect(shouldShowFirstLaunchOnboarding({
      unifiedOnboardingCompleted: undefined,
      launchCount: 1,
    })).toBe(true);
  });

  it.each([2, 3, 20])('skips onboarding after launch count 1 (count %i)', (launchCount) => {
    expect(shouldShowFirstLaunchOnboarding({
      unifiedOnboardingCompleted: false,
      launchCount,
    })).toBe(false);
  });

  it('skips onboarding when it was already completed', () => {
    expect(shouldShowFirstLaunchOnboarding({
      unifiedOnboardingCompleted: true,
      launchCount: 1,
    })).toBe(false);
  });
});
