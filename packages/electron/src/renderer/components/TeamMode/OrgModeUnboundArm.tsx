import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

// Accept an invitation / create an organization: what is left to do on the
// unbound arm, where there is no organization to open the management dialog
// against. Administration itself is that dialog, never this window.
import { OrganizationOnboardingChoices } from '../Settings/panels/OrganizationOnboardingChoices';
// Narrow imports: the `dialogs` barrel would drag every dialog component into
// the org window's module graph.
import { DIALOG_IDS } from '../../dialogs/registry';
import { dialogRef } from '../../contexts/DialogContext';
import { AlphaBadge } from '../common/AlphaBadge';
import { TEAM_BETA_TOOLTIP, TeamBetaNotice } from '../common/TeamBetaNotice';
import { organizationCreationEnabled } from '../../store/atoms/settingsDomains';
import { activeOrganizations } from './defaultOrg';
import { OrgWindowTitleBar } from './OrgWindowTitleBar';
import type { OrgModeChrome, TeamSummary } from './orgModeTypes';

/**
 * No organization resolved: offer to create one (or accept a pending invite).
 *
 * `targetedOrgId` is the destination the surface was pointed at. Set means the
 * membership has not caught up yet rather than that the user has no
 * organization, and the copy plus the recovery card below say so.
 */
export function OrgModeUnboundArm({
  chrome,
  targetedOrgId,
  organizations,
  loadError,
  onSelectOrganization,
  onReload,
  onLoadError,
}: {
  chrome: OrgModeChrome;
  targetedOrgId: string | null;
  organizations: TeamSummary[];
  loadError: string | null;
  onSelectOrganization: (orgId: string) => void;
  onReload: () => void;
  onLoadError: (message: string) => void;
}) {
  return (
    <section className="org-mode-host team-mode team-mode-unbound flex h-full flex-col overflow-hidden bg-[var(--nim-bg)] text-[var(--nim-text)]" data-component="OrgModeHost">
      {chrome === 'window' && <OrgWindowTitleBar />}
      <header
        className="team-mode-header org-window-drag-region border-b border-nim px-6 py-5"
        data-window-drag-region="true"
      >
        <h1 className="m-0 flex items-center gap-2 text-xl font-semibold text-[var(--nim-text)]">
          Organizations
          <AlphaBadge size="sm" stage="beta" tooltip={TEAM_BETA_TOOLTIP} className="org-window-no-drag" />
        </h1>
        <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">
          {targetedOrgId
            ? 'This organization is not available yet. Your destination has been preserved.'
            : loadError
              ? 'Your organizations could not be loaded.'
              : organizationCreationEnabled
              ? 'Create an organization to collaborate with a team, or accept a pending invitation.'
              : 'Creating an organization is temporarily unavailable. Accept a pending invitation to get started.'}
        </p>
        <TeamBetaNotice className="mt-2.5 max-w-[640px]" />
      </header>
      <main className="team-mode-content flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[900px]">
          {/* Escape hatch: never leave the user here with orgs they could
              administer but no way to reach them. */}
          <div className="team-mode-organization-choices mb-3 flex flex-col gap-2" data-testid="team-mode-organization-choices">
            {activeOrganizations(organizations).map((organization) => (
              <div
                key={organization.orgId}
                className="team-mode-organization-row org-window-no-drag flex items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] pr-2"
              >
                <button
                  type="button"
                  className="team-mode-organization-choice flex min-w-0 flex-1 items-center justify-between rounded-md px-3 py-2 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  data-testid="team-mode-organization-choice"
                  data-org-id={organization.orgId}
                  onClick={() => onSelectOrganization(organization.orgId)}
                >
                  <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  {organization.role && (
                    <span className="ml-2 shrink-0 text-[11px] capitalize text-[var(--nim-text-muted)]">
                      {organization.role}
                    </span>
                  )}
                </button>
                {/* Administration is the dialog, which this window hosts through
                    its own DialogProvider — not a screen of its own here. */}
                <button
                  type="button"
                  className="team-mode-organization-settings shrink-0 rounded p-1.5 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                  data-testid="team-mode-organization-settings"
                  data-org-id={organization.orgId}
                  title={`Organization settings for ${organization.name}`}
                  aria-label={`Organization settings for ${organization.name}`}
                  onClick={() => dialogRef.current?.open(DIALOG_IDS.ORG_MANAGEMENT, {
                    orgId: organization.orgId,
                  })}
                >
                  <MaterialSymbol icon="settings" size={16} />
                </button>
              </div>
            ))}
          </div>
          {(targetedOrgId || loadError) && (
            <div
              className="team-mode-organization-recovery mb-4 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4"
              data-testid="team-mode-organization-recovery"
            >
              <p className="m-0 text-sm text-[var(--nim-text)]">
                {loadError ?? 'Waiting for your organization membership to finish loading.'}
              </p>
              <button
                type="button"
                className="mt-3 rounded-md bg-[var(--nim-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--nim-on-primary)]"
                data-testid="team-mode-retry-organization"
                onClick={onReload}
              >
                Retry
              </button>
            </div>
          )}
          <OrganizationOnboardingChoices
            organizations={organizations}
            onChanged={onReload}
            onError={onLoadError}
            // The header above already carries the disclosure.
            showBetaNotice={false}
          />
        </div>
      </main>
    </section>
  );
}
