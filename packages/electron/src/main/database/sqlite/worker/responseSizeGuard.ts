/**
 * Worker -> main response size guard.
 *
 * Every worker response is structured-cloned by V8's `ValueSerializer` when it
 * is posted over the `worker_threads` MessagePort. An oversized payload (e.g.
 * an analytics query that SELECTs full message `content` across every session)
 * grows the serializer's output buffer until V8 aborts the *entire process*
 * with a fatal OOM (`brk 0` / SIGTRAP) — taking the whole app down rather than
 * failing a single query. A real crash on 2026-06-03 hit this while loading the
 * AI Usage Report: the realloc was ~2.1 GB at the moment V8 trapped.
 *
 * This guard walks a candidate payload, accumulating an approximate serialized
 * byte cost, and bails out the instant the running total crosses the limit — so
 * we never pay to traverse a multi-GB structure. Callers turn an over-limit
 * result into a normal rejected request instead of a process crash.
 */

/** Default ceiling for a single worker -> main response payload. */
export const DEFAULT_RESPONSE_BYTE_LIMIT = 256 * 1024 * 1024; // 256 MB

export class ResponseTooLargeError extends Error {
  constructor(
    public readonly approxBytes: number,
    public readonly limitBytes: number,
  ) {
    const mb = (n: number) => Math.round(n / (1024 * 1024));
    super(
      `Query result is too large to return (~${mb(approxBytes)} MB, limit ${mb(limitBytes)} MB). ` +
        `Narrow the query with a WHERE clause, aggregation, or LIMIT.`,
    );
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Estimate the approximate structured-clone byte cost of `value`, stopping as
 * soon as the running total exceeds `limit`. Cost is therefore bounded by the
 * limit, not by the (possibly enormous) input.
 *
 * Uses an explicit stack rather than recursion so a deeply nested payload can't
 * overflow the JS call stack here (the crash backtrace showed V8 recursing
 * deeply through `WriteValue` — we must not reproduce that failure mode while
 * trying to prevent it).
 */
export function estimateSerializedBytes(root: unknown, limit = Infinity): number {
  let total = 0;
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    if (total > limit) return total; // short-circuit; no point measuring further
    const v = stack.pop();

    if (v === null || v === undefined) {
      total += 1;
      continue;
    }

    switch (typeof v) {
      case 'boolean':
        total += 4;
        break;
      case 'number':
      case 'bigint':
        total += 8;
        break;
      case 'string':
        // UTF-16 code units is a cheap, safe upper bound vs. computing UTF-8.
        total += v.length * 2 + 2;
        break;
      case 'object': {
        if (ArrayBuffer.isView(v)) {
          total += (v as ArrayBufferView).byteLength;
        } else if (v instanceof ArrayBuffer) {
          total += v.byteLength;
        } else if (v instanceof Date) {
          total += 8;
        } else if (Array.isArray(v)) {
          total += 8;
          for (let i = 0; i < v.length; i++) stack.push(v[i]);
        } else if (v instanceof Map) {
          total += 8;
          for (const [k, val] of v) {
            stack.push(k);
            stack.push(val);
          }
        } else if (v instanceof Set) {
          total += 8;
          for (const item of v) stack.push(item);
        } else {
          total += 8;
          const obj = v as Record<string, unknown>;
          for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              total += key.length * 2 + 2;
              stack.push(obj[key]);
            }
          }
        }
        break;
      }
      default:
        // function / symbol — won't survive structured clone, but cheap to skip.
        total += 8;
    }
  }

  return total;
}

/**
 * Throw {@link ResponseTooLargeError} if `value` would exceed `limitBytes` when
 * serialized across the worker boundary.
 */
export function assertWithinResponseLimit(
  value: unknown,
  limitBytes: number = DEFAULT_RESPONSE_BYTE_LIMIT,
): void {
  const approx = estimateSerializedBytes(value, limitBytes);
  if (approx > limitBytes) {
    throw new ResponseTooLargeError(approx, limitBytes);
  }
}
