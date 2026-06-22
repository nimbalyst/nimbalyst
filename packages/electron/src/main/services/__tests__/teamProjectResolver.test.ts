/**
 * Epic H3 P0/A: a workspace's git-remote hash must resolve to the right
 * (org, teamProjectId) even when the org holds MULTIPLE projects. These assert
 * the secondary-project routing that makes "a second project" usable -- they go
 * red without the registry-aware resolver.
 */

import { describe, it, expect } from 'vitest';
import { resolveTeamForRemoteHash, type ResolverTeam } from '../teamProjectResolver';

const primaryTeam: ResolverTeam = {
  orgId: 'org-A',
  name: 'Acme',
  gitRemoteHash: 'hash-primary',
  teamProjectId: 'tp-primary',
  membershipType: 'active_member',
  projects: [
    { projectId: 'p1', teamProjectId: 'tp-primary', gitRemoteHash: 'hash-primary', slug: 'main', name: 'Main' },
    { projectId: 'p2', teamProjectId: 'tp-second', gitRemoteHash: 'hash-second', slug: 'second', name: 'Second Project' },
  ],
};

describe('resolveTeamForRemoteHash', () => {
  it('matches the primary project by the team gitRemoteHash (fast path)', () => {
    const match = resolveTeamForRemoteHash([primaryTeam], 'hash-primary');
    expect(match).not.toBeNull();
    expect(match!.orgId).toBe('org-A');
    expect(match!.teamProjectId).toBe('tp-primary');
  });

  it('resolves a SECONDARY project to its own tracker room', () => {
    const match = resolveTeamForRemoteHash([primaryTeam], 'hash-second');
    expect(match).not.toBeNull();
    expect(match!.orgId).toBe('org-A');
    // The result is pinned to the secondary project's routing key, not the primary.
    expect(match!.teamProjectId).toBe('tp-second');
    // ...and its remote hash + display name reflect the secondary project.
    expect(match!.gitRemoteHash).toBe('hash-second');
    expect(match!.name).toBe('Second Project');
  });

  it('returns null when no project in any org owns the remote', () => {
    expect(resolveTeamForRemoteHash([primaryTeam], 'hash-unknown')).toBeNull();
  });

  it('never resolves to a team where the user is not an active member', () => {
    const invited: ResolverTeam = {
      orgId: 'org-B',
      name: 'Invited Org',
      gitRemoteHash: 'hash-invited',
      teamProjectId: 'tp-invited',
      membershipType: 'invited_member',
      projects: [
        { projectId: 'pb1', teamProjectId: 'tp-invited', gitRemoteHash: 'hash-invited', slug: 'main', name: 'Main' },
        { projectId: 'pb2', teamProjectId: 'tp-invited-2', gitRemoteHash: 'hash-invited-2', slug: 'two', name: 'Two' },
      ],
    };
    // Neither the primary nor a secondary project of an invited org should match.
    expect(resolveTeamForRemoteHash([invited], 'hash-invited')).toBeNull();
    expect(resolveTeamForRemoteHash([invited], 'hash-invited-2')).toBeNull();
  });

  it('treats a team with no projects registry as primary-only', () => {
    const legacy: ResolverTeam = {
      orgId: 'org-legacy',
      name: 'Legacy',
      gitRemoteHash: 'hash-legacy',
      teamProjectId: 'tp-legacy',
      membershipType: 'active_member',
      // projects omitted (worker version predating the registry)
    };
    expect(resolveTeamForRemoteHash([legacy], 'hash-legacy')!.teamProjectId).toBe('tp-legacy');
    expect(resolveTeamForRemoteHash([legacy], 'hash-other')).toBeNull();
  });

  it('picks the matching secondary project across multiple orgs', () => {
    const orgC: ResolverTeam = {
      orgId: 'org-C', name: 'C', gitRemoteHash: 'c-primary', teamProjectId: 'c-tp', membershipType: 'active_member',
      projects: [
        { projectId: 'c1', teamProjectId: 'c-tp', gitRemoteHash: 'c-primary', slug: 'main', name: 'C Main' },
        { projectId: 'c2', teamProjectId: 'c-tp2', gitRemoteHash: 'c-second', slug: 's', name: 'C Second' },
      ],
    };
    const match = resolveTeamForRemoteHash([primaryTeam, orgC], 'c-second');
    expect(match!.orgId).toBe('org-C');
    expect(match!.teamProjectId).toBe('c-tp2');
  });
});
