export interface FirstLaunchOnboardingState {
  unifiedOnboardingCompleted?: boolean;
  launchCount: number;
}

export function shouldShowFirstLaunchOnboarding({
  unifiedOnboardingCompleted,
  launchCount,
}: FirstLaunchOnboardingState): boolean {
  return unifiedOnboardingCompleted !== true && launchCount === 1;
}
