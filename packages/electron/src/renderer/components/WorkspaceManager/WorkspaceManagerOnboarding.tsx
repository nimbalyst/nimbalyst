import React, { useCallback, useState } from 'react';
import {
  UnifiedOnboarding,
  type OnboardingData,
  type OnboardingIntent,
} from '../UnifiedOnboarding/UnifiedOnboarding';
import { persistOnboardingCompletion } from '../../utils/onboardingCompletion';
import { WorkspaceManager } from './WorkspaceManager';

export interface WorkspaceManagerOnboardingProps {
  showOnboarding: boolean;
}

export const WorkspaceManagerOnboarding: React.FC<WorkspaceManagerOnboardingProps> = ({
  showOnboarding,
}) => {
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(showOnboarding);

  const handleComplete = useCallback(async (
    data: OnboardingData,
    intent: OnboardingIntent,
  ) => {
    await persistOnboardingCompletion(data);
    setIsOnboardingOpen(false);

    if (intent === 'tutorial') {
      // The overlay is already gone, so a rejection here would strand the user
      // on the project screen with no explanation (and an unhandled rejection).
      // Land them there deliberately instead — the welcome card's own CTA
      // retries and surfaces the error properly.
      try {
        const result = await window.electronAPI.tutorial.start();
        if (!result.success) {
          console.error('Failed to start tutorial from onboarding:', result.error);
        }
      } catch (error) {
        console.error('Failed to start tutorial from onboarding:', error);
      }
    }
  }, []);

  return (
    <>
      <WorkspaceManager />
      {isOnboardingOpen && (
        <UnifiedOnboarding
          isOpen
          onComplete={handleComplete}
          onSkip={() => {}}
          forcedMode="new"
        />
      )}
    </>
  );
};
