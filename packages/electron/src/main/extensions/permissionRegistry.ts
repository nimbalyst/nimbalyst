/**
 * Permission Registry - the single source of truth for extension capability ids.
 *
 * Owned by core. Extensions reference ids; they cannot register new ones.
 * Adding a new id is a coordinated host change: update PERMISSION_CATALOG here
 * AND update the `ExtensionPermissionId` union in
 * `packages/extension-sdk/src/types/permissions.ts`.
 *
 * The catalog is the actual security surface presented to the user via the
 * consent prompt. Permission descriptions must be readable from the user's
 * perspective, not the implementation's.
 */

import type {
  ExtensionPermissionId,
  PermissionRiskTier,
} from '@nimbalyst/extension-sdk';

/**
 * Current registry schema version. Stored on every grant row so future
 * permission renames / restructures can migrate grants without losing user
 * intent.
 */
export const PERMISSION_REGISTRY_VERSION = 1;

export interface PermissionDescriptor {
  id: ExtensionPermissionId;
  /** Short human label shown in the consent prompt header */
  label: string;
  /** One-sentence plain-language description shown verbatim to the user */
  description: string;
  /** Risk tier - groups permissions visually in the consent prompt */
  risk: PermissionRiskTier;
}

const CATALOG: readonly PermissionDescriptor[] = [
  {
    id: 'workspace-files',
    label: 'Workspace files',
    description: 'Read and write files inside the current workspace.',
    risk: 'low',
  },
  {
    id: 'mcp-server-register',
    label: 'Register MCP tools',
    description: 'Expose extension-defined MCP tools to the AI agent.',
    risk: 'elevated',
  },
  {
    id: 'nimbalyst-database-read',
    label: 'Read Nimbalyst database',
    description: "Read Nimbalyst's local PGLite store (sessions, documents, trackers).",
    risk: 'high',
  },
  {
    id: 'nimbalyst-database-write',
    label: 'Write Nimbalyst database',
    description: "Modify Nimbalyst's local PGLite store. Can change sessions, documents, trackers.",
    risk: 'high',
  },
  {
    id: 'secrets-read',
    label: 'Read secrets',
    description: 'Read stored credentials, API keys, and other secrets.',
    risk: 'high',
  },
] as const;

const CATALOG_BY_ID: Map<ExtensionPermissionId, PermissionDescriptor> = new Map(
  CATALOG.map((d) => [d.id, d])
);

/**
 * All permission descriptors in canonical order (low -> elevated -> high).
 * The order matches the consent prompt's intended visual order.
 */
export function listPermissionDescriptors(): readonly PermissionDescriptor[] {
  return CATALOG;
}

/**
 * Look up a single descriptor. Returns undefined for unknown ids; callers
 * that receive ids from a manifest should treat unknown ids as a validation
 * error rather than a silent skip.
 */
export function getPermissionDescriptor(
  id: string
): PermissionDescriptor | undefined {
  return CATALOG_BY_ID.get(id as ExtensionPermissionId);
}

/**
 * Type guard - narrows an arbitrary string to a known permission id.
 */
export function isKnownPermissionId(id: string): id is ExtensionPermissionId {
  return CATALOG_BY_ID.has(id as ExtensionPermissionId);
}

/**
 * Group descriptors by risk tier in the canonical render order.
 * Used by the first-use prompt to render visually grouped sections.
 */
export function groupByRisk(
  ids: readonly ExtensionPermissionId[]
): Record<PermissionRiskTier, PermissionDescriptor[]> {
  const groups: Record<PermissionRiskTier, PermissionDescriptor[]> = {
    low: [],
    elevated: [],
    high: [],
  };
  for (const id of ids) {
    const descriptor = CATALOG_BY_ID.get(id);
    if (descriptor) {
      groups[descriptor.risk].push(descriptor);
    }
  }
  return groups;
}
