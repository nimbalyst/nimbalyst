import { describe, expect, it } from 'vitest';

import { PendingAuthFlowLedger } from '../PendingAuthFlowLedger';

describe('PendingAuthFlowLedger', () => {
  it('rejects unknown and reused nonces', () => {
    const ledger = new PendingAuthFlowLedger({ createNonce: () => 'nonce' });
    expect(ledger.consume('unknown', 4100)).toBeNull();

    const nonce = ledger.createNonce();
    ledger.register(nonce, { intent: 'sign-in', method: 'google', port: 4100 });
    expect(ledger.consume(nonce, 4100)).toMatchObject({ intent: 'sign-in' });
    expect(ledger.consume(nonce, 4100)).toBeNull();
  });

  it('rejects an expired nonce after the 15-minute TTL', () => {
    let now = 1_000;
    const ledger = new PendingAuthFlowLedger({ now: () => now });
    const nonce = ledger.createNonce();
    ledger.register(nonce, { intent: 'add-account', method: 'google', port: 4200 });

    now += 15 * 60 * 1000;
    expect(ledger.consume(nonce, 4200)).toBeNull();
  });

  it('renews the matching magic-link flow when a link is resent', () => {
    let now = 5_000;
    const ledger = new PendingAuthFlowLedger({ now: () => now });
    const nonce = ledger.createNonce();
    ledger.register(nonce, {
      intent: 'reauth',
      targetPersonalOrgId: 'personal-secondary',
      method: 'magicLink',
      port: 4300,
    });

    now += 14 * 60 * 1000;
    const reusable = ledger.find('magicLink', {
      intent: 'reauth',
      targetPersonalOrgId: 'personal-secondary',
    });
    expect(reusable?.nonce).toBe(nonce);
    expect(ledger.renew(nonce)?.startedAt).toBe(now);

    now += 14 * 60 * 1000;
    expect(ledger.consume(nonce, 4300)).toMatchObject({
      intent: 'reauth',
      targetPersonalOrgId: 'personal-secondary',
    });
  });
});
