// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPageFieldsPatch, normalizePageFields } from '../pageFields';

describe('page fields', () => {
  it('keeps only known fields in their stored shape', () => {
    expect(normalizePageFields({
      status: 'current', owner: ' ana@example.com ', summary: '', tags: ['a', ' a', '', 3, 'b'], color: 'red',
    })).toEqual({ status: 'current', owner: 'ana@example.com', tags: ['a', 'b'] });
    expect(normalizePageFields({ status: 'shipped' })).toEqual({});
    // The owner is an email, as a `user` field holds; a bare name is dropped.
    expect(normalizePageFields({ owner: 'Ana' })).toEqual({});
    expect(normalizePageFields('nope')).toEqual({});
  });

  it('clears a field the patch empties and keeps the rest', () => {
    expect(applyPageFieldsPatch({ status: 'draft', owner: 'ana@example.com' }, { owner: null, summary: 'Why sync works' }))
      .toEqual({ status: 'draft', summary: 'Why sync works' });
    // A value that doesn't validate leaves the stored one alone.
    expect(applyPageFieldsPatch({ status: 'current' }, { status: 'shipped' })).toEqual({ status: 'current' });
  });
});
