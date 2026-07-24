import { describe, expect, it } from 'vitest';
import {
  deserializeWorkerError,
  serializeWorkerError,
} from '../workerErrorSerialization.js';

describe('workerErrorSerialization', () => {
  it('preserves ambiguous lock metadata across the worker boundary', () => {
    type AmbiguousLockError = Error & {
      code?: string;
      lockPid?: number;
      lockFilePath?: string;
      lockTimestamp?: string;
      lockHostname?: string;
    };

    const original = new Error('Cannot tell whether another Nimbalyst is running.') as AmbiguousLockError;
    original.code = 'DATABASE_LOCKED_AMBIGUOUS';
    original.lockPid = 4242;
    original.lockFilePath = '/tmp/nimbalyst-db.pid';
    original.lockTimestamp = '2026-05-15T19:33:39.000Z';
    original.lockHostname = 'workstation.local';

    const roundTripped = deserializeWorkerError(
      serializeWorkerError(original)
    ) as AmbiguousLockError;

    expect(roundTripped.message).toBe(original.message);
    expect(roundTripped.code).toBe('DATABASE_LOCKED_AMBIGUOUS');
    expect(roundTripped.lockPid).toBe(4242);
    expect(roundTripped.lockFilePath).toBe('/tmp/nimbalyst-db.pid');
    expect(roundTripped.lockTimestamp).toBe('2026-05-15T19:33:39.000Z');
    expect(roundTripped.lockHostname).toBe('workstation.local');
  });

  it('falls back to a plain Error when only a message is available', () => {
    const roundTripped = deserializeWorkerError(undefined, 'Worker exited with code 1');
    expect(roundTripped).toBeInstanceOf(Error);
    expect(roundTripped.message).toBe('Worker exited with code 1');
  });
});
