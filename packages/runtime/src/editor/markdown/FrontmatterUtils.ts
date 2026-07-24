/**
 * Frontmatter utilities for managing metadata in Lexical documents.
 * Provides functions to parse and serialize frontmatter while storing it
 * in the Lexical root node's NodeState.
 *
 * Uses jxson/front-matter for browser-compatible YAML parsing.
 */

import frontMatter from 'front-matter';
import * as yaml from 'js-yaml';
import { $getRoot, $getState, $setState, createState } from 'lexical';

export interface FrontmatterData {
  [key: string]: any;
}

/**
 * Create a state configuration for frontmatter storage.
 * This properly integrates with Lexical's state management system.
 */
const frontmatterState = createState('frontmatter', {
  parse: (value: unknown): FrontmatterData | null => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value as FrontmatterData;
    }
    return null;
  }
});

/**
 * Stores frontmatter data in the root node's NodeState.
 * This data will be preserved during editor operations, collaboration, and reconciliation.
 */
export function $setFrontmatter(data: FrontmatterData | null): void {
  const root = $getRoot();
  $setState(root, frontmatterState, data);
}

/**
 * Retrieves frontmatter data from the root node's NodeState.
 * Returns null if no frontmatter is stored.
 */
export function $getFrontmatter(): FrontmatterData | null {
  const root = $getRoot();
  return $getState(root, frontmatterState);
}

/**
 * Parses markdown content with optional frontmatter.
 * Returns the content without frontmatter and the parsed frontmatter data.
 */
export function parseFrontmatter(markdown: string): {
  content: string;
  data: FrontmatterData | null;
  orig?: string;
} {
  try {
    const parsed = frontMatter(markdown);

    // Check if frontmatter actually exists
    const hasFrontmatter = parsed.frontmatter &&
      typeof parsed.frontmatter === 'string' &&
      parsed.frontmatter.trim().length > 0;

    return {
      content: parsed.body,
      data: hasFrontmatter && parsed.attributes && Object.keys(parsed.attributes).length > 0
        ? parsed.attributes
        : null,
      orig: markdown,
    };
  } catch (error) {
    // If frontmatter parsing fails, try to extract what we can manually
    if (markdown.startsWith('---\n')) {
      const endIndex = markdown.indexOf('\n---\n', 4);
      if (endIndex !== -1) {
        const frontmatterText = markdown.substring(4, endIndex);
        const content = markdown.substring(endIndex + 5);

        // Try to parse line-by-line and extract what we can
        const data: FrontmatterData = {};
        const lines = frontmatterText.split('\n');

        for (const line of lines) {
          // Simple key: value parsing that's more forgiving
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim();
            const valueStr = line.substring(colonIndex + 1).trim();

            if (key && !key.includes(' ')) { // Simple keys only
              // Try to parse the value
              let value: any = valueStr;

              // Remove quotes if present
              if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
                  (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
                value = valueStr.slice(1, -1);
              } else if (valueStr === 'true') {
                value = true;
              } else if (valueStr === 'false') {
                value = false;
              } else if (valueStr === 'null' || valueStr === '') {
                value = null;
              } else if (/^-?\d+$/.test(valueStr)) {
                value = parseInt(valueStr, 10);
              } else if (/^-?\d+\.\d+$/.test(valueStr)) {
                value = parseFloat(valueStr);
              }

              data[key] = value;
            }
          }
        }

        console.warn('Partially parsed malformed frontmatter:', error, 'Extracted:', data);
        return {
          content,
          data: Object.keys(data).length > 0 ? data : null,
          orig: markdown,
        };
      }
    }

    // If we can't find frontmatter boundaries, treat entire content as body
    console.warn('No frontmatter boundaries found, treating entire content as body:', error);
    return {
      content: markdown,
      data: null,
    };
  }
}

/**
 * Serializes content with optional frontmatter.
 * If frontmatter data is provided, it will be added to the beginning of the content.
 */
export function serializeWithFrontmatter(
  content: string,
  data: FrontmatterData | null
): string {
  if (!data || Object.keys(data).length === 0) {
    return content;
  }

  try {
    // Use js-yaml for proper YAML serialization
    const yamlStr = yaml.dump(data, {
      lineWidth: -1, // Don't wrap lines
      sortKeys: false, // Preserve key order
      quotingType: '"', // Use double quotes when needed
      forceQuotes: false, // Only quote when necessary
    });

    // Ensure proper formatting with --- markers
    // Remove trailing newline from yaml.dump since it adds one
    const trimmedYaml = yamlStr.trimEnd();

    // Only add a newline at the start of content if it doesn't already have one
    const contentPrefix = content.startsWith('\n') ? '' : '\n';

    return `---\n${trimmedYaml}\n---${contentPrefix}${content}`;
  } catch (error) {
    console.warn('Failed to serialize frontmatter:', error);
    return content;
  }
}

/**
 * Checks if a markdown string contains frontmatter.
 */
export function hasFrontmatter(markdown: string): boolean {
  return /^---\s*\n/.test(markdown);
}

/**
 * Validates frontmatter data structure.
 */
export function isValidFrontmatter(data: any): data is FrontmatterData {
  return (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    // Ensure it's a plain object
    Object.getPrototypeOf(data) === Object.prototype
  );
}