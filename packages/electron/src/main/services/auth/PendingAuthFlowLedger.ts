import { randomBytes } from 'node:crypto';

export const AUTH_FLOW_TTL_MS = 15 * 60 * 1000;

export type AuthIntent = 'sign-in' | 'add-account' | 'reauth';
export type AuthMethod = 'google' | 'magicLink';

export interface AuthFlowOptions {
  intent: AuthIntent;
  targetPersonalOrgId?: string;
}

export interface PendingAuthFlow extends AuthFlowOptions {
  method: AuthMethod;
  port: number;
  startedAt: number;
}

interface PendingAuthFlowLedgerOptions {
  ttlMs?: number;
  now?: () => number;
  createNonce?: () => string;
}

export class PendingAuthFlowLedger {
  private readonly flows = new Map<string, PendingAuthFlow>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createNonceValue: () => string;

  constructor(options: PendingAuthFlowLedgerOptions = {}) {
    this.ttlMs = options.ttlMs ?? AUTH_FLOW_TTL_MS;
    this.now = options.now ?? Date.now;
    this.createNonceValue = options.createNonce ?? (() => randomBytes(32).toString('hex'));
  }

  createNonce(): string {
    let nonce = this.createNonceValue();
    while (this.flows.has(nonce)) nonce = this.createNonceValue();
    return nonce;
  }

  register(nonce: string, flow: Omit<PendingAuthFlow, 'startedAt'>): PendingAuthFlow {
    if (!nonce) throw new Error('Auth flow nonce is required');
    if (flow.intent === 'reauth' && !flow.targetPersonalOrgId) {
      throw new Error('Reauth requires targetPersonalOrgId');
    }
    const entry = { ...flow, startedAt: this.now() };
    this.flows.set(nonce, entry);
    return { ...entry };
  }

  peek(nonce: string): PendingAuthFlow | null {
    const flow = this.flows.get(nonce);
    if (!flow) return null;
    if (this.isExpired(flow)) {
      this.flows.delete(nonce);
      return null;
    }
    return { ...flow };
  }

  consume(nonce: string, port: number): PendingAuthFlow | null {
    const flow = this.flows.get(nonce);
    if (!flow) return null;
    if (this.isExpired(flow)) {
      this.flows.delete(nonce);
      return null;
    }
    if (flow.port !== port) return null;
    this.flows.delete(nonce);
    return { ...flow };
  }

  renew(nonce: string): PendingAuthFlow | null {
    const flow = this.peek(nonce);
    if (!flow) return null;
    const renewed = { ...flow, startedAt: this.now() };
    this.flows.set(nonce, renewed);
    return { ...renewed };
  }

  find(method: AuthMethod, options: AuthFlowOptions): { nonce: string; flow: PendingAuthFlow } | null {
    for (const [nonce] of this.flows) {
      const flow = this.peek(nonce);
      if (!flow) continue;
      if (
        flow.method === method
        && flow.intent === options.intent
        && flow.targetPersonalOrgId === options.targetPersonalOrgId
      ) {
        return { nonce, flow };
      }
    }
    return null;
  }

  delete(nonce: string): boolean {
    return this.flows.delete(nonce);
  }

  clear(): void {
    this.flows.clear();
  }

  private isExpired(flow: PendingAuthFlow): boolean {
    return this.now() - flow.startedAt >= this.ttlMs;
  }
}
