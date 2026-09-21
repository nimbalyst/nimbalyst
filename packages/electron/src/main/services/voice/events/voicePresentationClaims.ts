import { randomUUID } from 'node:crypto';

export interface PresentationClaim {
  deviceId: string;
  token: string;
  expiresAt: number;
  presented: boolean;
}

/** One source host arbitrates its own events; persistence survives a host restart. */
export class VoicePresentationClaims {
  constructor(
    private readonly read: (key: string) => PresentationClaim | undefined,
    private readonly write: (key: string, value: PresentationClaim) => void,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {}
  wasPresented(key: string): boolean { return this.read(key)?.presented === true; }
  claim(key: string, deviceId: string): PresentationClaim | null {
    const old = this.read(key);
    if (old?.presented || (old && old.expiresAt > this.now() && old.deviceId !== deviceId)) return null;
    const claim = { deviceId, token: old?.deviceId === deviceId && old.expiresAt > this.now() ? old.token : randomUUID(), expiresAt: this.now() + this.ttlMs, presented: false };
    this.write(key, claim);
    return claim;
  }
  valid(key: string, deviceId: string, token: string): boolean {
    const claim = this.read(key);
    return !!claim && !claim.presented && claim.deviceId === deviceId && claim.token === token && claim.expiresAt > this.now();
  }
  presented(key: string, deviceId: string, token: string): boolean {
    if (!this.valid(key, deviceId, token)) return false;
    this.write(key, { ...this.read(key)!, presented: true });
    return true;
  }
}
