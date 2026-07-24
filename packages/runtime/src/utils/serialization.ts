/**
 * Safe JSON serialization utilities for handling circular references,
 * bigints, and Error objects that don't serialize natively.
 */

export interface SerializationResult {
  content: string;
  usedFallback: boolean;
}

/**
 * Safely serialize a value to JSON, handling circular references and special types.
 *
 * Handles:
 * - Circular references: Marks them as '[Circular]'
 * - BigInt values: Converts to string representation
 * - Error objects: Extracts name, message, and stack properties
 * - Serialization failures: Falls back to a type descriptor object
 *
 * @param value - The value to serialize
 * @returns SerializationResult with content and fallback flag
 */
export function safeJSONSerialize(value: unknown): SerializationResult {
  const seen = new WeakSet<object>();

  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === 'bigint') {
      return val.toString();
    }
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
      };
    }
    if (val && typeof val === 'object') {
      if (seen.has(val as object)) {
        return '[Circular]';
      }
      seen.add(val as object);
    }
    return val;
  };

  try {
    const serialized = JSON.stringify(value, replacer);
    if (typeof serialized === 'string') {
      return { content: serialized, usedFallback: false };
    }
  } catch {
    // Fall through to fallback
  }

  return {
    content: JSON.stringify({
      type: 'serialization_fallback',
      valueType: typeof value,
      fallback: true,
    }),
    usedFallback: true,
  };
}
