import { describe, expect, it } from 'vitest';

import { getDefaultCreateTeamAccountId } from '../teamDialogs';

describe('create-team account default', () => {
  it('defaults to the sync account instead of ambient account order', () => {
    expect(getDefaultCreateTeamAccountId([
      { personalOrgId: 'work', email: 'work@example.com', isSyncAccount: false },
      { personalOrgId: 'personal', email: 'me@example.com', isSyncAccount: true },
    ])).toBe('personal');
  });
});
