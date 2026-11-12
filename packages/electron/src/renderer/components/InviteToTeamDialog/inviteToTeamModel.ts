/**
 * The decisions behind the invite dialog, kept out of the component.
 *
 * Inviting used to be one email field and a button, which is why a new
 * teammate could accept and find an empty organization: nothing in the flow
 * asked what they should be able to see, and nothing published any content for
 * them to open.
 *
 * The two halves of "what they get" are genuinely different mechanisms, and
 * conflating them is the mistake this module exists to prevent:
 *
 * - **Projects are access.** The server already grants every joiner an editor
 *   role on the org's *primary* project, so only the projects beyond it are a
 *   real choice. Grants are keyed by `teamProjectId`, which is what the
 *   server's `project_access` rows hold.
 * - **Folders are content.** There is no folder-level ACL anywhere in the
 *   system; a folder selection publishes local files into the team's shared
 *   tree so there is something to open. It grants nothing on its own.
 */

/** An organization project as the invite dialog needs to see it. */
export interface InviteProjectOption {
  teamProjectId: string;
  name: string | null;
  /** The org's primary project, which every member is granted automatically. */
  isPrimary: boolean;
}

export interface InviteProjectGrant {
  teamProjectId: string;
  projectRole: 'project-admin' | 'project-editor' | 'project-commenter' | 'project-viewer';
}

export type InviteRole = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

/**
 * Deliberately permissive: this guards against typos and stray separators, not
 * against invalid addresses. The invitation provider is the authority on
 * deliverability and rejecting a legal-but-unusual address here would be a
 * bug the user cannot work around.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Split pasted text into addresses. Commas, semicolons, and whitespace all separate. */
export function parseInviteEmails(raw: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,;]+/).filter(Boolean)) {
    const candidate = token.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(candidate)) {
      invalid.push(token.trim());
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    emails.push(candidate);
  }
  return { emails, invalid };
}

/**
 * The project role a given org role should carry on an explicitly granted
 * project. Mirrors the server's `defaultProjectRoleForOrgRole` so the dialog
 * never asks for more than the org role would have produced on its own —
 * requesting `project-admin` for someone invited as a viewer would be an
 * escalation the server is right to refuse.
 */
export function projectRoleForOrgRole(role: InviteRole): InviteProjectGrant['projectRole'] {
  if (role === 'owner' || role === 'admin') return 'project-admin';
  if (role === 'member') return 'project-editor';
  return 'project-viewer';
}

/**
 * The grants to send. The primary project is filtered out even when selected:
 * the server seeds it regardless, and sending it would be a redundant write
 * that can only fail.
 */
export function buildProjectGrants(
  projects: readonly InviteProjectOption[],
  selectedTeamProjectIds: ReadonlySet<string>,
  role: InviteRole,
): InviteProjectGrant[] {
  return projects
    .filter(project => !project.isPrimary && selectedTeamProjectIds.has(project.teamProjectId))
    .map(project => ({
      teamProjectId: project.teamProjectId,
      projectRole: projectRoleForOrgRole(role),
    }));
}

export interface InvitePlanSummary {
  people: number;
  extraProjects: number;
  folders: number;
  /**
   * Whether the team already has shared content. "Nothing shared yet" is a
   * claim about the team, not about this form, and it is false the moment the
   * team has documents of its own.
   */
  teamHasSharedContent?: boolean;
}

/**
 * The sentence above the send button.
 *
 * It names the empty case explicitly rather than staying silent, because
 * sending an invitation that shares nothing is exactly how a teammate ends up
 * in an empty organization — the failure this whole dialog exists to prevent.
 */
export function summarizeInvitePlan(plan: InvitePlanSummary): string {
  if (plan.people === 0) return 'Add an email address to invite someone.';
  const parts = [`${plan.people} ${plan.people === 1 ? 'person' : 'people'}`];
  if (plan.extraProjects > 0) {
    parts.push(`${plan.extraProjects} extra ${plan.extraProjects === 1 ? 'project' : 'projects'}`);
  }
  if (plan.folders > 0) {
    parts.push(`${plan.folders} ${plan.folders === 1 ? 'folder' : 'folders'} published`);
  }
  if (parts.length === 1) {
    parts.push(plan.teamHasSharedContent
      ? 'the team already has shared content'
      : 'nothing shared yet');
  }
  return parts.join(' · ');
}

/** The primary action's label, so the outcome is legible before the click. */
export function inviteActionLabel(plan: InvitePlanSummary): string {
  if (plan.extraProjects === 0 && plan.folders === 0) return 'Send invitation only';
  return 'Send invitations and share';
}
