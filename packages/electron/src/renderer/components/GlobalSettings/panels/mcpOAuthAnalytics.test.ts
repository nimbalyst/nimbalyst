import { describe, expect, it } from 'vitest';
import { buildMCPOAuthAnalyticsProperties } from './mcpOAuthAnalytics';

describe('buildMCPOAuthAnalyticsProperties', () => {
  it('keeps successful authorization telemetry categorical', () => {
    expect(buildMCPOAuthAnalyticsProperties(
      { success: true, outcome: 'authorized' },
      { templateId: 'notion' }
    )).toEqual({
      templateId: 'notion',
      success: true,
      outcome: 'authorized',
    });
  });

  it('keeps raw OAuth diagnostics out of failure telemetry', () => {
    const properties = buildMCPOAuthAnalyticsProperties({
      success: false,
      outcome: 'timed_out',
      errorType: 'timeout',
      error: 'https://provider.example/callback?code=secret&state=secret /Users/name/auth.json',
    }, {
      templateId: null,
      retryAfterCacheClear: true,
    });

    expect(properties).toEqual({
      templateId: null,
      success: false,
      outcome: 'timed_out',
      errorType: 'timeout',
      retryAfterCacheClear: true,
    });
    expect(JSON.stringify(properties)).not.toContain('provider.example');
    expect(JSON.stringify(properties)).not.toContain('/Users/');
    expect(JSON.stringify(properties)).not.toContain('secret');
  });

  it('maps unrecognized main-process values to bounded fallback categories', () => {
    expect(buildMCPOAuthAnalyticsProperties({
      success: false,
      outcome: 'raw provider outcome',
      errorType: 'invalid_grant: provider detail',
    }, {
      templateId: null,
    })).toEqual({
      templateId: null,
      success: false,
      outcome: 'failed',
      errorType: 'unknown',
    });
  });

  it('keeps success and outcome internally consistent for malformed IPC results', () => {
    expect(buildMCPOAuthAnalyticsProperties({
      success: true,
      outcome: 'failed',
      errorType: 'process_exit',
    }, {
      templateId: null,
    })).toEqual({
      templateId: null,
      success: true,
      outcome: 'authorized',
    });

    expect(buildMCPOAuthAnalyticsProperties({
      success: false,
      outcome: 'authorized',
    }, {
      templateId: null,
    })).toEqual({
      templateId: null,
      success: false,
      outcome: 'failed',
      errorType: 'unknown',
    });
  });

  it('maps the legacy stale-port result without copying its error text', () => {
    expect(buildMCPOAuthAnalyticsProperties({
      success: false,
      isStalePortError: true,
      error: 'raw error text',
    }, {
      templateId: 'slack',
    })).toEqual({
      templateId: 'slack',
      success: false,
      outcome: 'failed',
      errorType: 'port_conflict',
    });
  });
});
