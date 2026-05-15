import React, { useState, useEffect } from 'react';
import './UnifiedOnboarding.css';

export interface UnifiedOnboardingProps {
  isOpen: boolean;
  onComplete: (data: OnboardingData) => void;
  onSkip: () => void;
  /** Force showing as new user ('new') or existing user ('existing') for testing */
  forcedMode?: 'new' | 'existing' | null;
}

export interface OnboardingData {
  role: string | null;
  customRole: string | null;
  referralSource: string | null;
  email: string | null;
  developerMode: boolean;
}

const ROLE_OPTIONS = [
  { value: '', label: 'No Answer' },
  { value: 'developer', label: 'Software Developer' },
  { value: 'product_manager', label: 'Product Manager' },
  { value: 'designer', label: 'Designer' },
  { value: 'writer', label: 'Writer / Content' },
  { value: 'researcher', label: 'Researcher' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'sales', label: 'Sales' },
  { value: 'finance', label: 'Finance' },
  { value: 'student', label: 'Student' },
  { value: 'hobbyist', label: 'Hobbyist / Personal Use' },
  { value: 'other', label: 'Other' },
];

const REFERRAL_OPTIONS = [
  { value: '', label: 'No Answer' },
  { value: 'search', label: 'Search' },
  { value: 'social', label: 'Social', hasSubOptions: true },
  { value: 'friend', label: 'Friend' },
  { value: 'ai', label: 'AI' },
  { value: 'ad', label: 'Ad' },
  { value: 'other', label: 'Other' },
];

