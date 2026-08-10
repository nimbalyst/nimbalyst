import { describe, expect, it } from 'vitest';
import {
  FileSaveFailureTelemetryDeduper,
  classifyFileSaveError,
  getFileSaveSourceAnalytics,
  normalizeFileSaveSource,
} from '../fileSaveErrors';

describe('classifyFileSaveError', () => {
  it.each([
    ['EACCES', 'permission'],
    ['EPERM', 'permission'],
    ['EROFS', 'permission'],
    ['ENOENT', 'not_found'],
    ['ENOSPC', 'disk_full'],
    ['EDQUOT', 'disk_full'],
    ['EISDIR', 'is_directory'],
    ['EMFILE', 'resource_limit'],
    ['ENFILE', 'resource_limit'],
    ['EBUSY', 'resource_limit'],
    ['ETXTBSY', 'resource_limit'],
    ['EIO', 'io'],
    ['ENXIO', 'io'],
    ['EINVAL', 'invalid_path'],
    ['ENAMETOOLONG', 'invalid_path'],
    ['ENOTDIR', 'invalid_path'],
    ['ELOOP', 'invalid_path'],
  ] as const)('classifies stable Node code %s as %s', (code, expectedType) => {
    expect(classifyFileSaveError(Object.assign(new Error('redacted'), { code }))).toEqual({
      errorCode: code,
      errorType: expectedType,
    });
  });

  it('does not infer a category from a potentially sensitive error message', () => {
    expect(classifyFileSaveError(new Error('permission denied for /Users/example/secret.md'))).toEqual({
      errorCode: 'UNKNOWN',
      errorType: 'unknown',
    });
  });

  it('normalizes unknown codes without forwarding arbitrary values', () => {
    expect(classifyFileSaveError(Object.assign(new Error('failure'), { code: 'CUSTOM_PRIVATE_CODE' }))).toEqual({
      errorCode: 'UNKNOWN',
      errorType: 'unknown',
    });
  });

  it('normalizes the save source and defaults legacy callers to manual', () => {
    expect(normalizeFileSaveSource('auto')).toBe('auto');
    expect(normalizeFileSaveSource('manual')).toBe('manual');
    expect(normalizeFileSaveSource(undefined)).toBe('manual');
    expect(normalizeFileSaveSource('unexpected')).toBe('manual');
  });

  it('maps the propagated source to success and failure analytics consistently', () => {
    expect(getFileSaveSourceAnalytics('auto')).toEqual({
      saveType: 'auto',
      isAutoSave: true,
    });
    expect(getFileSaveSourceAnalytics('manual')).toEqual({
      saveType: 'manual',
      isAutoSave: false,
    });
  });
});

describe('FileSaveFailureTelemetryDeduper', () => {
  it('reports one event for a continuous failure and rearms after success', () => {
    const deduper = new FileSaveFailureTelemetryDeduper();
    const path = '/private/path/never-emitted.md';

    expect(deduper.shouldReport(path, 'auto', 'EACCES')).toBe(true);
    expect(deduper.shouldReport(path, 'auto', 'EACCES')).toBe(false);
    expect(deduper.shouldReport(path, 'auto', 'ENOSPC')).toBe(true);
    expect(deduper.shouldReport(path, 'manual', 'EACCES')).toBe(true);

    deduper.markSuccess(path);

    expect(deduper.shouldReport(path, 'auto', 'EACCES')).toBe(true);
    expect(deduper.shouldReport(path, 'manual', 'EACCES')).toBe(true);
  });
});
