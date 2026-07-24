import React, { useState, useEffect } from 'react';
import OnboardingService from '../../services/OnboardingService';

export interface WelcomeModalProps {
  workspacePath: string;
  workspaceName: string;
  onComplete: () => void;
  onSkip: () => void;
}

type Step = 'welcome' | 'plans-location' | 'claude-code' | 'first-plan' | 'plan-view' | 'complete';

const WelcomeModal: React.FC<WelcomeModalProps> = ({
  workspacePath,
  workspaceName,
  onComplete,
  onSkip,
}) => {
  // Skip rendering in Playwright tests
  const isPlaywright = window.PLAYWRIGHT || (window as any).PLAYWRIGHT;

  const [currentStep, setCurrentStep] = useState<Step>('welcome');
  const [plansLocation, setPlansLocation] = useState<'nimbalyst-local/plans' | 'plans' | 'custom'>('nimbalyst-local/plans');
  const [customPlansLocation, setCustomPlansLocation] = useState('');
  const [checkInPlans, setCheckInPlans] = useState(false);
  const [commandsLocation, setCommandsLocation] = useState<'project' | 'global'>('project');
  const [enableClaudeCode, setEnableClaudeCode] = useState(false);
  const [installTrackCommand, setInstallTrackCommand] = useState(true);
  const [configureCLAUDEmd, setConfigureCLAUDEmd] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const steps: Step[] = ['welcome', 'plans-location', 'claude-code', 'first-plan', 'plan-view', 'complete'];
  const currentStepIndex = steps.indexOf(currentStep);
  const progress = ((currentStepIndex + 1) / steps.length) * 100;

  const handleNext = async () => {
    setError(null);

    // Handle step-specific actions
    if (currentStep === 'plans-location') {
      setIsProcessing(true);
      try {
        // Save plans location configuration
        // Note: The nimbalyst-local directory and .gitignore are created as needed
        const config = await OnboardingService.loadConfig(workspacePath);
        const finalLocation = plansLocation === 'custom' ? customPlansLocation : plansLocation;
        config.plansLocation = finalLocation;
        config.checkInPlans = checkInPlans;
        await OnboardingService.saveConfig(workspacePath, config);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to configure plans location');
        setIsProcessing(false);
        return;
      }
      setIsProcessing(false);
    }

    if (currentStep === 'claude-code' && enableClaudeCode) {
      setIsProcessing(true);
      try {
        // Update config with commands location first
        const config = await OnboardingService.loadConfig(workspacePath);
        config.commandsLocation = commandsLocation;
        config.claudeCodeIntegration.enabled = true;
        await OnboardingService.saveConfig(workspacePath, config);

        // Install selected components
        if (installTrackCommand) {
          await OnboardingService.installTrackCommand(workspacePath);
        }
        if (configureCLAUDEmd) {
          await OnboardingService.configureCLAUDEmd(workspacePath);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to configure Claude Code');
        setIsProcessing(false);
        return;
      }
      setIsProcessing(false);
    }

    // Move to next step
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < steps.length) {
      setCurrentStep(steps[nextIndex]);
    }
  };

  const handleBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(steps[prevIndex]);
    }
  };

  const handleSkip = async () => {
    try {
      await OnboardingService.completeOnboarding(workspacePath);
      onSkip();
    } catch (err) {
      console.error('Failed to save onboarding state:', err);
      onSkip();
    }
  };

  const handleComplete = async () => {
    setIsProcessing(true);
    try {
      await OnboardingService.completeOnboarding(workspacePath);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete onboarding');
    }
    setIsProcessing(false);
  };

  const handleCreateExamplePlan = async () => {
    setIsProcessing(true);
    try {
      const planPath = await OnboardingService.createExamplePlan(workspacePath);
      // Signal to open the plan (we'll implement this in the parent)
      window.electronAPI.send('open-file', planPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create example plan');
    }
    setIsProcessing(false);
  };

  // Don't render in Playwright tests
  if (isPlaywright) {
    return null;
  }

  return (
    <div className="welcome-modal-overlay nim-overlay bg-black/60">
      <div className="welcome-modal flex flex-col w-[90%] max-w-[700px] max-h-[85vh] rounded-2xl overflow-hidden nim-animate-slide-up bg-nim shadow-[0_20px_60px_rgba(0,0,0,0.4)]">
        {/* Progress Bar */}
        <div className="welcome-modal-progress h-1 relative bg-nim-tertiary">
          <div
            className="welcome-modal-progress-bar h-full transition-[width] duration-300 ease-out bg-nim-primary"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Header */}
        <div className="welcome-modal-header flex justify-between items-center px-8 pt-6 pb-4 border-b border-nim">
          <h2 className="m-0 text-2xl font-semibold text-nim">
            {currentStep === 'welcome' && 'Welcome to Nimbalyst'}
            {currentStep === 'plans-location' && 'Configure Plans Location'}
            {currentStep === 'claude-code' && 'Configure Claude Agent Integration'}
            {currentStep === 'first-plan' && 'Create Your First Plan'}
            {currentStep === 'plan-view' && 'Explore the Plan View'}
            {currentStep === 'complete' && 'All Set!'}
          </h2>
          <button
            className="welcome-modal-close flex items-center justify-center w-8 h-8 p-0 text-[28px] rounded-md bg-transparent border-none cursor-pointer transition-all duration-200 text-nim-muted hover:bg-nim-hover hover:text-nim"
            onClick={handleSkip}
            title="Skip onboarding"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="welcome-modal-content nim-scrollbar p-8 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div className="welcome-modal-error rounded-lg px-4 py-3 mb-5 bg-red-50 border border-red-200 text-red-600">
              <strong>Error:</strong> {error}
            </div>
          )}

          {currentStep === 'welcome' && (
            <div className="welcome-step text-center">
              <h3 className="m-0 mb-3 text-xl text-nim">Welcome to {workspaceName}</h3>
              <p className="mb-8 leading-relaxed text-nim-muted">
                Nimbalyst is a powerful editor with integrated planning, tracking, and AI features.
                This quick setup will help you get started.
              </p>
              <div className="welcome-features flex flex-col gap-5 text-left">
                <div className="welcome-feature p-4 rounded-lg bg-nim-secondary border border-nim">
                  <strong className="block mb-1.5 text-[15px] text-nim">Planning System</strong>
                  <p className="m-0 text-sm leading-normal text-nim-muted">Organize features, bugs, and tasks with structured markdown plans</p>
                </div>
                <div className="welcome-feature p-4 rounded-lg bg-nim-secondary border border-nim">
                  <strong className="block mb-1.5 text-[15px] text-nim">AI Integration</strong>
                  <p className="m-0 text-sm leading-normal text-nim-muted">Work with Claude Agent and other AI assistants for enhanced productivity</p>
                </div>
                <div className="welcome-feature p-4 rounded-lg bg-nim-secondary border border-nim">
                  <strong className="block mb-1.5 text-[15px] text-nim">Progress Tracking</strong>
                  <p className="m-0 text-sm leading-normal text-nim-muted">Visual plan view to monitor status and progress across all work items</p>
                </div>
              </div>
            </div>
          )}

          {currentStep === 'plans-location' && (
            <div className="plans-location-step max-w-[600px] mx-auto">
              <p className="step-description mb-6 leading-relaxed text-nim-muted">
                Where would you like to store your plan documents?
              </p>

              <div className="plan-location-options flex flex-col gap-3 mb-6">
                <label className="plan-location-option flex items-start gap-3 p-4 rounded-lg cursor-pointer transition-all duration-200 bg-nim-secondary border-2 border-nim hover:border-nim-primary hover:bg-nim-hover">
                  <input
                    type="radio"
                    name="plansLocation"
                    value="nimbalyst-local/plans"
                    checked={plansLocation === 'nimbalyst-local/plans'}
                    onChange={(e) => {
                      setPlansLocation('nimbalyst-local/plans');
                      setCheckInPlans(false);
                    }}
                    className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                  />
                  <div className="plan-location-content flex-1">
                    <strong className="block mb-1 text-[15px] text-nim">nimbalyst-local/plans</strong> (Recommended)
                    <p className="m-0 text-sm leading-normal text-nim-muted">Private plans not checked into version control. Best for personal planning.</p>
                  </div>
                </label>

                <label className="plan-location-option flex items-start gap-3 p-4 rounded-lg cursor-pointer transition-all duration-200 bg-nim-secondary border-2 border-nim hover:border-nim-primary hover:bg-nim-hover">
                  <input
                    type="radio"
                    name="plansLocation"
                    value="plans"
                    checked={plansLocation === 'plans'}
                    onChange={(e) => {
                      setPlansLocation('plans');
                      setCheckInPlans(true);
                    }}
                    className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                  />
                  <div className="plan-location-content flex-1">
                    <strong className="block mb-1 text-[15px] text-nim">plans/</strong>
                    <p className="m-0 text-sm leading-normal text-nim-muted">Shared plans checked into version control. Best for team collaboration.</p>
                  </div>
                </label>

                <label className="plan-location-option flex items-start gap-3 p-4 rounded-lg cursor-pointer transition-all duration-200 bg-nim-secondary border-2 border-nim hover:border-nim-primary hover:bg-nim-hover">
                  <input
                    type="radio"
                    name="plansLocation"
                    value="custom"
                    checked={plansLocation === 'custom'}
                    onChange={(e) => setPlansLocation('custom')}
                    className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                  />
                  <div className="plan-location-content flex-1">
                    <strong className="block mb-1 text-[15px] text-nim">Custom location</strong>
                    <p className="m-0 text-sm leading-normal text-nim-muted">Specify your own directory path</p>
                  </div>
                </label>

                {plansLocation === 'custom' && (
                  <div className="custom-location-input mt-3 p-3 rounded-md bg-nim-tertiary">
                    <input
                      type="text"
                      placeholder="e.g., docs/plans or .local/plans"
                      value={customPlansLocation}
                      onChange={(e) => setCustomPlansLocation(e.target.value)}
                      className="w-full py-2 px-3 rounded text-sm mb-3 outline-none bg-nim border border-nim text-nim focus:border-nim-focus"
                    />
                    <label className="checkbox-label flex items-start gap-2.5 cursor-pointer p-3 rounded-md transition-colors duration-200 hover:bg-nim-hover">
                      <input
                        type="checkbox"
                        checked={checkInPlans}
                        onChange={(e) => setCheckInPlans(e.target.checked)}
                        className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                      />
                      <span className="leading-normal text-nim">Check into version control</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="plan-location-info p-4 rounded-lg bg-nim-secondary border border-nim">
                <p className="m-0 mb-2 font-semibold text-nim"><strong>What happens:</strong></p>
                <ul className="m-0 pl-6 text-nim-muted">
                  <li className="mb-1.5">Plans directory will be created at the specified location</li>
                  {!checkInPlans && (
                    <li className="mb-1.5">The directory will be added to <code className="px-1.5 py-0.5 rounded font-mono text-[13px] bg-nim-tertiary">.gitignore</code> (not checked in)</li>
                  )}
                  {checkInPlans && (
                    <li className="mb-1.5">Plans will be included in your repository (team collaboration)</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {currentStep === 'claude-code' && (
            <div className="claude-code-step max-w-[600px] mx-auto">
              <p className="step-description mb-6 leading-relaxed text-nim-muted">
                Configure Claude Agent to understand Nimbalyst's extended markdown features for
                plans and tracking.
              </p>

              <div className="claude-code-option mb-6">
                <label className="checkbox-label flex items-start gap-2.5 cursor-pointer p-3 rounded-md transition-colors duration-200 hover:bg-nim-hover">
                  <input
                    type="checkbox"
                    checked={enableClaudeCode}
                    onChange={(e) => setEnableClaudeCode(e.target.checked)}
                    className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                  />
                  <span className="leading-normal text-nim">Enable Claude Agent integration</span>
                </label>
              </div>

              {enableClaudeCode && (
                <div className="claude-code-options p-5 rounded-lg mt-4 bg-nim-secondary border border-nim">
                  <p className="options-intro m-0 mb-4 font-semibold text-nim">Where should commands be installed?</p>

                  <div className="commands-location-options">
                    <label className="plan-location-option flex items-start gap-3 p-4 rounded-lg cursor-pointer transition-all duration-200 bg-nim-secondary border-2 border-nim hover:border-nim-primary hover:bg-nim-hover">
                      <input
                        type="radio"
                        name="commandsLocation"
                        value="project"
                        checked={commandsLocation === 'project'}
                        onChange={(e) => setCommandsLocation('project')}
                        className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                      />
                      <div className="plan-location-content flex-1">
                        <strong className="block mb-1 text-[15px] text-nim">Project (.claude/)</strong> (Recommended)
                        <p className="m-0 text-sm leading-normal text-nim-muted">Commands stored in project directory, can be checked into version control for team sharing</p>
                      </div>
                    </label>

                    <label className="plan-location-option flex items-start gap-3 p-4 mt-3 rounded-lg cursor-pointer transition-all duration-200 bg-nim-secondary border-2 border-nim hover:border-nim-primary hover:bg-nim-hover">
                      <input
                        type="radio"
                        name="commandsLocation"
                        value="global"
                        checked={commandsLocation === 'global'}
                        onChange={(e) => setCommandsLocation('global')}
                        className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                      />
                      <div className="plan-location-content flex-1">
                        <strong className="block mb-1 text-[15px] text-nim">Global (~/.claude/)</strong>
                        <p className="m-0 text-sm leading-normal text-nim-muted">Commands stored in home directory, shared across all projects</p>
                      </div>
                    </label>
                  </div>

                  <p className="options-intro m-0 mb-4 mt-6 font-semibold text-nim">Select components to install:</p>

                  <label className="checkbox-label flex items-start gap-2.5 cursor-pointer p-3 rounded-md transition-colors duration-200 mb-2 hover:bg-nim-hover">
                    <input
                      type="checkbox"
                      checked={installTrackCommand}
                      onChange={(e) => setInstallTrackCommand(e.target.checked)}
                      className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                    />
                    <span className="leading-normal text-nim">
                      <strong className="block mb-1">/track command</strong> - Create tracking items (bugs, tasks, ideas)
                    </span>
                  </label>

                  <label className="checkbox-label flex items-start gap-2.5 cursor-pointer p-3 rounded-md transition-colors duration-200 mb-2 hover:bg-nim-hover">
                    <input
                      type="checkbox"
                      checked={configureCLAUDEmd}
                      onChange={(e) => setConfigureCLAUDEmd(e.target.checked)}
                      className="mt-0.5 cursor-pointer w-[18px] h-[18px] shrink-0"
                    />
                    <span className="leading-normal text-nim">
                      <strong className="block mb-1">CLAUDE.md</strong> - Add Nimbalyst-specific instructions
                    </span>
                  </label>

                  <div className="config-info mt-5 pt-5 border-t border-nim">
                    <p className="m-0 mb-3 font-semibold text-nim">
                      <strong>What gets installed:</strong>
                    </p>
                    <ul className="m-0 pl-6 text-nim-muted">
                      <li className="mb-1.5">
                        <code className="px-1.5 py-0.5 rounded font-mono text-[13px] bg-nim-tertiary">{commandsLocation === 'project' ? '.claude' : '~/.claude'}/commands/track.md</code> - Tracking command
                      </li>
                      <li className="mb-1.5">
                        <code className="px-1.5 py-0.5 rounded font-mono text-[13px] bg-nim-tertiary">CLAUDE.md</code> - Planning system documentation
                      </li>
                    </ul>
                  </div>
                </div>
              )}

              {!enableClaudeCode && (
                <div className="skip-info p-4 rounded-lg mt-4 bg-nim-secondary border border-nim">
                  <p className="m-0 text-nim-muted">You can enable Claude Agent integration later from project settings.</p>
                </div>
              )}
            </div>
          )}

          {currentStep === 'first-plan' && (
            <div className="first-plan-step max-w-[600px] mx-auto">
              <p className="step-description mb-6 leading-relaxed text-nim-muted">
                Let's create your first plan document to get familiar with the system.
              </p>

              <div className="plan-options flex flex-col gap-3">
                <button
                  className="plan-option-button flex items-start gap-4 p-4 rounded-lg cursor-pointer transition-all duration-200 text-left w-full bg-nim-secondary border-2 border-nim hover:border-nim-primary hover:bg-nim-hover hover:-translate-y-0.5 hover:shadow-lg"
                  onClick={handleCreateExamplePlan}
                >
                  <div className="plan-option-content flex-1">
                    <strong className="block mb-1 text-[15px] text-nim">Create Example Plan</strong>
                    <p className="m-0 text-sm leading-normal text-nim-muted">Start with a pre-filled example that shows the plan structure</p>
                  </div>
                </button>


                <div className="plan-option-info py-3 px-4 rounded-md text-sm leading-normal bg-nim-tertiary text-nim-muted">
                  Plans are stored in the <code className="px-1.5 py-0.5 rounded font-mono bg-nim">plans/</code> directory as markdown files with
                  frontmatter metadata.
                </div>
              </div>
            </div>
          )}

          {currentStep === 'plan-view' && (
            <div className="plan-view-step max-w-[600px] mx-auto">
              <p className="step-description mb-6 leading-relaxed text-nim-muted">
                The plan view helps you track all your plans, their status, and progress.
              </p>

              <div className="plan-view-features flex flex-col gap-4 mb-6">
                <div className="plan-view-feature p-4 rounded-lg bg-nim-secondary border border-nim">
                  <strong className="block mb-1.5 text-[15px] text-nim">Status Overview</strong>
                  <p className="m-0 text-sm leading-normal text-nim-muted">See all plans grouped by status (draft, in-progress, completed, etc.)</p>
                </div>
                <div className="plan-view-feature p-4 rounded-lg bg-nim-secondary border border-nim">
                  <strong className="block mb-1.5 text-[15px] text-nim">Filter & Sort</strong>
                  <p className="m-0 text-sm leading-normal text-nim-muted">Filter by type, priority, or tags. Sort by date, progress, or priority.</p>
                </div>
                <div className="plan-view-feature p-4 rounded-lg bg-nim-secondary border border-nim">
                  <strong className="block mb-1.5 text-[15px] text-nim">Progress Tracking</strong>
                  <p className="m-0 text-sm leading-normal text-nim-muted">Visual progress bars show completion percentage for each plan</p>
                </div>
              </div>

              <div className="plan-view-access p-4 rounded-lg bg-nim-secondary border border-nim">
                <p className="m-0 mb-3 font-semibold text-nim">
                  <strong>Access the plan view:</strong>
                </p>
                <ul className="m-0 pl-6 text-nim-muted">
                  <li className="mb-1.5">View menu → Plans</li>
                  <li className="mb-1.5">Keyboard shortcut (if configured)</li>
                  <li className="mb-1.5">Click the plans icon in the sidebar</li>
                </ul>
              </div>
            </div>
          )}

          {currentStep === 'complete' && (
            <div className="complete-step text-center max-w-[500px] mx-auto">
              <h3 className="m-0 mb-3 text-2xl text-nim">You're all set!</h3>
              <p className="mb-8 text-nim-muted">Your workspace is configured and ready to use.</p>

              <div className="next-steps text-left p-5 rounded-lg mb-6 bg-nim-secondary border border-nim">
                <h4 className="m-0 mb-3 text-base text-nim">Next steps:</h4>
                <ul className="m-0 pl-6 text-nim-muted">
                  <li className="mb-2 leading-normal">Explore your example plan document</li>
                  <li className="mb-2 leading-normal">Create your first real plan with File → New Plan</li>
                  <li className="mb-2 leading-normal">Check out the plan view to see all your plans</li>
                  <li className="mb-2 leading-normal">Start organizing your work with the tracking system</li>
                </ul>
              </div>

              <div className="help-links text-center">
                <p className="m-0 mb-2 font-semibold text-nim">
                  <strong>Need help?</strong>
                </p>
                <p className="m-0 mb-1.5 text-nim-muted">Access documentation from the Help menu or visit the Nimbalyst website.</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="welcome-modal-footer flex justify-between items-center py-4 px-8 border-t border-nim bg-nim-secondary">
          <div className="welcome-modal-footer-left flex gap-3">
            <button
              className="welcome-modal-button nim-btn-secondary py-2.5 px-5 rounded-lg text-sm font-medium"
              onClick={handleSkip}
              disabled={isProcessing}
            >
              Skip Setup
            </button>
          </div>
          <div className="welcome-modal-footer-right flex gap-3">
            {currentStepIndex > 0 && (
              <button
                className="welcome-modal-button nim-btn-secondary py-2.5 px-5 rounded-lg text-sm font-medium"
                onClick={handleBack}
                disabled={isProcessing}
              >
                Back
              </button>
            )}
            {currentStep !== 'complete' ? (
              <button
                className="welcome-modal-button nim-btn-primary py-2.5 px-5 rounded-lg text-sm font-medium hover:opacity-90 hover:-translate-y-px hover:shadow-md"
                onClick={handleNext}
                disabled={isProcessing}
              >
                {isProcessing ? 'Processing...' : 'Next'}
              </button>
            ) : (
              <button
                className="welcome-modal-button nim-btn-primary py-2.5 px-5 rounded-lg text-sm font-medium hover:opacity-90 hover:-translate-y-px hover:shadow-md"
                onClick={handleComplete}
                disabled={isProcessing}
              >
                {isProcessing ? 'Finishing...' : 'Get Started'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WelcomeModal;
