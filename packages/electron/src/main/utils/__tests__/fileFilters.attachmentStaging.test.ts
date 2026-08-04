// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { isAttachmentStagingPath, pathContainsExcludedDir, shouldExcludePath } from '../fileFilters';

describe('attachment staging path exclusions', () => {
  it.each([
    '/workspace/nimbalyst-local/attachments',
    '/workspace/nimbalyst-local/attachments/session/file.txt',
    'C:\\workspace\\nimbalyst-local\\attachments\\session\\file.txt',
  ])('excludes %s', (candidate) => {
    expect(isAttachmentStagingPath(candidate)).toBe(true);
    expect(shouldExcludePath(candidate)).toBe(true);
    expect(pathContainsExcludedDir(candidate)).toBe(true);
  });

  it.each([
    '/workspace/nimbalyst-local/plans/plan.md',
    '/workspace/src/attachments/file.ts',
    '/workspace/attachments/file.ts',
  ])('does not hide unrelated path %s', (candidate) => {
    expect(isAttachmentStagingPath(candidate)).toBe(false);
    expect(shouldExcludePath(candidate)).toBe(false);
  });
});
