import { describe, expect, it } from 'vitest';

import { getAccountSessionStatus } from '../StytchAuthService';

describe('Stytch account session status', () => {
  it('keeps expired accounts visible for account-scoped re-authentication', () => {
    expect(getAccountSessionStatus(999, 1_000)).toBe('expired');
    expect(getAccountSessionStatus(1_001, 1_000)).toBe('active');
  });
});
