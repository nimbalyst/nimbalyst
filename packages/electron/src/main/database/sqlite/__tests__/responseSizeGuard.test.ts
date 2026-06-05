/**
 * Worker response size guard unit tests.
 *
 * The guard exists to convert an oversized worker -> main payload into a
 * catchable rejected request instead of a V8 OOM that crashes the whole
 * process (see responseSizeGuard.ts for the originating crash).
 */

import { describe, expect, it } from 'vitest';
import {
  assertWithinResponseLimit,
  estimateSerializedBytes,
  ResponseTooLargeError,
  DEFAULT_RESPONSE_BYTE_LIMIT,
} from '../worker/responseSizeGuard';

describe('responseSizeGuard', () => {
  it('throws ResponseTooLargeError for a rowset that exceeds the limit', () => {
    // 2,000 rows of a ~1 KB string each = ~2 MB; cap at 1 MB.
    const big = 'a'.repeat(1024);
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, content: big }));
    const result = { rows };

    expect(() => assertWithinResponseLimit(result, 1024 * 1024)).toThrowError(
      ResponseTooLargeError,
    );
  });

  it('allows a small result under the limit', () => {
    const result = { rows: [{ id: 1, name: 'ok' }], rowsAffected: 1 };
    expect(() => assertWithinResponseLimit(result, 1024 * 1024)).not.toThrow();
  });

  it('short-circuits without traversing the whole payload', () => {
    // Build a payload far larger than the tiny limit; estimate must stop early
    // and report a value just past the limit rather than the full size.
    const big = 'x'.repeat(10_000);
    const rows = Array.from({ length: 100_000 }, () => ({ big }));
    const limit = 50_000;
    const approx = estimateSerializedBytes({ rows }, limit);
    expect(approx).toBeGreaterThan(limit);
    // Far below the true total (~2 GB) because traversal bailed out early.
    expect(approx).toBeLessThan(limit * 10);
  });

  it('counts typed-array byte length, not element count', () => {
    const buf = new Uint8Array(2 * 1024 * 1024); // 2 MB
    expect(() => assertWithinResponseLimit({ blob: buf }, 1024 * 1024)).toThrowError(
      ResponseTooLargeError,
    );
  });

  it('handles null, undefined, and primitives without throwing', () => {
    expect(() => assertWithinResponseLimit(null)).not.toThrow();
    expect(() => assertWithinResponseLimit(undefined)).not.toThrow();
    expect(() => assertWithinResponseLimit(42)).not.toThrow();
    expect(() => assertWithinResponseLimit('hello')).not.toThrow();
  });

  it('does not overflow the stack on deeply nested structures', () => {
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 100_000; i++) {
      nested = { child: nested };
    }
    expect(() => estimateSerializedBytes(nested, DEFAULT_RESPONSE_BYTE_LIMIT)).not.toThrow();
  });
});
