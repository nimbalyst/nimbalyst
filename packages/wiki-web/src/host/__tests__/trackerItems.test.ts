// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LocalTrackerItem } from '@nimbalyst/local-wiki';
import type { WikiTypeInfo } from '../../api/client';
import { toStoredUpdates, toTrackerItem } from '../trackerItems';

const partner: WikiTypeInfo = {
  typeId: 'partner',
  displayName: 'Partner',
  displayNamePlural: 'Partners',
  storage: 'table',
  titleField: 'name',
  definition: null,
  fields: [
    { name: 'name', type: 'string' },
    { name: 'owner', type: 'relationship', itemType: 'person' },
    { name: 'competitors', type: 'relationship', itemType: 'competitor', multiValue: true },
  ],
};

const row: LocalTrackerItem = {
  id: 'p1',
  type: 'partner',
  title: 'Acme',
  storage: 'table',
  path: 'Partners.csv',
  parentId: null,
  parentKind: null,
  order: null,
  createdAt: 0,
  updatedAt: 0,
  fields: { name: 'Acme', owner: 'u1', competitors: ['c1', 'gone'], tier: 'gold' },
};

describe('tracker adapter', () => {
  it('enriches bare relationship ids on read and reduces them to ids on write', () => {
    const lookup = new Map([
      ['u1', { title: 'Greg', type: 'person' }],
      ['c1', { title: 'Globex', type: 'competitor' }],
    ]);
    const item = toTrackerItem(row, partner, lookup, '/wiki');
    expect(item.customFields).toEqual({
      owner: { itemId: 'u1', title: 'Greg', trackerType: 'person' },
      // An id the wiki no longer holds stays a ref with no title rather than vanishing.
      competitors: [{ itemId: 'c1', title: 'Globex', trackerType: 'competitor' }, { itemId: 'gone' }],
      tier: 'gold',
    });

    expect(toStoredUpdates({ title: 'Acme Inc', owner: { itemId: 'u2', title: 'X' }, competitors: [{ itemId: 'c1' }, { itemId: 'c2' }] }, partner)).toEqual({
      name: 'Acme Inc',
      owner: 'u2',
      competitors: ['c1', 'c2'],
    });
    expect(toStoredUpdates({ owner: null, competitors: [] }, partner)).toEqual({ owner: null, competitors: null });
  });
});
