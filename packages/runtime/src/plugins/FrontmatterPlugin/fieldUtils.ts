/**
 * Field utilities for generic frontmatter rendering
 * Provides type inference and field processing for arbitrary YAML frontmatter
 */

import jsyaml from 'js-yaml';

export type InferredFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'array'
  | 'tags'
  | 'link'
  | 'object';

export interface InferredField {
  key: string;
  value: unknown;
  type: InferredFieldType;
  displayValue: string;
}

/** Maximum depth for flattening nested objects */
const MAX_NESTING_DEPTH = 3;

/** Keys that should be skipped entirely (tracker-specific) */
const TRACKER_KEYS = ['planStatus', 'decisionStatus', 'trackerStatus'];

/**
 * Check if a value is a plain object (not array, null, Date, or other special types)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Check if an array contains only primitive values (strings, numbers, booleans)
 */
function isArrayOfPrimitives(value: unknown[]): boolean {
  return value.every(
    item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
  );
}

/**
 * Flatten a nested object into dot-notation keys
 * @param obj The object to flatten
 * @param prefix The current key prefix (for recursion)
 * @param depth Current depth level
 * @returns Array of [key, value] tuples with dot-notation keys
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix: string = '',
  depth: number = 0
): Array<[string, unknown]> {
  const result: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    // Skip tracker-specific keys at root level
    if (depth === 0 && TRACKER_KEYS.includes(key)) {
      continue;
    }

    if (isPlainObject(value)) {
      // Check if we've reached max depth
      if (depth >= MAX_NESTING_DEPTH - 1) {
        // At max depth, skip the nested object
        continue;
      }
      // Recursively flatten nested objects
      const nested = flattenObject(value, fullKey, depth + 1);
      result.push(...nested);
    } else if (Array.isArray(value)) {
      // Include arrays of primitives, skip arrays of objects
      if (isArrayOfPrimitives(value)) {
        result.push([fullKey, value]);
      }
      // Skip arrays of objects (too complex for simple rendering)
    } else {
      // Primitive value - include it
      result.push([fullKey, value]);
    }
  }

  return result;
}

/**
 * Set a value at a nested path using dot notation
 * @param obj The object to modify
 * @param path The dot-notation path (e.g., "author.name")
 * @param value The value to set
 * @returns A new object with the value set at the path
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const result = { ...obj };
  const parts = path.split('.');

  if (parts.length === 1) {
    // Simple case - no nesting
    result[path] = value;
    return result;
  }

  // Navigate/create nested structure
  let current: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isPlainObject(current[part])) {
      // Create intermediate object if needed
      current[part] = {};
    } else {
      // Clone to avoid mutation
      current[part] = { ...(current[part] as Record<string, unknown>) };
    }
    current = current[part] as Record<string, unknown>;
  }

  // Set the final value
  current[parts[parts.length - 1]] = value;

  return result;
}

export interface FrontmatterParseResult {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
  hasFrontmatter: boolean;
}

/**
 * Extract YAML frontmatter from markdown content with error details
 */
export function extractFrontmatterWithError(content: string): FrontmatterParseResult {
  // `\r?\n` tolerates Windows CRLF (nimbalyst#68).
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { success: true, data: null, error: null, hasFrontmatter: false };
  }

  try {
    const yamlContent = match[1];
    const parsed = jsyaml.load(yamlContent) as Record<string, unknown>;
    return { success: true, data: parsed || null, error: null, hasFrontmatter: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[FrontmatterPlugin] Failed to parse frontmatter:', error);
    return { success: false, data: null, error: errorMessage, hasFrontmatter: true };
  }
}

/**
 * Extract YAML frontmatter from markdown content
 */
export function extractFrontmatter(content: string): Record<string, unknown> | null {
  const result = extractFrontmatterWithError(content);
  return result.data;
}

/**
 * Infer field type from key name and value
 */