const SOCIAL_MEDIA_OPTIONS = [
  'LinkedIn',
  'Twitter/X',
  'Reddit',
  'TikTok',
  'YouTube',
  'Instagram',
  'Facebook',
  'Other',
];

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const UnifiedOnboarding: React.FC<UnifiedOnboardingProps> = ({
  isOpen,
  onComplete,
  onSkip,
  forcedMode,
}) => {
  // Mode Selection (at top) - null means no selection yet
  const [developerMode, setDeveloperMode] = useState<boolean | null>(null);

  // User Background (optional data collection)
  const [selectedRole, setSelectedRole] = useState<string>('');
  const [customRole, setCustomRole] = useState<string>('');
  const [referralSource, setReferralSource] = useState<string>('');
  const [customReferral, setCustomReferral] = useState<string>('');
  const [aiDetail, setAiDetail] = useState<string>('');
  const [socialMediaPlatform, setSocialMediaPlatform] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [emailError, setEmailError] = useState<string>('');

  // Whether user has already filled out the old onboarding form (hide data collection)
  const [isExistingUser, setIsExistingUser] = useState<boolean>(false);
  // Force showing all fields for testing
  const [forceShowAllFields, setForceShowAllFields] = useState<boolean>(false);

  // Check for existing user on open.
  //
  // Defense-in-depth for issue #260: the dialog must remain interactive even
  // if the main process never answers. Race the IPC against a 3s timeout and
  // fall back to the new-user path on timeout. The mode-card click handlers
  // are pure local setState and do not depend on this result, so this fallback
  // strictly widens the "interactive" set of states. Logs timing so we can
  // see in nimbalyst-debug.log whether the IPC actually resolved.
  useEffect(() => {
    if (!isOpen) return;
    const t0 = performance.now();
    let cancelled = false;
    const checkExistingUser = async () => {
      try {
        const result = await Promise.race([
          window.electronAPI.invoke('onboarding:get').then((state) => ({ kind: 'ok' as const, state })),
          new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 3000)),
        ]);
        if (cancelled) return;
        const elapsed = Math.round(performance.now() - t0);
        if (result.kind === 'timeout') {
          console.warn(`[UnifiedOnboarding] onboarding:get timed out after ${elapsed}ms; using new-user fallback`);
          setIsExistingUser(false);
          return;
        }
        console.log(`[UnifiedOnboarding] onboarding:get resolved in ${elapsed}ms`);
        const hasExistingData = !!(result.state?.userRole && result.state.userRole !== 'skipped');
        setIsExistingUser(hasExistingData);
      } catch (error) {
        if (cancelled) return;
        console.error('[UnifiedOnboarding] onboarding:get failed:', error);
        setIsExistingUser(false);
      }
    };
    checkExistingUser();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setDeveloperMode(null); // No selection by default
      setSelectedRole('');
      setCustomRole('');
      setReferralSource('');
      setCustomReferral('');
      setAiDetail('');
      setSocialMediaPlatform('');
      setEmail('');
      setEmailError('');
      setForceShowAllFields(false);
    }
  }, [isOpen]);

  // Expose test helpers for developer tools
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as any).__onboardingTestHelpers = {
        showAllFields: () => setForceShowAllFields(true),
        hideDataCollection: () => setForceShowAllFields(false),
        setIsExistingUser: (value: boolean) => setIsExistingUser(value),
      };
      console.log('[UnifiedOnboarding] Test helpers exposed: window.__onboardingTestHelpers');
    }
    return () => {
      if (import.meta.env.DEV) {
        delete (window as any).__onboardingTestHelpers;
      }
    };
  }, []);

  // Auto-select Software Developer role when Developer mode is selected
  const handleModeChange = (isDeveloper: boolean) => {
    setDeveloperMode(isDeveloper);
    if (isDeveloper) {
      setSelectedRole('developer');
    }
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    if (value && !isValidEmail(value)) {
      setEmailError('Please enter a valid email address');
    } else {
      setEmailError('');
    }
  };

  const handleComplete = () => {
    // Build referral source string: if social, append platform (e.g., "social:LinkedIn")
    // If other, append custom text (e.g., "other:Podcast")
    let finalReferralSource = referralSource || null;
    if (referralSource === 'social' && socialMediaPlatform) {
      finalReferralSource = `social:${socialMediaPlatform}`;
    } else if (referralSource === 'ai' && aiDetail.trim()) {
      finalReferralSource = `ai:${aiDetail.trim()}`;
    } else if (referralSource === 'other' && customReferral.trim()) {
      finalReferralSource = `other:${customReferral.trim()}`;
    }

    const data: OnboardingData = {
      role: selectedRole || null,
      customRole: selectedRole === 'other' ? customRole.trim() || null : null,
      referralSource: finalReferralSource,
      email: email.trim() || null,
      developerMode: developerMode ?? false,
    };
    onComplete(data);
  };

  if (!isOpen) return null;

  // Determine if we should show data collection fields
  // forcedMode takes precedence over auto-detection
  let showDataCollection: boolean;
  if (forcedMode === 'new') {
    showDataCollection = true;
  } else if (forcedMode === 'existing') {
    showDataCollection = false;
  } else {
    showDataCollection = forceShowAllFields || !isExistingUser;
  }

  // Mode must be selected (required field)
  const isModeSelected = developerMode !== null;
  // Email validation (optional - only validate format if provided)
  const isEmailValid = email.trim() === '' || isValidEmail(email.trim());

  return (
    <div className="unified-onboarding-overlay">
      <div className="unified-onboarding-dialog unified-onboarding-single-screen">
        <div className="unified-onboarding-logo">
          <img src="./icon.png" alt="Nimbalyst" className="unified-onboarding-logo-image" />
        </div>
        <div className="unified-onboarding-header">
          <h2>Welcome to Nimbalyst</h2>
        </div>

        <div className="unified-onboarding-content">
          {/* Mode Selection - Always shown at top */}
          <div className="unified-onboarding-section">
            <label className="unified-onboarding-label unified-onboarding-label-centered">
              Choose Your Mode<span className="required-asterisk">*</span>
            </label>
            <div className="mode-selection">
              <label
                className={`mode-option ${developerMode === false ? 'selected' : ''}`}
                onClick={() => handleModeChange(false)}
              >
                <input
                  type="radio"
                  name="mode"
                  checked={developerMode === false}
                  onChange={() => handleModeChange(false)}
                />
                <div className="mode-option-content">
                  <div className="mode-option-header">
                    <span className="material-symbols-outlined mode-option-icon">
                      edit_note
                    </span>
                    <span className="mode-option-title">Standard Mode</span>
                  </div>
                  <p className="mode-option-description">
                    Simplified interface focused on writing, editing, and AI assistance
                  </p>
                </div>
              </label>

              <label
                className={`mode-option ${developerMode === true ? 'selected' : ''}`}
                onClick={() => handleModeChange(true)}
              >
                <input
                  type="radio"
                  name="mode"
                  checked={developerMode === true}
                  onChange={() => handleModeChange(true)}
                />
                <div className="mode-option-content">
                  <div className="mode-option-header">
                    <span className="material-symbols-outlined mode-option-icon">
                      terminal
                    </span>
                    <span className="mode-option-title">Developer Mode</span>
                  </div>
                  <p className="mode-option-description">
                    Full development environment with git worktrees, terminal access, development specific features
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Divider between mode selection and data collection */}
          {showDataCollection && <div className="unified-onboarding-divider" />}

          {/* Data Collection Fields - Only shown for new users, grayed out until mode selected */}
          {showDataCollection && (
            <div className={`unified-onboarding-data-collection ${!isModeSelected ? 'disabled' : ''}`}>
              {/* Role Dropdown */}
              <div className="unified-onboarding-section">
                <label className="unified-onboarding-label" htmlFor="role-select">
                  What best describes your role?
                </label>
                <select
                  id="role-select"
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  className="unified-onboarding-select"
                  disabled={!isModeSelected}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                {selectedRole === 'other' && (
                  <div className="custom-role-input">
                    <input
                      id="custom-role-input"
                      type="text"
                      placeholder="e.g. Designer, Writer, Student"
                      value={customRole}
                      onChange={(e) => setCustomRole(e.target.value)}
                      className="unified-onboarding-input"
                      disabled={!isModeSelected}
                      autoFocus
                    />
                  </div>
                )}
              </div>

              {/* Referral Source */}
              <div className="unified-onboarding-section">
                <label className="unified-onboarding-label" htmlFor="referral-select">
                  How did you hear about Nimbalyst?
                </label>
                <select
                  id="referral-select"
                  value={referralSource}
                  onChange={(e) => {
                    setReferralSource(e.target.value);
                    if (e.target.value !== 'social') {
                      setSocialMediaPlatform('');
                    }
                    if (e.target.value !== 'other') {
                      setCustomReferral('');
                    }
                    if (e.target.value !== 'ai') {
                      setAiDetail('');
                    }
                  }}
                  className="unified-onboarding-select"
                  disabled={!isModeSelected}
                >
                  {REFERRAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                {referralSource === 'other' && (
                  <div className="custom-role-input">
                    <input
                      id="custom-referral-input"
                      type="text"
                      placeholder="e.g. Podcast, Blog, Conference"
                      value={customReferral}
                      onChange={(e) => setCustomReferral(e.target.value)}
                      className="unified-onboarding-input"
                      disabled={!isModeSelected}
                      autoFocus
                    />
                  </div>
                )}

                {referralSource === 'ai' && (
                  <div className="custom-role-input">
                    <input
                      id="ai-detail-input"
                      type="text"
                      placeholder="What model and prompt did you use?"
                      value={aiDetail}
                      onChange={(e) => setAiDetail(e.target.value)}
                      className="unified-onboarding-input"
                      disabled={!isModeSelected}
                      autoFocus
                    />
                  </div>
                )}
              </div>

              {/* Email */}
              <div className="unified-onboarding-section">
                <label className="unified-onboarding-label" htmlFor="email-input">
                  Email address
                </label>
                <p className="unified-onboarding-help-text">
                  Receive occasional product updates and tips
                </p>
                <input
                  id="email-input"
                  type="email"
                  placeholder="your.email@example.com"
                  value={email}
                  onChange={(e) => handleEmailChange(e.target.value)}
                  className={`unified-onboarding-input ${emailError ? 'error' : ''}`}
                  disabled={!isModeSelected}
                />
                {emailError && <p className="error-text">{emailError}</p>}
              </div>

              {/* Social Media Platform - appears when social is selected */}
              {referralSource === 'social' && (
                <div className="unified-onboarding-section">
                  <label className="unified-onboarding-label" htmlFor="social-platform-select">
                    Which platform?
                  </label>
                  <select
                    id="social-platform-select"
                    value={socialMediaPlatform}
                    onChange={(e) => setSocialMediaPlatform(e.target.value)}
                    className="unified-onboarding-select"
                    disabled={!isModeSelected}
                  >
                    <option value="">Select one</option>
                    {SOCIAL_MEDIA_OPTIONS.map((platform) => (
                      <option key={platform} value={platform}>
                        {platform}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="unified-onboarding-disclaimer">
                <p className="disclaimer-text">
                  We collect usage data to improve Nimbalyst. No prompts or content is ever collected. You can opt out of analytics any time in Settings.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="unified-onboarding-footer unified-onboarding-footer-single">
          <button
            className="unified-onboarding-submit"
            onClick={handleComplete}
            disabled={!isModeSelected || (showDataCollection && !isEmailValid)}
          >
            Get Started
          </button>
          <p className="unified-onboarding-legal-links">
            By continuing, you agree to our{' '}
            <a
              href="https://nimbalyst.com/terms-of-service"
              target="_blank"
              rel="noopener noreferrer"
              className="unified-onboarding-link"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href="https://nimbalyst.com/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="unified-onboarding-link"
            >
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
};
