import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TEAM_ANALYTICS_CONTRACT_VERSION,
  TEAM_ANALYTICS_EVENT_SCHEMAS,
  buildTeamAnalyticsCapture,
  bucketDuration,
  bucketItemCount,
  bucketMemberCount,
  bucketProjectCount,
  bucketQueryLength,
  bucketRetryCount,
  categorizeTeamAnalyticsError,
  normalizeTeamAnalyticsCallerRole,
  teamPersonPropertiesForEvent,
  validateTeamAnalyticsEvent,
} from '../teamAnalytics';

describe('Teams analytics contract', () => {
  it('is explicitly versioned', () => {
    expect(TEAM_ANALYTICS_CONTRACT_VERSION).toBe(1);
  });

  it('keeps every contract event in the PostHog catalog', () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    const catalog = readFileSync(resolve(repositoryRoot, 'docs/POSTHOG_EVENTS.md'), 'utf8');
    for (const event of Object.keys(TEAM_ANALYTICS_EVENT_SCHEMAS)) {
      expect(catalog, `missing ${event} from docs/POSTHOG_EVENTS.md`).toContain(`\`${event}\``);
    }
  });

  it('accepts documented categorical properties', () => {
    expect(validateTeamAnalyticsEvent('team_organization_created', {
      surface: 'desktop',
      entryPoint: 'organization_manager',
      projectAttached: false,
      encryptionMode: 'server_managed',
      memberCountBucket: '1',
      projectCountBucket: '1',
    })).toEqual({
      event: 'team_organization_created',
      properties: {
        surface: 'desktop',
        entryPoint: 'organization_manager',
        projectAttached: false,
        encryptionMode: 'server_managed',
        memberCountBucket: '1',
        projectCountBucket: '1',
      },
    });
  });

  it('rejects unknown and identifying properties at runtime', () => {
    expect(() => validateTeamAnalyticsEvent('team_surface_opened', {
      surface: 'desktop',
      orgId: 'org-secret',
    } as never)).toThrow('not an allowlisted property');
    expect(() => validateTeamAnalyticsEvent('collab_document_created', {
      documentType: 'person@example.com',
    })).toThrow('forbidden identifying value');
    expect(() => validateTeamAnalyticsEvent('tracker_item_mutated', {
      trackerType: '/Users/person/private.tracker',
    })).toThrow('forbidden identifying value');
    expect(() => validateTeamAnalyticsEvent('tracker_item_mutated', {
      trackerType: 'client/private_project',
    })).toThrow('stable low-cardinality category');
  });

  it('rejects arbitrary enum values and raw error payloads', () => {
    expect(() => validateTeamAnalyticsEvent('team_operation_failed', {
      errorCategory: 'the server rejected user@example.com',
    } as never)).toThrow('forbidden identifying value');
    expect(() => validateTeamAnalyticsEvent('collab_sync_attempt_completed', {
      outcome: 'retrying',
    } as never)).toThrow('not an allowlisted category');
  });

  it('records viewer roles without treating unknown roles as known', () => {
    expect(normalizeTeamAnalyticsCallerRole('viewer')).toBe('viewer');
    expect(normalizeTeamAnalyticsCallerRole('future-role')).toBe('unknown');
    expect(validateTeamAnalyticsEvent('team_organization_switched', {
      surface: 'desktop',
      entryPoint: 'org_switcher',
      callerRole: 'viewer',
    }).properties.callerRole).toBe('viewer');
  });

  it('buckets counts and durations without returning exact high-cardinality values', () => {
    expect([bucketMemberCount(1), bucketMemberCount(3), bucketMemberCount(26)]).toEqual(['1', '2-3', '26+']);
    expect([bucketProjectCount(1), bucketProjectCount(4), bucketProjectCount(20)]).toEqual(['1', '4-10', '11+']);
    expect([bucketItemCount(0), bucketItemCount(5), bucketItemCount(21)]).toEqual(['0', '2-5', '21+']);
    expect([bucketRetryCount(0), bucketRetryCount(3), bucketRetryCount(9)]).toEqual(['0', '2-3', '4+']);
    expect([bucketDuration(999), bucketDuration(1_000), bucketDuration(5_000)]).toEqual(['fast', 'medium', 'slow']);
    expect([bucketQueryLength(3), bucketQueryLength(10), bucketQueryLength(31)]).toEqual(['1-3', '4-10', '31+']);
  });

  it('normalizes raw failures locally into bounded categories', () => {
    expect(categorizeTeamAnalyticsError('organization', new Error('Invitation expired'))).toBe('invite_invalid');
    expect(categorizeTeamAnalyticsError('project', 'No git remote is configured')).toBe('no_git_remote');
    expect(categorizeTeamAnalyticsError('document', new Error('Attachment upload failed'))).toBe('asset_migration_failed');
    expect(categorizeTeamAnalyticsError('sync', new Error('WebSocket timed out'))).toBe('timeout');
    expect(categorizeTeamAnalyticsError('sync', { private: 'not inspected' })).toBe('unknown');
  });

  it('sets only low-cardinality adoption properties', () => {
    expect(teamPersonPropertiesForEvent('team_organization_created', {})).toEqual({
      has_created_team_organization: true,
    });
    expect(teamPersonPropertiesForEvent('collab_document_opened', { source: 'restart_restore' })).toBeUndefined();
    expect(teamPersonPropertiesForEvent('tracker_item_mutated', { collaborationScope: 'shared' })).toEqual({
      has_used_teams: true,
      has_used_shared_tracker: true,
    });
    expect(buildTeamAnalyticsCapture('collab_document_first_edited', {
      source: 'sidebar',
    }).properties).toEqual({
      source: 'sidebar',
      $set_once: {
        has_used_teams: true,
        has_edited_shared_document: true,
      },
    });
  });
});