export function inferFieldType(key: string, value: unknown): InferredFieldType {
  // By key name patterns - most specific first
  const lowerKey = key.toLowerCase();

  // Tags field detection
  if (lowerKey === 'tags' || lowerKey.endsWith('tags')) {
    return 'tags';
  }

  // Date field detection by key name
  if (
    lowerKey === 'date' ||
    lowerKey === 'created' ||
    lowerKey === 'updated' ||
    lowerKey === 'modified' ||
    lowerKey.endsWith('date') ||
    lowerKey.endsWith('at') ||
    lowerKey.startsWith('date')
  ) {
    return 'date';
  }

  // Link field detection by key name
  if (
    lowerKey === 'url' ||
    lowerKey === 'link' ||
    lowerKey === 'href' ||
    lowerKey.endsWith('url') ||
    lowerKey.endsWith('link')
  ) {
    return 'link';
  }

  // By value type
  if (value instanceof Date) {
    return 'date';
  }

  if (Array.isArray(value)) {
    // Check if it looks like tags (array of strings)
    if (value.every(v => typeof v === 'string')) {
      return 'tags';
    }
    return 'array';
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  if (typeof value === 'number') {
    return 'number';
  }

  if (typeof value === 'object' && value !== null) {
    return 'object';
  }

  // String value patterns
  if (typeof value === 'string') {
    // ISO date pattern
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(value)) {
      return 'date';
    }
    // URL pattern
    if (/^https?:\/\//.test(value)) {
      return 'link';
    }
  }

  return 'string';
}

/**
 * Format a value for display based on its type
 */
export function formatDisplayValue(value: unknown, type: InferredFieldType): string {
  if (value === null || value === undefined) {
    return '';
  }

  switch (type) {
    case 'date':
      // Handle Date objects from js-yaml
      if (value instanceof Date) {
        if (!isNaN(value.getTime())) {
          return value.toLocaleDateString();
        }
        return String(value);
      }
      if (typeof value === 'string') {
        // Try to format as localized date
        try {
          const date = new Date(value);
          if (!isNaN(date.getTime())) {
            return date.toLocaleDateString();
          }
        } catch {
          // Fall through to return as-is
        }
      }
      return String(value);

    case 'boolean':
      return value ? 'Yes' : 'No';

    case 'array':
    case 'tags':
      if (Array.isArray(value)) {
        return value.join(', ');
      }
      return String(value);

    case 'object':
      return '[Object]';

    case 'link':
      return String(value);

    default:
      return String(value);
  }
}

/**
 * Parse frontmatter into inferred fields
 * Flattens nested objects with dot notation (up to MAX_NESTING_DEPTH levels)
 * Filters out tracker-specific fields and arrays of objects
 */
export function parseFields(frontmatter: Record<string, unknown>): InferredField[] {
  const fields: InferredField[] = [];

  // Flatten the frontmatter object, handling nested objects
  const flattened = flattenObject(frontmatter);

  for (const [key, value] of flattened) {
    const type = inferFieldType(key, value);

    fields.push({
      key,
      value,
      type,
      displayValue: formatDisplayValue(value, type),
    });
  }

  return fields;
}

/**
 * Update a field value in frontmatter content
 * Supports dot-notation keys for nested values (e.g., "author.name")
 */
export function updateFieldInFrontmatter(
  content: string,
  fieldKey: string,
  newValue: unknown
): string {
  const frontmatter = extractFrontmatter(content) || {};

  // Use setNestedValue to handle dot-notation keys
  const updated = setNestedValue(frontmatter, fieldKey, newValue);

  const yamlContent = jsyaml.dump(updated, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });

  // `\r?\n` tolerates Windows CRLF (nimbalyst#68).
  const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  const hasFrontmatter = frontmatterRegex.test(content);

  if (hasFrontmatter) {
    return content.replace(frontmatterRegex, `---\n${yamlContent}---\n`);
  } else {
    return `---\n${yamlContent}---\n${content}`;
  }
}

/**
 * Check if content has non-tracker frontmatter
 */
export function hasGenericFrontmatter(content: string): boolean {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return false;
  }

  // Skip if it's a tracker document (those get specialized UI)
  if (frontmatter.planStatus || frontmatter.decisionStatus || frontmatter.trackerStatus) {
    return false;
  }

  // Has frontmatter with at least one non-object field
  const fields = parseFields(frontmatter);
  return fields.length > 0;
}
