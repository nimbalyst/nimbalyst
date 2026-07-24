/**
 * Safely extracts a string field from an object.
 * Returns undefined if the object is null/undefined or the field is not a string.
 */
export function extractStringField(
  obj: Record<string, unknown> | null | undefined,
  fieldName: string
): string | undefined {
  if (!obj) return undefined;
  const value = obj[fieldName];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Safely extracts a number field from an object.
 * Returns undefined if the object is null/undefined or the field is not a number.
 */
export function extractNumberField(
  obj: Record<string, unknown> | null | undefined,
  fieldName: string
): number | undefined {
  if (!obj) return undefined;
  const value = obj[fieldName];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Safely extracts a boolean field from an object.
 * Returns undefined if the object is null/undefined or the field is not a boolean.
 */
export function extractBooleanField(
  obj: Record<string, unknown> | null | undefined,
  fieldName: string
): boolean | undefined {
  if (!obj) return undefined;
  const value = obj[fieldName];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Safely extracts an object field from an object.
 * Returns undefined if the object is null/undefined or the field is not an object.
 * Excludes arrays to ensure the extracted value is a plain object.
 */
export function extractObjectField<T = Record<string, unknown>>(
  obj: Record<string, unknown> | null | undefined,
  fieldName: string
): T | undefined {
  if (!obj) return undefined;
  const value = obj[fieldName];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined;
}
