/**
 * Helper functions for tracker type operations.
 * Uses window.trackerRegistry when available for custom tracker support,
 * with hardcoded fallbacks for plan/decision.
 */

export interface TrackerTypeInfo {
  type: string;
  displayName: string;
  icon: string;
  color: string;
}

/**
 * Get built-in tracker types that support full-document mode
 */
export function getBuiltInFullDocumentTrackerTypes(): TrackerTypeInfo[] {
  return [
    {
      type: 'plan',
      displayName: 'Plan',
      icon: 'flag',
      color: '#3b82f6',
    },
    {
      type: 'decision',
      displayName: 'Decision',
      icon: 'gavel',
      color: '#8b5cf6',
    },
  ];
}

/**
 * Get the current tracker type from markdown content
 */
export function getCurrentTrackerTypeFromMarkdown(markdown: string): string | null {
  // `\r?\n` tolerates Windows CRLF (nimbalyst#68).
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = markdown.match(frontmatterRegex);

  if (!match) {
    return null;
  }

  const yamlContent = match[1];

  // Check for planStatus
  if (yamlContent.includes('planStatus:')) {
    return 'plan';
  }

  // Check for decisionStatus
  if (yamlContent.includes('decisionStatus:')) {
    return 'decision';
  }

  // Check for generic trackerStatus with type field
  const typeMatch = yamlContent.match(/trackerStatus:\s*\n\s+type:\s*(.+)/);
  if (typeMatch) {
    return typeMatch[1].trim().replace(/^["']|["']$/g, '');
  }

  return null;
}

/**
 * Get default frontmatter template for a tracker type.
 * For plan/decision returns legacy embedded fields.
 * For generic types returns empty - callers should pass model defaults to applyTrackerTypeToMarkdown.
 */
export function getDefaultFrontmatterForType(trackerType: string): Record<string, any> {
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  const generateId = (prefix: string) => {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  };

  if (trackerType === 'plan') {
    return {
      planId: generateId('plan'),
      title: '',
      status: 'draft',
      planType: 'feature',
      priority: 'medium',
      progress: 0,
      owner: '',
      stakeholders: [],
      tags: [],
      created: today,
      updated: now,
    };
  } else if (trackerType === 'decision') {
    return {
      decisionId: generateId('dec'),
      title: '',
      status: 'to-do',
      chosen: '',
      priority: 'medium',
      owner: '',
      stakeholders: [],
      tags: [],
      created: today,
      updated: now,
    };
  }

  return {};
}

function serializeYamlValue(value: any): string {
  if (Array.isArray(value)) return '[]';
  if (typeof value === 'string') return value === '' ? '""' : `"${value}"`;
  return String(value);
}

/**
 * Apply tracker type to markdown content.
 * For generic types: fields go at the top level, trackerStatus only holds type.
 * For plan/decision: legacy embedded format.
 * @param modelDefaults - Default field values from the tracker model (for generic types)
 */
export function applyTrackerTypeToMarkdown(
  markdown: string,
  trackerType: string,
  modelDefaults?: Record<string, any>,
): string {
  const isLegacy = trackerType === 'plan' || trackerType === 'decision';

  const yamlLines: string[] = [];

  if (isLegacy) {
    const frontmatterKey = trackerType === 'plan' ? 'planStatus' : 'decisionStatus';
    const defaultData = getDefaultFrontmatterForType(trackerType);
    yamlLines.push(`${frontmatterKey}:`);
    for (const [key, value] of Object.entries(defaultData)) {
      yamlLines.push(`  ${key}: ${serializeYamlValue(value)}`);
    }
  } else {
    // Generic: all fields at top level, trackerStatus only holds type
    if (modelDefaults) {
      for (const [key, value] of Object.entries(modelDefaults)) {
        yamlLines.push(`${key}: ${serializeYamlValue(value)}`);
      }
    }
    yamlLines.push(`trackerStatus:`);
    yamlLines.push(`  type: ${trackerType}`);
  }

  const yamlContent = yamlLines.join('\n');

  // `\r?\n` tolerates Windows CRLF (nimbalyst#68).
  const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  const hasFrontmatter = frontmatterRegex.test(markdown);

  if (hasFrontmatter) {
    return markdown.replace(frontmatterRegex, `---\n${yamlContent}\n---\n`);
  } else {
    return `---\n${yamlContent}\n---\n${markdown}`;
  }
}

/**
 * Build default field values from a tracker model's field definitions.
 * Accesses the global registry via window (set by the renderer).
 * Returns empty object if registry is unavailable or model not found.
 */
export function getModelDefaults(trackerType: string): Record<string, any> {
  try {
    const registry = (window as any).__trackerRegistry || (window as any).trackerRegistry;
    if (!registry?.get) return {};
    const model = registry.get(trackerType);
    if (!model?.fields) return {};

    const defaults: Record<string, any> = {};
    for (const field of model.fields) {
      if (field.name === 'title') continue; // title comes from the document
      if (field.default !== undefined) {
        defaults[field.name] = field.default;
      } else if (field.type === 'array') {
        defaults[field.name] = [];
      } else if (field.type === 'string' || field.type === 'user') {
        defaults[field.name] = '';
      } else if (field.type === 'number') {
        defaults[field.name] = field.min ?? 0;
      }
    }
    return defaults;
  } catch {
    return {};
  }
}

/**
 * Remove tracker type from markdown content
 */
export function removeTrackerTypeFromMarkdown(markdown: string): string {
  // `\r?\n` tolerates Windows CRLF (nimbalyst#68).
  const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  return markdown.replace(frontmatterRegex, '');
}
