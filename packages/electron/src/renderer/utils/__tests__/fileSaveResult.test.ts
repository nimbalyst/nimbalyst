import { describe, expect, it } from 'vitest';
import {
  FileSaveRejectedError,
  assertFileSaveSucceeded,
  getSaveFailureMessage,
  resolveSaveFailureType,
} from '../fileSaveResult';

describe('resolveSaveFailureType', () => {
  it('prefers the deleted and conflict flags over the raw error type', () => {
    expect(resolveSaveFailureType({ success: false, deleted: true, errorType: 'io' }))
      .toBe('not_found');
    expect(resolveSaveFailureType({ success: false, conflict: true, errorType: 'io' }))
      .toBe('conflict');
  });

  it('falls back to unknown for an absent or unclassified result', () => {
    expect(resolveSaveFailureType(null)).toBe('unknown');
    expect(resolveSaveFailureType({ success: false })).toBe('unknown');
    expect(resolveSaveFailureType({ success: false, errorType: 'disk_full' }))
      .toBe('disk_full');
  });
});

describe('getSaveFailureMessage', () => {
  it('distinguishes a paused autosave from a failed manual save', () => {
    expect(getSaveFailureMessage('permission', 'auto')).toMatch(/^Autosave is blocked/);
    expect(getSaveFailureMessage('permission', 'manual')).toMatch(/^Save failed/);
  });

  it('always tells the user their edits are preserved', () => {
    for (const errorType of [
      'permission',
      'disk_full',
      'not_found',
      'is_directory',
      'invalid_path',
      'resource_limit',
      'io',
      'conflict',
      'something-we-have-never-seen',
    ]) {
      expect(getSaveFailureMessage(errorType, 'auto')).toContain('remain unsaved');
    }
  });

  it('explains the cause for classified errors', () => {
    expect(getSaveFailureMessage('disk_full', 'manual')).toContain('disk is full');
    expect(getSaveFailureMessage('permission', 'manual')).toContain('permission');
    expect(getSaveFailureMessage('conflict', 'manual')).toContain('changed on disk');
  });
});

describe('assertFileSaveSucceeded', () => {
  it('accepts successful writes', () => {
    expect(() => assertFileSaveSucceeded({ success: true })).not.toThrow();
  });

  it('turns a structured filesystem failure into a rejected save', () => {
    expect(() => assertFileSaveSucceeded({
      success: false,
      errorType: 'permission',
      errorCode: 'EACCES',
    })).toThrowError(FileSaveRejectedError);

    try {
      assertFileSaveSucceeded({
        success: false,
        errorType: 'permission',
        errorCode: 'EACCES',
      });
    } catch (error) {
      expect(error).toMatchObject({
        errorType: 'permission',
        code: 'EACCES',
      });
    }
  });

  it('classifies deleted and conflict results without exposing file details', () => {
    expect(() => assertFileSaveSucceeded({ success: false, deleted: true })).toThrow(
      'File save failed (not_found)',
    );
    expect(() => assertFileSaveSucceeded({ success: false, conflict: true })).toThrow(
      'File save failed (conflict)',
    );
    expect(() => assertFileSaveSucceeded(null)).toThrow('File save failed (unknown)');
  });
});
