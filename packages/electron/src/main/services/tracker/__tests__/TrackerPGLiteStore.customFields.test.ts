import { describe, it, expect } from 'vitest';
import { pgliteRowToTrackerItem } from '../TrackerPGLiteStore';

/**
 * Regression for NIM-1659: the sync read-back mapper must preserve the nested
 * `data.customFields` bag. `TrackerSyncManager.emitItemApplied` broadcasts the
 * item returned here on `document-service:tracker-items-changed`; if
 * customFields (prUrl, prNumber, relationship fields, ...) is dropped, the
 * renderer upserts a reference-less record that clobbers the good one and the
 * PR badge / schema columns vanish until a full reload.
 */
describe('pgliteRowToTrackerItem customFields', () => {
  const workspace = '/tmp/ws';

  function row(data: Record<string, unknown>) {
    return {
      id: 'github-pr_1',
      type: 'github-pr',
      type_tags: ['github-pr'],
      data: JSON.stringify(data),
      workspace,
      document_path: null,
      line_number: null,
      issue_number: 1656,
      issue_key: 'NIM-1656',
      sync_status: 'synced',
      sync_id: 1,
      body_version: 0,
      deleted_at: null,
      archived: false,
      source: 'native',
      source_ref: null,
      created: new Date('2026-07-12T12:00:00Z'),
      updated: new Date('2026-07-12T12:05:00Z'),
      last_indexed: new Date('2026-07-12T12:05:00Z'),
    } as any;
  }

  it('lifts nested data.customFields (prUrl, prNumber) onto the item', () => {
    const item = pgliteRowToTrackerItem(
      row({
        title: 'expose effort controls',
        status: 'safe',
        priority: 'high',
        customFields: {
          prUrl: { url: 'https://github.com/nimbalyst/nimbalyst/pull/831', label: '#831' },
          prNumber: 831,
          notes: 'looks good',
        },
      }),
      workspace,
    );

    expect(item.customFields).toBeDefined();
    expect(item.customFields?.prUrl).toEqual({
      url: 'https://github.com/nimbalyst/nimbalyst/pull/831',
      label: '#831',
    });
    expect(item.customFields?.prNumber).toBe(831);
  });

  it('also surfaces flat top-level custom fields', () => {
    const item = pgliteRowToTrackerItem(
      row({
        title: 'legacy flat',
        status: 'backlog',
        prUrl: { url: 'https://github.com/nimbalyst/nimbalyst/pull/700', label: '#700' },
      }),
      workspace,
    );

    expect(item.customFields?.prUrl).toEqual({
      url: 'https://github.com/nimbalyst/nimbalyst/pull/700',
      label: '#700',
    });
  });
});
