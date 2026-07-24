import type { LocalReplicaIdentity } from "@nimbalyst/runtime/sync";

interface IdentityClaims {
  identity: LocalReplicaIdentity;
  attachmentIds: Set<string>;
}

function identityKey(identity: LocalReplicaIdentity): string {
  return `${identity.accountId}\u0000${identity.orgId}\u0000${identity.documentId}`;
}

/** Entry-scoped renderer claims for the live-provider/headless-drainer handoff. */
export class ProviderAttachmentRegistry {
  private readonly claimsBySender = new Map<
    number,
    Map<string, IdentityClaims>
  >();

  attach(senderId: number, identity: LocalReplicaIdentity, attachmentId: string): void {
    const senderClaims = this.claimsBySender.get(senderId) ?? new Map<string, IdentityClaims>();
    const key = identityKey(identity);
    const claims = senderClaims.get(key) ?? { identity, attachmentIds: new Set<string>() };
    claims.attachmentIds.add(attachmentId);
    senderClaims.set(key, claims);
    this.claimsBySender.set(senderId, senderClaims);
  }

  detach(senderId: number, identity: LocalReplicaIdentity, attachmentId: string): void {
    const senderClaims = this.claimsBySender.get(senderId);
    if (!senderClaims) return;
    const key = identityKey(identity);
    const claims = senderClaims.get(key);
    if (!claims) return;
    claims.attachmentIds.delete(attachmentId);
    if (claims.attachmentIds.size === 0) senderClaims.delete(key);
    if (senderClaims.size === 0) this.claimsBySender.delete(senderId);
  }

  clearSender(senderId: number): LocalReplicaIdentity[] {
    const senderClaims = this.claimsBySender.get(senderId);
    if (!senderClaims) return [];
    this.claimsBySender.delete(senderId);
    return [...senderClaims.values()].map(({ identity }) => identity);
  }

  clear(): LocalReplicaIdentity[] {
    const identities = new Map<string, LocalReplicaIdentity>();
    for (const senderClaims of this.claimsBySender.values()) {
      for (const [key, claims] of senderClaims) identities.set(key, claims.identity);
    }
    this.claimsBySender.clear();
    return [...identities.values()];
  }

  isAttached(identity: LocalReplicaIdentity): boolean {
    const key = identityKey(identity);
    for (const senderClaims of this.claimsBySender.values()) {
      if (senderClaims.has(key)) return true;
    }
    return false;
  }

  attachedSenderIds(
    identity: LocalReplicaIdentity,
    excludeSenderId?: number
  ): number[] {
    const key = identityKey(identity);
    const senderIds: number[] = [];
    for (const [senderId, senderClaims] of this.claimsBySender) {
      if (senderId !== excludeSenderId && senderClaims.has(key)) {
        senderIds.push(senderId);
      }
    }
    return senderIds;
  }
}
