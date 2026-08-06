import type { OnboardingData } from '../components/UnifiedOnboarding/UnifiedOnboarding';

export async function persistOnboardingCompletion(data: OnboardingData): Promise<void> {
  const roleToStore = data.customRole || data.role || undefined;

  await window.electronAPI.invoke('onboarding:update', {
    userRole: roleToStore,
    userEmail: data.email || undefined,
    referralSource: data.referralSource || undefined,
    unifiedOnboardingCompleted: true,
    onboardingCompleted: true,
  });

  await window.electronAPI.invoke('developer-mode:set', data.developerMode);
}
