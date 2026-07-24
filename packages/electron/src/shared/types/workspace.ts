/**
 * Shared workspace and onboarding types.
 * These types are used by both main and renderer processes.
 */

export interface OnboardingConfig {
  version: string;
  onboardingCompleted: boolean;
  plansLocation: 'nimbalyst-local/plans' | 'plans' | string;
  checkInPlans: boolean;
  commandsLocation: 'project' | 'global'; // .claude/ vs ~/.claude/
  commandInstallToastDismissed?: boolean; // User clicked Skip on the commands install toast
  claudeCodeIntegration: {
    enabled: boolean;
    trackCommandInstalled: boolean;
    mockupCommandInstalled?: boolean;
    claudeMdConfigured: boolean;
  };
  features: {
    analytics: boolean;
    tracking: boolean;
  };
}

export const DEFAULT_ONBOARDING_CONFIG: OnboardingConfig = {
  version: '1.0.0',
  onboardingCompleted: false,
  plansLocation: 'nimbalyst-local/plans',
  checkInPlans: false,
  commandsLocation: 'project',
  claudeCodeIntegration: {
    enabled: false,
    trackCommandInstalled: false,
    claudeMdConfigured: false,
  },
  features: {
    analytics: false,
    tracking: true,
  },
};
