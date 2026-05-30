import { describe, expect, it } from 'vitest';

import { resolveColumnsForType } from '../trackerColumns';

describe('trackerColumns', () => {
  it('gives the structural type column enough width for the grid header and icon', () => {
    const typeColumn = resolveColumnsForType('').find(column => column.id === 'type');

    expect(typeColumn).toBeDefined();
    expect(typeColumn?.width).toBe(64);
    expect(typeColumn?.minWidth).toBe(64);
  });
});
