// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORG_WIZARD_DRAFT_SETTING_KEY,
  persistOrgWizardDraft,
  readOrgWizardDraft,
} from '../orgOnboardingStorage';
import { createOrgWizardState } from '../orgWizardModel';

const settings = new Map<string, unknown>();
const invoke = vi.fn(async (channel: string, key: string, value?: unknown) => {
  if (channel === 'app-settings:get') return settings.get(key);
  if (channel === 'app-settings:set') {
    settings.set(key, value);
    return true;
  }
  throw new Error(`Unexpected channel: ${channel}`);
});

beforeEach(() => {
  settings.clear();
  invoke.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { invoke },
  });
});

describe('organization wizard persistence', () => {
  it('serializes and rehydrates an in-flight organization name', async () => {
    const state = {
      ...createOrgWizardState({ orgName: 'Acme Robotics' }),
      emails: ['member@example.com'],
    };

    expect(await persistOrgWizardDraft(state)).toBe(true);
    expect(settings.has(ORG_WIZARD_DRAFT_SETTING_KEY)).toBe(true);
    await expect(readOrgWizardDraft(null)).resolves.toMatchObject({
      orgName: 'Acme Robotics',
      emails: ['member@example.com'],
    });
  });

  /**
   * The draft lives under one app-settings key for the whole machine, so a
   * second account signing in here would otherwise open the wizard already
   * holding the first user's org name and invite list.
   */
  it('gives a draft back only to the identity that stamped it', async () => {
    await persistOrgWizardDraft({
      ...createOrgWizardState({ orgName: 'Acme Robotics', owner: 'me@example.com' }),
      emails: ['member@example.com'],
    });

    await expect(readOrgWizardDraft('me@example.com')).resolves.toMatchObject({
      orgName: 'Acme Robotics',
      emails: ['member@example.com'],
    });

    await expect(readOrgWizardDraft('someone-else@example.com')).resolves.toBeNull();
    // The other user's draft is dropped rather than left to reappear.
    expect(settings.get(ORG_WIZARD_DRAFT_SETTING_KEY)).toBeNull();
  });

  it('hydrates a draft typed before sign-in for whoever signs in', async () => {
    await persistOrgWizardDraft(
      createOrgWizardState({ orgName: 'Typed first', isAuthenticated: false }),
    );

    await expect(readOrgWizardDraft('me@example.com')).resolves.toMatchObject({
      orgName: 'Typed first',
    });
    expect(settings.get(ORG_WIZARD_DRAFT_SETTING_KEY)).not.toBeNull();
  });
});
