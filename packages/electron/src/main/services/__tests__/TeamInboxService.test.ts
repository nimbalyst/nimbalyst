import { asTeamJwt } from '@nimbalyst/runtime';
import type {
  TeamInboxOrgClientLike,
  TeamInboxOrgDescriptor,
  TeamInboxOrgEvent,
} from '@nimbalyst/runtime/sync';
import { describe, expect, it, vi } from 'vitest';

import { TeamInboxService } from '../TeamInboxService';

class FakeOrgClient implements TeamInboxOrgClientLike {
  readonly connect = vi.fn(async () => {});
  readonly markRead = vi.fn(async () => {});
  readonly dismiss = vi.fn(async () => {});
  readonly destroy = vi.fn();
  private listener: ((event: TeamInboxOrgEvent) => void) | null = null;

  constructor(readonly org: TeamInboxOrgDescriptor) {}

  subscribe(listener: (event: TeamInboxOrgEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
}

describe('TeamInboxService JWT selection', () => {
  it('resolves the inbox member id and connection exclusively from the org-scoped team JWT', async () => {
    const getTeamJwt = vi.fn(async () => asTeamJwt('team-jwt'));
    const clients: FakeOrgClient[] = [];
    const service = new TeamInboxService({
      listOrganizations: vi.fn(async () => [{
        orgId: 'org-a',
        name: 'Acme',
        gitRemoteHash: null,
        createdAt: '2026-07-26T00:00:00.000Z',
        role: 'member',
        membershipType: 'active_member',
        boundPersonalOrgId: 'personal-account-a',
      }]),
      getTeamJwt,
      getServerUrl: () => 'https://sync.example.test',
      getTeamMemberId: (jwt) =>
        jwt === 'team-jwt' ? 'team-member-a' : null,
      createOrgClient: (org) => {
        const client = new FakeOrgClient(org);
        clients.push(client);
        return client;
      },
    });

    await service.start();

    expect(getTeamJwt).toHaveBeenCalledWith(
      'org-a',
      'personal-account-a',
    );
    expect(clients[0].org).toMatchObject({
      orgId: 'org-a',
      teamMemberId: 'team-member-a',
    });
    service.destroy();
  });
});
