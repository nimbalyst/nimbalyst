// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { typedPageEditing } from '../typedPageEditing';

describe('typedPageEditing', () => {
  it('gives a table row and every page of a static export no way to rename, edit or archive, and leaves pages editable', () => {
    const handlers = { update: vi.fn(async () => {}), archive: vi.fn(), fail: vi.fn() };
    for (const readOnly of [typedPageEditing('table', false, handlers), typedPageEditing('pages', true, handlers)]) {
      expect(readOnly.editable).toBe(false);
      expect(readOnly.onArchive).toBeUndefined();
      readOnly.onRename('Renamed');
      readOnly.onUpdateField({ name: 'tier' } as never, 'gold');
    }
    expect(handlers.update).not.toHaveBeenCalled();

    const page = typedPageEditing('pages', false, handlers);
    expect(page.editable).toBe(true);
    page.onRename('Renamed');
    page.onUpdateField({ name: 'tier' } as never, 'gold');
    page.onArchive!();
    expect(handlers.update.mock.calls).toEqual([[{ title: 'Renamed' }], [{ tier: 'gold' }]]);
    expect(handlers.archive).toHaveBeenCalledOnce();
  });
});
