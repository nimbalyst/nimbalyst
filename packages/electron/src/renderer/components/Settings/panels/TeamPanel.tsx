import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useDialogState } from '../../../contexts/DialogContext';
import { DIALOG_IDS } from '../../../dialogs/registry';
import type { CreateTeamData } from '../../../dialogs/teamDialogs';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import { SecurityEncryptionSection } from './H2EncryptionMigration';
import { MoveProjectWizard } from './MoveProjectWizard';
import { MergeOrgWizard } from './MergeOrgWizard';

// ============================================================================
// Types
// ============================================================================

type TrustStatus = 'verified' | 'pending' | 'unverified' | 'fingerprint-changed';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  trustStatus: TrustStatus;
  avatarColor: string;
  isYou?: boolean;
  invitedAt?: string;
}

interface MemberFingerprint {
  fingerprint: string;
  trustStatus: 'verified' | 'fingerprint-changed' | 'unverified';
}

interface TeamData {
  orgId: string;
  name: string;
  gitRemote: string;
  gitRemoteHash: string | null;
  /** Epic H3 P0/A: the routing key of the project THIS workspace resolved to. */
  teamProjectId?: string | null;
  members: TeamMember[];
  callerRole: string;
  membershipType?: string;
}

interface PendingInvite {
  orgId: string;
  name: string;
  membershipType: string;
}

/** Epic H3 P0/A: one project in the active org's registry. */
interface OrgProjectSummary {
  projectId: string;
  teamProjectId: string;
  gitRemoteHash: string | null;
  slug: string | null;
  name: string | null;
}

interface TeamPanelProps {
  workspacePath?: string;
  /**
   * Epic H3 P3: when rendered in the Organization settings scope, the panel is
   * keyed to this org (selected in the OrgSwitcher) rather than resolved from the
   * active workspace's git remote. When unset, it falls back to workspace
   * resolution (project scope / legacy).
   */
  orgId?: string;
}

const AVATAR_COLORS = ['#60a5fa', '#a78bfa', '#4ade80', '#fbbf24', '#f472b6', '#34d399'];

function getAvatarColor(index: number): string {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

// ============================================================================
// Sub-components
// ============================================================================

function MemberAvatar({ name, email, color, isPending }: {
  name?: string;
  email: string;
  color: string;
  isPending?: boolean;
}) {
  if (isPending) {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
        <MaterialSymbol icon="mail" size={14} />
      </div>
    );
  }

  const initial = (name?.[0] || email[0] || '?').toUpperCase();
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-[13px] font-semibold text-white"
      style={{ background: color }}
    >
      {initial}
    </div>
  );
}

function TrustStatusIcon({ status, onClick }: { status: TrustStatus; onClick?: () => void }) {
  const clickProps = onClick ? { onClick, role: 'button' as const, tabIndex: 0, style: { cursor: 'pointer' } } : {};

  if (status === 'verified') {
    return (
      <span className="flex items-center text-[var(--nim-success)]" title="Identity verified" {...clickProps}>
        <MaterialSymbol icon="verified_user" size={14} fill />
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="flex items-center text-[var(--nim-warning)]" title="Pending">
        <MaterialSymbol icon="schedule" size={14} />
      </span>
    );
  }
  if (status === 'fingerprint-changed') {
    return (
      <span className="flex items-center text-[var(--nim-error)]" title="Key changed since verification" {...clickProps}>
        <MaterialSymbol icon="gpp_maybe" size={14} fill />
      </span>
    );
  }
  return (
    <span className="flex items-center text-[#f97316]" title="Not verified" {...clickProps}>
      <MaterialSymbol icon="shield" size={14} />
    </span>
  );
}

function RoleBadge({ role, editable, onChange }: { role: 'admin' | 'member'; editable?: boolean; onChange?: (newRole: 'admin' | 'member') => void }) {
  const colorClass = role === 'admin'
    ? 'bg-[rgba(96,165,250,0.15)] text-[var(--nim-primary)]'
    : 'bg-[rgba(180,180,180,0.1)] text-[var(--nim-text-faint)]';

  if (editable && onChange) {
    return (
      <select
        value={role}
        onChange={(e) => onChange(e.target.value as 'admin' | 'member')}
        className={`${colorClass} px-[5px] py-[2px] rounded-[10px] text-[10px] font-semibold border-none cursor-pointer outline-none hover:ring-1 hover:ring-[var(--nim-primary)]`}
      >
        <option value="admin">Admin</option>
        <option value="member">Member</option>
      </select>
    );
  }

  return (
    <span className={`${colorClass} px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold`}>
      {role === 'admin' ? 'Admin' : 'Member'}
    </span>
  );
}

function PendingBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold bg-[rgba(251,191,36,0.15)] text-[var(--nim-warning)]">
      <MaterialSymbol icon="schedule" size={8} />
      Pending
    </span>
  );
}

function TeamPricingNotice() {
  return (
    <div className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--nim-text-faint)]">
      <MaterialSymbol icon="info" size={13} className="mt-[2px] shrink-0" />
      <span>
        Nimbalyst Teams is <span className="text-[var(--nim-text-muted)]">free during alpha</span>. We plan to introduce a paid subscription tier for teams in the future; existing teams will get advance notice before any pricing change.
      </span>
    </div>
  );
}

function EncryptionCard() {
  return (
    <div className="p-3.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <MaterialSymbol icon="lock" size={16} className="text-[var(--nim-success)]" />
        <span className="text-[13px] font-semibold text-[var(--nim-success)]">
          Encryption &amp; Privacy
        </span>
      </div>
      <p className="m-0 mb-2 text-[12px] text-[var(--nim-text-muted)] leading-relaxed">
        Team data (trackers and documents) is encrypted in transit and at rest and
        isolated per team. Depending on your team&apos;s setup, encryption keys are
        either held only by members&apos; devices, or managed by Nimbalyst so the
        team is reachable from the web, CLI, and cloud agents.
      </p>
      <ul className="m-0 pl-5 text-[12px] text-[var(--nim-text)] leading-7">
        <li>Only authorized team members can access shared data</li>
        <li>Your personal device sync (sessions, drafts, settings) stays zero-knowledge — keys never leave your devices</li>
        <li>Need true zero-knowledge for team data? Self-hosting is the answer</li>
      </ul>
    </div>
  );
}

function ErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 p-2.5 mb-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-md">
      <MaterialSymbol icon="error" size={14} className="text-[var(--nim-error)] shrink-0" />
      <span className="flex-1 text-[12px] text-[var(--nim-error)]">{error}</span>
      <button
        onClick={onDismiss}
        className="shrink-0 bg-transparent border-none cursor-pointer text-[var(--nim-text-faint)]"
      >
        <MaterialSymbol icon="close" size={14} />
      </button>
    </div>
  );
}

// ============================================================================
// Member Fingerprint Detail (expandable row)
// ============================================================================

function MemberFingerprintDetail({ member, fingerprint, onVerify, onRevoke, onReshareKey, isAdmin }: {
  member: TeamMember;
  fingerprint: MemberFingerprint | null;
  onVerify: () => void;
  onRevoke: () => void;
  onReshareKey?: () => void;
  isAdmin?: boolean;
}) {
  if (!fingerprint) {
    return (
      <div className="px-3.5 py-2.5 bg-[var(--nim-bg)] text-[12px] text-[var(--nim-text-faint)]">
        Loading fingerprint...
      </div>
    );
  }

  const shortFingerprint = fingerprint.fingerprint.split(':').slice(0, 16).join(':');

  return (
    <div className="px-3.5 py-3 bg-[var(--nim-bg)] border-b border-[var(--nim-bg-secondary)]">
      {fingerprint.trustStatus === 'fingerprint-changed' && (
        <div className="flex items-center gap-2 p-2 mb-2.5 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded">
          <MaterialSymbol icon="warning" size={14} className="text-[var(--nim-error)] shrink-0" />
          <span className="text-[11px] text-[var(--nim-error)]">
            This member's identity key has changed since you last verified it.
            Verify their new fingerprint before trusting data from them.
          </span>
        </div>
      )}

      <div className="mb-2">
        <div className="text-[11px] text-[var(--nim-text-faint)] mb-1">Identity Key Fingerprint</div>
        <div className="px-2.5 py-2 bg-[var(--nim-bg-secondary)] rounded font-mono text-[11px] text-[var(--nim-text-muted)] leading-relaxed break-all select-text">
          {shortFingerprint}
        </div>
      </div>

      <p className="text-[11px] text-[var(--nim-text-faint)] leading-relaxed mb-2.5 m-0">
        Compare this fingerprint with {member.name || member.email} out-of-band
        (e.g., in person or via a secure channel) to verify their identity.
      </p>

      <div className="flex items-center gap-2">
        {fingerprint.trustStatus === 'verified' ? (
          <button
            onClick={onRevoke}
            className="px-2.5 py-1 text-[11px] bg-transparent border border-[rgba(239,68,68,0.4)] rounded text-[var(--nim-error)] cursor-pointer hover:bg-[rgba(239,68,68,0.1)]"
          >
            Revoke Trust
          </button>
        ) : (
          <button
            onClick={onVerify}
            className="px-2.5 py-1 text-[11px] bg-[var(--nim-success)] border-none rounded text-white cursor-pointer hover:opacity-90"
          >
            Mark as Verified
          </button>
        )}
        {isAdmin && onReshareKey && (
          <button
            onClick={onReshareKey}
            className="px-2.5 py-1 text-[11px] bg-transparent border border-[var(--nim-border)] rounded text-[var(--nim-text-muted)] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
            title="Re-share the encryption key with this member (e.g., after they changed devices)"
          >
            Re-share Key
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// No Team State
// ============================================================================

function NoTeamState({ gitRemote, onCreateTeam, loading, adminOrgs, onAddToOrg, addingProject, hasGitRemote }: {
  gitRemote: string;
  onCreateTeam: () => void;
  loading?: boolean;
  adminOrgs: { orgId: string; name: string }[];
  onAddToOrg: (orgId: string) => void;
  addingProject?: boolean;
  hasGitRemote?: boolean;
}) {
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');

  return (
    <>
      {/* CTA Card */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="p-6 bg-[var(--nim-bg-secondary)] rounded-lg text-center">
          <div className="w-12 h-12 mx-auto mb-3 bg-[rgba(96,165,250,0.15)] rounded-xl flex items-center justify-center">
            <MaterialSymbol icon="group" size={24} className="text-[var(--nim-primary)]" />
          </div>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-4 leading-relaxed">
            This project is personal. Create a team to share tracker items, documents, and collaborate in real time.
          </p>
          <button
            onClick={onCreateTeam}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-5 py-2 bg-[var(--nim-primary)] border-none rounded-md text-white text-[13px] font-medium ${
              loading ? 'cursor-wait opacity-70' : 'cursor-pointer'
            }`}
          >
            <MaterialSymbol icon="add" size={14} />
            {loading ? 'Creating...' : 'Create Team'}
          </button>
        </div>
      </div>

      {/* Epic H3 P0/A: Add this workspace to an EXISTING org as a new project. */}
      {adminOrgs.length > 0 && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
            Add to an existing organization
          </h4>
          <p className="text-[12px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
            Already have an organization? Add this repo as a new project under it instead of
            creating a separate team. It joins as its own tracker space, sharing the org&apos;s members and encryption.
          </p>
          {!hasGitRemote ? (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
              <MaterialSymbol icon="link_off" size={14} className="text-[var(--nim-text-faint)] shrink-0" />
              <span className="text-[12px] text-[var(--nim-text-faint)]">
                This workspace has no git remote, so it can&apos;t be added as a project.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={selectedOrgId}
                onChange={(e) => setSelectedOrgId(e.target.value)}
                disabled={addingProject}
                className="flex-1 px-3 py-2 text-[12px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] cursor-pointer"
              >
                <option value="">Select an organization…</option>
                {adminOrgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>{o.name}</option>
                ))}
              </select>
              <button
                onClick={() => selectedOrgId && onAddToOrg(selectedOrgId)}
                disabled={!selectedOrgId || addingProject}
                className={`inline-flex items-center gap-1.5 px-4 py-2 border-none rounded-md text-white text-[12px] font-medium shrink-0 ${
                  !selectedOrgId || addingProject
                    ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)] cursor-not-allowed'
                    : 'bg-[var(--nim-primary)] cursor-pointer'
                }`}
              >
                <MaterialSymbol icon="add" size={14} />
                {addingProject ? 'Adding…' : 'Add Project'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Project Identity */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
          Project Identity
        </h4>
        <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
          Teams are linked to a git remote, so any member who opens a clone of the same repo is automatically connected.
        </p>
        <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
          <MaterialSymbol icon="commit" size={16} className="text-[var(--nim-text-faint)]" />
          <span className="text-[12px] font-mono text-[var(--nim-text-muted)]">
            {gitRemote || 'No git remote detected'}
          </span>
        </div>
      </div>

      {/* Encryption Footer */}
      <div className="provider-panel-section py-4">
        <EncryptionCard />
      </div>
    </>
  );
}

// ============================================================================
// Team Exists State
// ============================================================================

function TeamExistsState({ team, projects, workspacePath, adminOrgs, onInvite, onRemoveMember, onDeleteTeam, onLinkProject, onUnlinkProject, onProjectMoved, isAdmin, localGitRemote, fingerprints, myFingerprint, onVerifyMember, onRevokeTrust, onReshareKey, onUpdateRole }: {
  team: TeamData;
  projects: OrgProjectSummary[];
  workspacePath?: string;
  adminOrgs: { orgId: string; name: string }[];
  onInvite: (email: string) => void;
  onRemoveMember: (memberId: string) => void;
  onDeleteTeam: () => void;
  onLinkProject: () => void;
  onUnlinkProject: () => void;
  onProjectMoved: () => void;
  isAdmin: boolean;
  localGitRemote: string;
  fingerprints: Map<string, MemberFingerprint>;
  myFingerprint: string | null;
  onVerifyMember: (memberId: string, fingerprint: string) => void;
  onRevokeTrust: (memberId: string) => void;
  onReshareKey: (memberId: string) => void;
  onUpdateRole: (memberId: string, newRole: 'admin' | 'member') => void;
}) {
  const [inviteEmail, setInviteEmail] = useState('');
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  // Epic H3 P3: the project currently being moved (opens the move wizard).
  const [movingProject, setMovingProject] = useState<{ projectId: string; name: string } | null>(null);
  // Epic H3 P4: whether the merge-org wizard is open.
  const [merging, setMerging] = useState(false);
  // Epic H3 P5: target for the move wizard's "Update encryption" deep-link —
  // the Security & Encryption (H2 custody) section lives in this same panel.
  const encryptionSectionRef = useRef<HTMLDivElement>(null);
  const hasOtherAdminOrg = adminOrgs.some(o => o.orgId !== team.orgId);
  const canMoveProjects = isAdmin && hasOtherAdminOrg;

  const handleInvite = () => {
    if (inviteEmail.trim()) {
      onInvite(inviteEmail.trim());
      setInviteEmail('');
    }
  };

  const handleInviteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleInvite();
    }
  };

  return (
    <>
      {/* Team Header Card */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="flex items-center gap-3 p-3 bg-[var(--nim-bg-secondary)] rounded-lg">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#60a5fa] to-[#a78bfa] flex items-center justify-center shrink-0">
            <MaterialSymbol icon="group" size={18} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold text-[var(--nim-text)]">{team.name}</div>
            <div className="text-[11px] text-[var(--nim-text-faint)] font-mono overflow-hidden text-ellipsis whitespace-nowrap">
              {team.gitRemote || 'No project linked'}
            </div>
          </div>
        </div>
      </div>

      {/* Project Identity */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
          Project Identity
        </h4>
        <p className="text-[12px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
          Teams are linked to a git remote. Members who open a clone of the same repo are automatically connected.
        </p>
        {team.gitRemoteHash ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
              <MaterialSymbol icon="link" size={14} className="text-[var(--nim-success)] shrink-0" />
              <span className="text-[12px] font-mono text-[var(--nim-text-muted)] overflow-hidden text-ellipsis whitespace-nowrap">
                {localGitRemote || `${team.gitRemoteHash.slice(0, 12)}...`}
              </span>
            </div>
            {isAdmin && (
              <button
                onClick={onUnlinkProject}
                className="px-2.5 py-2 text-[11px] bg-transparent border border-[var(--nim-border)] rounded text-[var(--nim-text-faint)] cursor-pointer hover:bg-[var(--nim-bg-hover)] shrink-0"
              >
                Unlink
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
            <MaterialSymbol icon="link_off" size={14} className="text-[var(--nim-text-faint)] shrink-0" />
            <span className="flex-1 text-[12px] text-[var(--nim-text-faint)]">
              No project linked
            </span>
            {isAdmin && localGitRemote && (
              <button
                onClick={onLinkProject}
                className="px-2.5 py-1 text-[11px] bg-[var(--nim-primary)] border-none rounded text-white cursor-pointer"
              >
                Link This Project
              </button>
            )}
          </div>
        )}
      </div>

      {/* Projects Section (Epic H3 P0/A) -- every project in this org. An org
          can hold multiple projects, each its own tracker space; this lists them
          so it's clear which one this workspace is connected to. */}
      {(projects.length > 1 || canMoveProjects) && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)] flex items-center justify-between">
            <span>Projects</span>
            <span className="text-[11px] font-normal text-[var(--nim-text-faint)]">
              {projects.length} {projects.length === 1 ? 'project' : 'projects'}
            </span>
          </h4>
          {projects.length > 1 && (
            <p className="text-[12px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              This organization has multiple projects. Each is its own tracker space; members share the org&apos;s roster and encryption.
            </p>
          )}
          <div className="bg-[var(--nim-bg-secondary)] rounded-lg overflow-hidden">
            {projects.map((p) => {
              const isCurrent = !!team.teamProjectId && p.teamProjectId === team.teamProjectId;
              return (
                <div
                  key={p.projectId}
                  className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[var(--nim-bg)] last:border-b-0"
                >
                  <MaterialSymbol
                    icon="folder"
                    size={16}
                    className={isCurrent ? 'text-[var(--nim-primary)] shrink-0' : 'text-[var(--nim-text-faint)] shrink-0'}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[var(--nim-text)] flex items-center gap-1.5">
                      {p.name || p.slug || 'Untitled project'}
                      {isCurrent && (
                        <span className="text-[10px] text-[var(--nim-primary)] font-normal">(this workspace)</span>
                      )}
                    </div>
                    {p.gitRemoteHash && (
                      <div className="text-[11px] text-[var(--nim-text-faint)] font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                        {p.gitRemoteHash.slice(0, 12)}…
                      </div>
                    )}
                  </div>
                  {canMoveProjects && (
                    <button
                      className="text-[11px] px-2 py-1 rounded-md text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg)] hover:text-[var(--nim-text)] shrink-0 flex items-center gap-1"
                      onClick={() => setMovingProject({ projectId: p.projectId, name: p.name || p.slug || 'Untitled project' })}
                      data-testid={`move-project-trigger-${p.projectId}`}
                      title="Move this project to another organization"
                    >
                      <MaterialSymbol icon="drive_file_move" size={14} />
                      Move…
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {movingProject && (
        <MoveProjectWizard
          srcOrgId={team.orgId}
          project={movingProject}
          destCandidates={adminOrgs}
          onClose={() => setMovingProject(null)}
          onMoved={() => { onProjectMoved(); }}
          onUpdateEncryption={() => {
            // Reveal the H2 "update encryption" migration surface in this panel.
            encryptionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
      )}

      {/* Members Section */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)] flex items-center justify-between">
          <span>Members</span>
          <span className="text-[11px] font-normal text-[var(--nim-text-faint)]">
            {team.members.length} {team.members.length === 1 ? 'member' : 'members'}
          </span>
        </h4>

        <div className="bg-[var(--nim-bg-secondary)] rounded-lg overflow-hidden">
          {team.members.map((member) => {
            const fp = fingerprints.get(member.id);
            // Use fingerprint-based trust for non-pending members
            const displayTrustStatus: TrustStatus = member.trustStatus === 'pending'
              ? 'pending'
              : fp?.trustStatus === 'verified'
                ? 'verified'
                : fp?.trustStatus === 'fingerprint-changed'
                  ? 'fingerprint-changed'
                  : 'unverified';
            const isExpanded = expandedMemberId === member.id;
            const canExpand = member.trustStatus !== 'pending' && !member.isYou;

            return (
              <div key={member.id}>
                <div
                  className={`flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[var(--nim-bg)] last:border-b-0 ${
                    member.trustStatus === 'pending' ? 'opacity-70' : ''
                  }`}
                >
                  <MemberAvatar
                    name={member.name}
                    email={member.email}
                    color={member.avatarColor}
                    isPending={member.trustStatus === 'pending'}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[var(--nim-text)] flex items-center gap-1.5">
                      {member.trustStatus === 'pending' ? member.email : (member.name || member.email)}
                      {member.isYou && (
                        <span className="text-[10px] text-[var(--nim-text-faint)] font-normal">(you)</span>
                      )}
                    </div>
                    {member.trustStatus === 'pending' ? (
                      <div className="text-[11px] text-[var(--nim-text-faint)]">
                        Invited {member.invitedAt || 'recently'}
                      </div>
                    ) : (
                      <div className="text-[11px] text-[var(--nim-text-faint)]">{member.email}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {member.trustStatus === 'pending' ? (
                      <PendingBadge />
                    ) : (
                      <>
                        <RoleBadge
                          role={member.role}
                          editable={isAdmin && !member.isYou}
                          onChange={(newRole) => onUpdateRole(member.id, newRole)}
                        />
                        <TrustStatusIcon
                          status={displayTrustStatus}
                          onClick={canExpand ? () => setExpandedMemberId(isExpanded ? null : member.id) : undefined}
                        />
                      </>
                    )}
                  </div>
                  {!member.isYou && isAdmin && (
                    <div className="shrink-0">
                      <button
                        onClick={() => onRemoveMember(member.id)}
                        className={`px-2.5 py-1 text-[11px] bg-transparent border rounded cursor-pointer ${
                          member.trustStatus === 'pending'
                            ? 'border-[var(--nim-border)] text-[var(--nim-text-disabled)] hover:bg-[var(--nim-bg-hover)]'
                            : 'border-[rgba(239,68,68,0.4)] text-[var(--nim-error)] hover:bg-[rgba(239,68,68,0.1)]'
                        }`}
                      >
                        {member.trustStatus === 'pending' ? 'Revoke' : 'Remove'}
                      </button>
                    </div>
                  )}
                </div>
                {isExpanded && canExpand && (
                  <MemberFingerprintDetail
                    member={member}
                    fingerprint={fp || null}
                    onVerify={() => {
                      if (fp) onVerifyMember(member.id, fp.fingerprint);
                    }}
                    onRevoke={() => onRevokeTrust(member.id)}
                    onReshareKey={() => onReshareKey(member.id)}
                    isAdmin={isAdmin}
                  />
                )}
              </div>
            );
          })}

          {/* Invite Input Row (admin only) */}
          {isAdmin && (
            <div className="flex items-center gap-2 px-3.5 py-2 border-t border-[var(--nim-bg)] bg-[rgba(255,255,255,0.02)]">
              <MaterialSymbol icon="add" size={14} className="text-[var(--nim-text-disabled)] shrink-0" />
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={handleInviteKeyDown}
                placeholder="Invite by email address..."
                className="flex-1 py-1.5 px-2.5 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[12px] outline-none placeholder:text-[var(--nim-text-disabled)]"
              />
              <button
                onClick={handleInvite}
                disabled={!inviteEmail.trim()}
                className={`px-3 py-1.5 bg-[var(--nim-primary)] border-none rounded text-white text-[12px] font-medium whitespace-nowrap ${
                  inviteEmail.trim()
                    ? 'cursor-pointer opacity-100'
                    : 'cursor-not-allowed opacity-50'
                }`}
              >
                Invite
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Your Fingerprint */}
      {myFingerprint && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
            Your Fingerprint
          </h4>
          <p className="text-[12px] text-[var(--nim-text-muted)] mb-2 leading-relaxed">
            Share this fingerprint with your team members so they can verify your identity.
          </p>
          <div className="px-2.5 py-2 bg-[var(--nim-bg-secondary)] rounded font-mono text-[11px] text-[var(--nim-text-muted)] leading-relaxed break-all select-text">
            {myFingerprint.split(':').slice(0, 16).join(':')}
          </div>
        </div>
      )}

      {/* Security & encryption (Epic H2: key custody + migration) */}
      <div ref={encryptionSectionRef} className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0" data-testid="team-panel-encryption-section">
        <SecurityEncryptionSection orgId={team.orgId} workspacePath={workspacePath} isAdmin={isAdmin} />
      </div>

      {/* Danger Zone */}
      {isAdmin && (
        <div className="provider-panel-section py-4">
          <h4 className="provider-panel-section-title text-[13px] font-semibold mb-2 text-[var(--nim-text-muted)]">
            Danger Zone
          </h4>
          <div className="flex flex-wrap gap-2">
            {hasOtherAdminOrg && (
              <button
                onClick={() => setMerging(true)}
                className="px-3.5 py-1.5 text-[12px] bg-transparent border border-[rgba(239,68,68,0.4)] rounded-md text-[var(--nim-error)] cursor-pointer hover:bg-[rgba(239,68,68,0.1)] flex items-center gap-1"
                data-testid="merge-org-trigger"
                title="Move all of this org's projects into another org you administer"
              >
                <MaterialSymbol icon="merge" size={14} />
                Merge into another org…
              </button>
            )}
            <button
              onClick={onDeleteTeam}
              className="px-3.5 py-1.5 text-[12px] bg-transparent border border-[rgba(239,68,68,0.4)] rounded-md text-[var(--nim-error)] cursor-pointer hover:bg-[rgba(239,68,68,0.1)]"
            >
              Delete Team
            </button>
          </div>
        </div>
      )}

      {merging && (
        <MergeOrgWizard
          drainedOrg={{ orgId: team.orgId, name: team.name }}
          survivorCandidates={adminOrgs}
          projectCount={projects.length}
          memberCount={team.members.length}
          onClose={() => setMerging(false)}
          onMerged={() => { setMerging(false); onProjectMoved(); }}
        />
      )}
    </>
  );
}

// ============================================================================
// Invite Pending State
// ============================================================================

function InvitePendingState({ invite, onAccept, loading, gitRemote }: {
  invite: PendingInvite;
  onAccept: () => void;
  loading?: boolean;
  gitRemote: string;
}) {
  return (
    <>
      {/* Invite Card */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="p-6 bg-[var(--nim-bg-secondary)] rounded-lg text-center">
          <div className="w-12 h-12 mx-auto mb-3 bg-[rgba(251,191,36,0.15)] rounded-xl flex items-center justify-center">
            <MaterialSymbol icon="mail" size={24} className="text-[var(--nim-warning)]" />
          </div>
          <div className="text-[15px] font-semibold text-[var(--nim-text)] mb-1">
            {invite.name}
          </div>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-4 leading-relaxed">
            You have been invited to join this team. Accept to collaborate on shared, encrypted tracker items and documents.
          </p>
          <button
            onClick={onAccept}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-5 py-2 bg-[var(--nim-primary)] border-none rounded-md text-white text-[13px] font-medium ${
              loading ? 'cursor-wait opacity-70' : 'cursor-pointer'
            }`}
          >
            <MaterialSymbol icon="group_add" size={14} />
            {loading ? 'Joining...' : 'Join Team'}
          </button>
        </div>
      </div>

      {/* Project Identity */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
          Project Identity
        </h4>
        <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
          Teams are linked to a git remote, so any member who opens a clone of the same repo is automatically connected.
        </p>
        <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--nim-bg-secondary)] rounded-md">
          <MaterialSymbol icon="commit" size={16} className="text-[var(--nim-text-faint)]" />
          <span className="text-[12px] font-mono text-[var(--nim-text-muted)]">
            {gitRemote || 'No git remote detected'}
          </span>
        </div>
      </div>

      {/* Encryption Footer */}
      <div className="provider-panel-section py-4">
        <EncryptionCard />
      </div>
    </>
  );
}

// ============================================================================
// TeamPanel
// ============================================================================

export function TeamPanel({ workspacePath, orgId: orgScopeId }: TeamPanelProps) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);
  const [gitRemote, setGitRemote] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [fingerprints, setFingerprints] = useState<Map<string, MemberFingerprint>>(new Map());
  const [myFingerprint, setMyFingerprint] = useState<string | null>(null);
  // Epic H3 P0/A: projects in the active org, and the orgs the user can add
  // this workspace to as a NEW project (orgs where they are owner/admin).
  const [projects, setProjects] = useState<OrgProjectSummary[]>([]);
  const [adminOrgs, setAdminOrgs] = useState<{ orgId: string; name: string }[]>([]);
  const [addingProject, setAddingProject] = useState(false);
  const [stytchAuth, setStytchAuth] = useState<{
    isAuthenticated: boolean;
    user: { user_id: string; emails: Array<{ email: string }>; name?: { first_name?: string; last_name?: string } } | null;
  }>({ isAuthenticated: false, user: null });

  const createTeamDialog = useDialogState<CreateTeamData>(DIALOG_IDS.CREATE_TEAM);

  // Load Stytch auth state on mount
  useEffect(() => {
    if (!(window as any).electronAPI?.stytch) return;

    (window as any).electronAPI.stytch.getAuthState().then((state: any) => {
      setStytchAuth({ isAuthenticated: state.isAuthenticated, user: state.user });
      // Validate session is alive server-side; if dead, signOut broadcasts
      // auth state change and the listener below updates the UI
      if (state.isAuthenticated) {
        (window as any).electronAPI.stytch.refreshSession();
      }
    });

    // Subscribe to auth state changes
    (window as any).electronAPI.stytch.subscribeAuthState();
    const unsubscribe = (window as any).electronAPI.stytch.onAuthStateChange((state: any) => {
      setStytchAuth({ isAuthenticated: state.isAuthenticated, user: state.user });
    });

    return unsubscribe;
  }, []);

  // Load git remote on mount
  useEffect(() => {
    if (!workspacePath) return;
    (window as any).electronAPI.team.getGitRemote(workspacePath).then((result: any) => {
      if (result.success && result.remote) {
        setGitRemote(result.remote);
      }
    });
  }, [workspacePath]);

  // Epic H3 P0/A: load the orgs the user owns/admins, so a personal workspace can
  // be added to an existing org as a new project (vs only "create a new team").
  const loadAdminOrgs = useCallback(async () => {
    try {
      const result = await (window as any).electronAPI.team.list();
      if (result.success && Array.isArray(result.teams)) {
        const orgs = result.teams
          .filter((t: any) =>
            (!t.membershipType || t.membershipType === 'active_member') &&
            (t.role === 'admin' || t.role === 'owner'))
          .map((t: any) => ({ orgId: t.orgId, name: t.name }));
        setAdminOrgs(orgs);
      }
    } catch {
      // Non-fatal -- the "add to existing org" option just won't appear.
    }
  }, []);

  useEffect(() => {
    loadAdminOrgs();
  }, [loadAdminOrgs]);

  // Load team data for an orgId: fetch members, envelopes, and fingerprints
  const loadTeamDetails = useCallback(async (orgId: string, teamName: string, teamGitRemoteHash: string | null, teamProjectId?: string | null) => {
    const membersResult = await (window as any).electronAPI.team.listMembers(orgId);
    if (!membersResult.success) return;

    const currentUserId = membersResult.callerMemberId || '';

    // Fetch key envelopes to determine trust status
    let envelopeUserIds = new Set<string>();
    try {
      const envelopesResult = await (window as any).electronAPI.team.listKeyEnvelopes(orgId);
      if (envelopesResult.success && envelopesResult.envelopes) {
        envelopeUserIds = new Set(envelopesResult.envelopes.map((e: any) => e.targetUserId));
      }
    } catch {
      // Envelope listing may fail if not admin -- that's OK
    }

    const members: TeamMember[] = (membersResult.members || []).map((m: any, i: number) => ({
      id: m.memberId,
      name: m.name || '',
      email: m.email,
      role: m.role as 'admin' | 'member',
      trustStatus: m.status === 'pending'
        ? 'pending' as const
        : envelopeUserIds.has(m.memberId)
          ? 'verified' as const
          : 'unverified' as const,
      avatarColor: getAvatarColor(i),
      isYou: m.memberId === currentUserId,
      invitedAt: m.status === 'pending' ? 'recently' : undefined,
    }));

    setTeam({
      orgId,
      name: teamName,
      gitRemote: gitRemote || teamGitRemoteHash || '',
      gitRemoteHash: teamGitRemoteHash,
      teamProjectId: teamProjectId ?? null,
      members,
      callerRole: membersResult.callerRole || 'member',
    });

    // Load fingerprints for non-pending members (fire-and-forget, doesn't block UI)
    loadFingerprints(orgId, members, currentUserId);

    // Epic H3 P0/A: list every project in this org (fire-and-forget).
    (window as any).electronAPI.team.listProjects(orgId).then((res: any) => {
      if (res?.success && Array.isArray(res.projects)) {
        setProjects(res.projects);
      } else {
        setProjects([]);
      }
    }).catch(() => setProjects([]));
  }, [gitRemote]);

  // Load team data -- find team matching this workspace's git remote, or fall back to listing all teams
  const loadTeamData = useCallback(async () => {
    // Epic H3 P3: Organization scope -- key off the selected org id, not the
    // workspace. Resolve that specific team from the team list and load it.
    if (orgScopeId) {
      try {
        const listResult = await (window as any).electronAPI.team.list();
        const match = (listResult?.teams || []).find((t: any) => t.orgId === orgScopeId);
        if (match) {
          setPendingInvite(null);
          await loadTeamDetails(match.orgId, match.name, match.gitRemoteHash, match.teamProjectId);
        } else {
          setTeam(null);
        }
      } catch (err) {
        console.error('[TeamPanel] org-scope loadTeamData error:', err);
        setTeam(null);
      } finally {
        setInitialLoading(false);
      }
      return;
    }

    if (!workspacePath) {
      setInitialLoading(false);
      return;
    }

    try {
      // Find team by workspace git remote (per-project lookup).
      // This returns active teams OR pending invites that match this workspace.
      const findResult = await (window as any).electronAPI.team.findForWorkspace(workspacePath);
      console.log('[TeamPanel] findForWorkspace result:', findResult);
      if (findResult.success && findResult.team) {
        const matchedTeam = findResult.team;
        const isPending = matchedTeam.membershipType && matchedTeam.membershipType !== 'active_member';

        if (isPending) {
          // Matched a pending invite for this workspace -- show join prompt
          setPendingInvite({
            orgId: matchedTeam.orgId,
            name: matchedTeam.name,
            membershipType: matchedTeam.membershipType,
          });
          setTeam(null);
          return;
        }

        // Active team match
        setPendingInvite(null);
        await loadTeamDetails(matchedTeam.orgId, matchedTeam.name, matchedTeam.gitRemoteHash, matchedTeam.teamProjectId);
        return;
      }

      // No git remote match -- check if user has any pending invites at all.
      // Only show pending invites (not unrelated active teams) since
      // showing an unrelated team is confusing.
      const listResult = await (window as any).electronAPI.team.list();
      console.log('[TeamPanel] team.list result:', listResult);
      if (listResult.success && listResult.teams && listResult.teams.length > 0) {
        const pendingTeams = listResult.teams.filter((t: any) => t.membershipType && t.membershipType !== 'active_member');

        // Show a pending invite if one exists (user may need to join before project identity is linked)
        if (pendingTeams.length > 0) {
          const invite = pendingTeams[0];
          setPendingInvite({
            orgId: invite.orgId,
            name: invite.name,
            membershipType: invite.membershipType,
          });
          setTeam(null);
          return;
        }
      }

      console.log('[TeamPanel] No matching team for this workspace, showing create UI');
      setPendingInvite(null);
      setTeam(null);
    } catch (err) {
      console.error('[TeamPanel] loadTeamData error:', err);
      setPendingInvite(null);
      setTeam(null);
    } finally {
      setInitialLoading(false);
    }
  }, [workspacePath, orgScopeId, loadTeamDetails]);

  useEffect(() => {
    loadTeamData();
  }, [loadTeamData]);

  // Load fingerprints for non-pending members (async, doesn't block team load)
  const loadFingerprints = useCallback(async (orgId: string, members: TeamMember[], currentUserId: string) => {
    const fpMap = new Map<string, MemberFingerprint>();

    // Fetch fingerprints for each non-pending, non-self member
    const fetchPromises = members
      .filter(m => m.trustStatus !== 'pending' && m.id !== currentUserId)
      .map(async (m) => {
        try {
          const result = await (window as any).electronAPI.team.getMemberFingerprint(orgId, m.id);
          if (result.success) {
            fpMap.set(m.id, {
              fingerprint: result.fingerprint,
              trustStatus: result.trustStatus,
            });
          }
        } catch {
          // Fingerprint fetch may fail if member hasn't uploaded key yet
        }
      });

    await Promise.all(fetchPromises);
    setFingerprints(fpMap);

    // Fetch own fingerprint
    try {
      const myResult = await (window as any).electronAPI.team.getMyFingerprint(orgId);
      if (myResult.success) {
        setMyFingerprint(myResult.fingerprint);
      }
    } catch {
      // Ignore -- own fingerprint is optional display
    }
  }, []);

  const handleVerifyMember = async (memberId: string, fingerprint: string) => {
    if (!team) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.verifyMember(team.orgId, memberId, fingerprint);
      if (result.success) {
        // Update local fingerprint state
        setFingerprints(prev => {
          const next = new Map(prev);
          const existing = next.get(memberId);
          if (existing) {
            next.set(memberId, { ...existing, trustStatus: 'verified' });
          }
          return next;
        });
      } else {
        setError(result.error || 'Failed to verify member');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify member');
    }
  };

  const handleRevokeTrust = async (memberId: string) => {
    if (!team) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.revokeMemberTrust(team.orgId, memberId);
      if (result.success) {
        setFingerprints(prev => {
          const next = new Map(prev);
          const existing = next.get(memberId);
          if (existing) {
            next.set(memberId, { ...existing, trustStatus: 'unverified' });
          }
          return next;
        });
      } else {
        setError(result.error || 'Failed to revoke trust');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke trust');
    }
  };

  const handleCreateTeam = async () => {
    // Load accounts to show picker if multiple are signed in
    let accounts: Array<{ personalOrgId: string; email: string | null; isPrimary: boolean }> = [];
    try {
      accounts = await (window as any).electronAPI.stytch.getAccounts() || [];
    } catch {
      // Fall back to empty -- dialog will work without account picker
    }

    createTeamDialog.open({
      gitRemote: gitRemote || 'No git remote detected',
      suggestedName: workspacePath?.split('/').pop() || 'my-project',
      accounts,
      onCreateTeam: async (name: string, accountOrgId?: string) => {
        setLoading(true);
        setError(null);
        try {
          const result = await (window as any).electronAPI.team.create(name, workspacePath, accountOrgId);
          if (result.success) {
            await loadTeamData();
          } else {
            setError(result.error || 'Failed to create team');
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create team');
        } finally {
          setLoading(false);
        }
      },
    });
  };

  // Epic H3 P0/A: attach the current workspace to an EXISTING org as a new
  // project (distinct from createTeam, which mints a brand-new org). After the
  // add, findForWorkspace resolves this workspace to the new project's room, so
  // reloading flips the panel into the team-exists state.
  const handleAddToOrg = async (orgId: string) => {
    if (!workspacePath) return;
    setAddingProject(true);
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.addProject(orgId, workspacePath);
      if (result.success) {
        await loadTeamData();
        await loadAdminOrgs();
      } else {
        setError(result.error || 'Failed to add project to organization');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add project to organization');
    } finally {
      setAddingProject(false);
    }
  };

  const handleInvite = async (email: string) => {
    if (!team) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.invite(team.orgId, email);
      if (result.success) {
        // Optimistic update -- add pending member
        setTeam({
          ...team,
          members: [
            ...team.members,
            {
              id: `invite-${Date.now()}`,
              name: '',
              email,
              role: 'member',
              trustStatus: 'pending',
              avatarColor: getAvatarColor(team.members.length),
              invitedAt: 'just now',
            },
          ],
        });
        // Refresh from server after a short delay
        setTimeout(() => loadTeamData(), 2000);
      } else {
        setError(result.error || 'Failed to send invite');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invite');
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!team) return;
    const member = team.members.find((m) => m.id === memberId);
    const label = member?.email || member?.name || 'this member';
    const isPending = member?.trustStatus === 'pending';
    const confirmed = window.confirm(
      isPending
        ? `Revoke the pending invite for ${label}?`
        : `Remove ${label} from "${team.name}"? They will lose access to this team's shared trackers and documents. This cannot be undone (you'd need to re-invite them).`
    );
    if (!confirmed) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.removeMember(team.orgId, memberId);
      if (result.success) {
        // Optimistic update
        setTeam({
          ...team,
          members: team.members.filter((m) => m.id !== memberId),
        });
      } else {
        setError(result.error || 'Failed to remove member');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleAcceptInvite = async () => {
    if (!pendingInvite) return;
    setLoading(true);
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.acceptInvite(pendingInvite.orgId);
      if (result.success) {
        setPendingInvite(null);
        await loadTeamData();
      } else {
        setError(result.error || 'Failed to join team');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join team');
    } finally {
      setLoading(false);
    }
  };

  const handleLinkProject = async () => {
    if (!team || !workspacePath) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.setProjectIdentity(team.orgId, workspacePath);
      if (result.success) {
        await loadTeamData();
      } else {
        setError(result.error || 'Failed to link project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link project');
    }
  };

  const handleUnlinkProject = async () => {
    if (!team) return;
    const confirmed = window.confirm(
      `Stop syncing this project with "${team.name}"? Its trackers and documents will no longer sync to the team. You can re-link it later.`
    );
    if (!confirmed) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.clearProjectIdentity(team.orgId);
      if (result.success) {
        await loadTeamData();
      } else {
        setError(result.error || 'Failed to unlink project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink project');
    }
  };

  const handleReshareKey = async (memberId: string) => {
    if (!team) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.reshareKey(team.orgId, memberId);
      if (result.success) {
        // Reload team data to refresh envelope state
        await loadTeamData();
      } else {
        setError(result.error || 'Failed to re-share key');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to re-share key');
    }
  };

  const handleUpdateRole = async (memberId: string, newRole: 'admin' | 'member') => {
    if (!team) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.updateRole(team.orgId, memberId, newRole);
      if (result.success) {
        // Optimistic update
        setTeam({
          ...team,
          members: team.members.map((m) =>
            m.id === memberId ? { ...m, role: newRole } : m
          ),
        });
      } else {
        setError(result.error || 'Failed to update role');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const handleDeleteTeam = async () => {
    if (!team) return;
    const confirmed = window.confirm(
      `Permanently delete team "${team.name}"? This will remove all members, shared documents, and encryption keys. This action cannot be undone.`
    );
    if (!confirmed) return;
    setError(null);
    try {
      const result = await (window as any).electronAPI.team.deleteTeam(team.orgId);
      if (result.success) {
        setTeam(null);
      } else {
        setError(result.error || 'Failed to delete team');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete team');
    }
  };

  if (initialLoading) {
    return (
      <div className="provider-panel flex flex-col items-center justify-center py-12">
        <span className="text-[13px] text-[var(--nim-text-muted)]">Loading team data...</span>
      </div>
    );
  }

  // Not authenticated - show sign-in prompt
  if (!stytchAuth.isAuthenticated) {
    return (
      <div className="provider-panel flex flex-col">
        <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)] flex items-center gap-2">
            Team
            <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
          </h3>
          <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
            Create a team to collaborate on shared, encrypted tracker items and documents.
          </p>
          <TeamPricingNotice />
        </div>
        <div className="p-6 bg-[var(--nim-bg-secondary)] rounded-lg text-center">
          <div className="w-12 h-12 mx-auto mb-3 bg-[rgba(96,165,250,0.15)] rounded-xl flex items-center justify-center">
            <MaterialSymbol icon="account_circle" size={24} className="text-[var(--nim-primary)]" />
          </div>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-2 leading-relaxed">
            Sign in to create or join a team.
          </p>
          <p className="text-[12px] text-[var(--nim-text-faint)] m-0">
            Go to <strong className="text-[var(--nim-text-muted)]">Account & Sync</strong> in the sidebar to sign in.
          </p>
        </div>
      </div>
    );
  }

  const userEmail = stytchAuth.user?.emails?.[0]?.email;
  const userName = stytchAuth.user?.name?.first_name
    ? `${stytchAuth.user.name.first_name} ${stytchAuth.user.name.last_name || ''}`.trim()
    : null;

  return (
    <div className="provider-panel flex flex-col">
      {/* Header */}
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)] flex items-center gap-2">
          Team
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          Create a team to collaborate on shared, encrypted tracker items and documents.
        </p>
        <TeamPricingNotice />
        {userEmail && team && (
          <div className="flex items-center gap-1.5 mt-2 text-[12px] text-[var(--nim-text-faint)]">
            <MaterialSymbol icon="person" size={13} />
            <span>Signed in as <span className="text-[var(--nim-text-muted)]">{userName || userEmail}</span></span>
          </div>
        )}
      </div>

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {team ? (
        <TeamExistsState
          team={team}
          projects={projects}
          workspacePath={workspacePath}
          adminOrgs={adminOrgs}
          onInvite={handleInvite}
          onRemoveMember={handleRemoveMember}
          onDeleteTeam={handleDeleteTeam}
          onLinkProject={handleLinkProject}
          onUnlinkProject={handleUnlinkProject}
          onProjectMoved={() => {
            // The moved project left this org; refresh the registry + candidate orgs.
            loadAdminOrgs();
            loadTeamDetails(team.orgId, team.name, team.gitRemoteHash, team.teamProjectId);
          }}
          isAdmin={team.callerRole === 'admin' || team.callerRole === 'owner'}
          localGitRemote={gitRemote}
          fingerprints={fingerprints}
          myFingerprint={myFingerprint}
          onVerifyMember={handleVerifyMember}
          onRevokeTrust={handleRevokeTrust}
          onReshareKey={handleReshareKey}
          onUpdateRole={handleUpdateRole}
        />
      ) : pendingInvite ? (
        <InvitePendingState
          invite={pendingInvite}
          onAccept={handleAcceptInvite}
          loading={loading}
          gitRemote={gitRemote}
        />
      ) : (
        <NoTeamState
          gitRemote={gitRemote}
          onCreateTeam={handleCreateTeam}
          loading={loading}
          adminOrgs={adminOrgs}
          onAddToOrg={handleAddToOrg}
          addingProject={addingProject}
          hasGitRemote={!!gitRemote}
        />
      )}
    </div>
  );
}
