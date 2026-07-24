import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROJECT_TRUST_CHOICE,
  getProjectTrustChoice,
  getProjectTrustPresentation,
  getProjectTrustSettings,
  persistProjectTrustChoice,
  type PersistedProjectTrustSettings,
  type ProjectTrustPresentation,
  type ProjectTrustChoice,
} from '../projectTrustChoices';

const CASES: Array<{
  choice: ProjectTrustChoice;
  settings: PersistedProjectTrustSettings;
  presentation: ProjectTrustPresentation;
}> = [
  {
    choice: 'agent-verified',
    settings: { permissionMode: 'bypass-all', allowAllUsesClassifier: true },
    presentation: {
      choice: 'agent-verified',
      label: 'Agent-verified',
      description:
        'Works without interrupting you; risky actions like deploys and destructive commands pause for your OK.',
      icon: 'verified_user',
      severity: 'primary',
    },
  },
  {
    choice: 'allow-everything',
    settings: { permissionMode: 'bypass-all', allowAllUsesClassifier: false },
    presentation: {
      choice: 'allow-everything',
      label: 'Allow everything',
      description:
        'No prompts, no checks — every action runs immediately. For projects you fully trust.',
      icon: 'warning',
      severity: 'warning',
    },
  },
  {
    choice: 'allow-edits-only',
    settings: { permissionMode: 'allow-all', allowAllUsesClassifier: false },
    presentation: {
      choice: 'allow-edits-only',
      label: 'Allow edits only',
      description:
        'File edits run automatically; shell commands and web requests ask first.',
      icon: 'edit_note',
      severity: 'neutral',
    },
  },
  {
    choice: 'ask-every-time',
    settings: { permissionMode: 'ask', allowAllUsesClassifier: false },
    presentation: {
      choice: 'ask-every-time',
      label: 'Ask every time',
      description:
        'Approve each action before it runs. Your approvals are remembered.',
      icon: 'rule',
      severity: 'neutral',
    },
  },
];

describe('project trust choices', () => {
  it('defaults first-launch setup to Agent-verified', () => {
    expect(DEFAULT_PROJECT_TRUST_CHOICE).toBe('agent-verified');
  });

  it.each(CASES)(
    'maps $choice to persisted permission settings',
    ({ choice, settings }) => {
      expect(getProjectTrustSettings(choice)).toEqual(settings);
    }
  );

  it.each(CASES)(
    'maps persisted permission settings back to $choice',
    ({ choice, settings }) => {
      expect(
        getProjectTrustChoice(
          settings.permissionMode,
          settings.allowAllUsesClassifier
        )
      ).toBe(choice);
    }
  );

  it.each(CASES)(
    'selects the $choice label, icon, description, and severity',
    ({ settings, presentation }) => {
      expect(
        getProjectTrustPresentation(
          settings.permissionMode,
          settings.allowAllUsesClassifier
        )
      ).toEqual(presentation);
    }
  );

  it.each(CASES)(
    'persists $choice through both existing permission IPC channels',
    async ({ choice, settings }) => {
      const invoke = vi.fn(async () => undefined);

      await expect(
        persistProjectTrustChoice(invoke, '/projects/acme', choice)
      ).resolves.toEqual(settings);
      expect(invoke.mock.calls).toEqual([
        [
          'permissions:setPermissionMode',
          '/projects/acme',
          settings.permissionMode,
        ],
        [
          'permissions:setAllowAllUsesClassifier',
          '/projects/acme',
          settings.allowAllUsesClassifier,
        ],
      ]);
    }
  );
});
