/**
 * Utility functions for parsing and serializing node attributes
 * Used for custom syntax like: {classification="thinking" open="false" readOnly="true"}
 */

export interface ParsedAttributes {
    [key: string]: any;
}

/**
 * Parse attributes from curly braces: {classification="thinking" open="false"}
 * Supports both quoted and unquoted values
 * Automatically converts "true"/"false" strings to booleans
 */
export function parseAttributes(attributeString: string): ParsedAttributes {
    const attributes: ParsedAttributes = {};

    if (!attributeString) return attributes;

    // Remove outer braces if present
    const cleanString = attributeString.replace(/^\{|\}$/g, '');

    // Match key="value" or key=value patterns
    const attributeRegex = /(\w+)=(?:"([^"]*)"|([^\s]+))/g;
    let match;

    while ((match = attributeRegex.exec(cleanString)) !== null) {
        const key = match[1];
        const value = match[2] || match[3];

        // Convert boolean strings
        if (value === 'true') {
            attributes[key] = true;
        } else if (value === 'false') {
            attributes[key] = false;
        } else if (!isNaN(Number(value)) && value !== '') {
            // Convert numeric strings to numbers
            attributes[key] = Number(value);
        } else {
            attributes[key] = value;
        }
    }

    return attributes;
}

/**
 * Serialize attributes back to string format
 * @param attributes - Object with attribute key-value pairs
 * @param includeBraces - Whether to wrap in curly braces (default: true)
 */
export function serializeAttributes(
    attributes: ParsedAttributes,
    includeBraces: boolean = true
): string {
    const attrs: string[] = [];

    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null) {
            continue;
        }

        // Quote string values, leave numbers and booleans unquoted
        if (typeof value === 'string' && value.includes(' ')) {
            attrs.push(`${key}="${value}"`);
        } else if (typeof value === 'string') {
            attrs.push(`${key}="${value}"`);
        } else {
            attrs.push(`${key}=${value}`);
        }
    }

    const result = attrs.join(' ');
    return includeBraces && result ? `{${result}}` : result;
}

/**
 * Parse attributes with special key mappings for backwards compatibility
 * @param attributeString - The attribute string to parse
 * @param keyMappings - Map of input keys to output keys (e.g., {'open': 'isOpen'})
 */
export function parseAttributesWithMappings(
    attributeString: string,
    keyMappings: Record<string, string> = {}
): ParsedAttributes {
    const attributes = parseAttributes(attributeString);
    const mappedAttributes: ParsedAttributes = {};

    for (const [key, value] of Object.entries(attributes)) {
        const mappedKey = keyMappings[key] || key;
        mappedAttributes[mappedKey] = value;
    }

    return mappedAttributes;
}

/**
 * Serialize attributes with reverse key mappings
 * @param attributes - Object with attribute key-value pairs
 * @param keyMappings - Map of internal keys to output keys (e.g., {'isOpen': 'open'})
 * @param includeBraces - Whether to wrap in curly braces (default: true)
 */
export function serializeAttributesWithMappings(
    attributes: ParsedAttributes,
    keyMappings: Record<string, string> = {},
    includeBraces: boolean = true
): string {
    const mappedAttributes: ParsedAttributes = {};

    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null) {
            continue;
        }
        const mappedKey = keyMappings[key] || key;
        mappedAttributes[mappedKey] = value;
    }

    return serializeAttributes(mappedAttributes, includeBraces);
}

/**
 * Common attribute patterns for different node types
 */
export const ATTRIBUTE_PATTERNS = {
    // For collapsible nodes
    collapsible: {
        keyMappings: {
            'open': 'isOpen'
        }
    },

    // For other potential node types
    diagram: {
        keyMappings: {
            'type': 'diagramType',
            'theme': 'diagramTheme'
        }
    }
} as const;
