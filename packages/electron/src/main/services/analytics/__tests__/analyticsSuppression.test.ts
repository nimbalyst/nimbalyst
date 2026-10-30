// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isAnalyticsSuppressedByEnv } from '../analyticsSuppression';

describe('isAnalyticsSuppressedByEnv', () => {
  // The env the E2E helper actually hands Electron. The old guard checked
  // PLAYWRIGHT_TEST, which nothing sets, so every test launch reported as a
  // brand-new install.
  it('suppresses under the env buildTestEnv produces', () => {
    expect(isAnalyticsSuppressedByEnv({ PLAYWRIGHT: '1', NIMBALYST_DISABLE_ANALYTICS: '1' })).toBe(true);
  });

  // The ENABLE_SESSION_RESTORE specs delete PLAYWRIGHT; the dedicated flag
  // must still hold on its own.
  it('suppresses on the dedicated flag alone', () => {
    expect(isAnalyticsSuppressedByEnv({ NIMBALYST_DISABLE_ANALYTICS: '1' })).toBe(true);
  });

  it('suppresses on PLAYWRIGHT alone', () => {
    expect(isAnalyticsSuppressedByEnv({ PLAYWRIGHT: '1' })).toBe(true);
  });

  it('does not suppress a normal launch', () => {
    expect(isAnalyticsSuppressedByEnv({})).toBe(false);
    expect(isAnalyticsSuppressedByEnv({ NODE_ENV: 'development', NIMBALYST_DISABLE_ANALYTICS: '0' })).toBe(false);
  });
});
