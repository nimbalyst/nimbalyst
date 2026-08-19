import * as path from 'path';
import { BrowserWindow } from 'electron';
import type { TeamJwt } from '@nimbalyst/runtime/auth/jwtScopes';
import { shouldSyncTrackerItem, getEffectiveTrackerSharingPolicy } from '../../services/TrackerPolicyService';
import { ElectronDocumentService } from '../../services/ElectronDocumentService';
import { findLinkedDocumentForLocalPath } from '../../services/CollabLocalOriginService';
import {
  findTeamForWorkspace,
  getOrgScopedJwt,
  listMembersWithTeamJwt,
  type TeamDetails,
  type TeamMember,
} from '../../services/TeamService';
import { documentServices } from '../../window/WindowManager';
import { findWindowIdForWorkspacePath } from '../mcpWorkspaceResolver';
import { requestFromRenderer } from '../rendererRequest';

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

type DirectoryMember = {
  memberId: string;
  displayName: string;
  email: string;
};

type DirectoryStatus = 'listed' | 'matched' | 'ambiguous' | 'notFound' | 'noTeam';

export type OrgDirectoryResult = {
  status: DirectoryStatus;
  message: string;
  org: { orgId: string; name: string; teamProjectId?: string } | null;
  members: DirectoryMember[];
};

export type ResourceSharingKind = 'document' | 'tracker' | 'file' | 'session';

export type ResourceSharingResult = {
  kind: ResourceSharingKind;
  sourceId: string;
  teamVisible: boolean;
  orgId: string | null;
  reason: 'shared' | 'notShared' | 'notFound' | 'noTeam';
};

type DirectoryDependencies = {
  findTeam(workspacePath: string): Promise<TeamDetails | null>;
  getTeamJwt(orgId: string): Promise<TeamJwt>;
  listMembers(orgId: string, teamJwt: TeamJwt): Promise<{ members: TeamMember[] }>;
};

type SharingDependencies = {
  findTeam(workspacePath: string): Promise<TeamDetails | null>;
  readDocument(sourceId: string, workspacePath: string): Promise<ResourceSharingResult>;
  readTracker(sourceId: string, workspacePath: string): Promise<{ found: boolean; teamVisible: boolean }>;
  findLinkedDocument(workspacePath: string, sourceFilePath: string): Promise<{ orgId: string } | null>;
};

const directoryDependencies: DirectoryDependencies = {
  findTeam: findTeamForWorkspace,
  getTeamJwt: getOrgScopedJwt,
  listMembers: listMembersWithTeamJwt,
};

const sharingDependencies: SharingDependencies = {
  findTeam: findTeamForWorkspace,
  readDocument: readSharedDocumentFromRenderer,
  readTracker: readTrackerSharing,
  findLinkedDocument: findLinkedDocumentForLocalPath,
};

export function getCollabReadToolSchemas() {
  return [
    {
      name: 'findOrgMembers',
      description:
        "Use this before addressing, mentioning, assigning, or asking a person in the current workspace's organization by name or email. With query omitted it lists addressable organization members; with query it returns one explicit status: matched, ambiguous (for example, two Karls), notFound, or noTeam. Never guess between ambiguous people. Results include each member's stable organization member id, display name, and email. This is a read-only team-directory lookup and always requires team-scoped authorization.",
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional name or email fragment to look up. Omit to list all addressable members.',
          },
        },
      },
    },
    {
      name: 'getResourceSharingStatus',
      description:
        "Use this before sending a resource to an organization member, requesting feedback on it, or deciding whether the user must publish it first. Read-only: reports whether an existing document, tracker item, workspace file, or AI session is currently team-visible and the organization id when it is. Reads the existing shared-document index, tracker publication policy, and shared-document file bindings; it never publishes or changes the resource.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['document', 'tracker', 'file', 'session'],
            description: "ResourceRef kind to inspect. 'file' sourceId is workspace-relative or an absolute path inside the workspace.",
          },
          sourceId: {
            type: 'string',
            description: 'Stable resource id: document id, tracker item id, workspace file path, or session id.',
          },
        },
        required: ['kind', 'sourceId'],
      },
    },
  ];
}

function result(value: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError: false,
  };
}

function requireWorkspacePath(workspacePath: string | undefined, toolName: string): string {
  if (!workspacePath?.trim()) {
    throw new Error(`${toolName} requires an explicit workspacePath.`);
  }
  return workspacePath;
}

function directoryMember(member: TeamMember): DirectoryMember {
  return {
    memberId: member.memberId,
    displayName: member.name?.trim() || member.email,
    email: member.email,
  };
}

export function matchOrgMembers(
  team: Pick<TeamDetails, 'orgId' | 'name' | 'teamProjectId'>,
  members: TeamMember[],
  query?: string,
): OrgDirectoryResult {
  const addressable = members
    .filter((member) => member.status !== 'pending')
    .map(directoryMember)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.email.localeCompare(b.email));
  const org = {
    orgId: team.orgId,
    name: team.name,
    ...(team.teamProjectId ? { teamProjectId: team.teamProjectId } : {}),
  };
  const normalizedQuery = query?.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return {
      status: 'listed',
      message: addressable.length === 0
        ? `${team.name} has no addressable members.`
        : `Found ${addressable.length} addressable member(s) in ${team.name}.`,
      org,
      members: addressable,
    };
  }

  const matches = addressable.filter((member) =>
    member.displayName.toLocaleLowerCase().includes(normalizedQuery)
    || member.email.toLocaleLowerCase().includes(normalizedQuery));

  if (matches.length === 0) {
    return {
      status: 'notFound',
      message: `No addressable member matching "${query?.trim()}" is in ${team.name}.`,
      org,
      members: [],
    };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      message: `${matches.length} members in ${team.name} match "${query?.trim()}". Ask which person before continuing.`,
      org,
      members: matches,
    };
  }
  return {
    status: 'matched',
    message: `Matched one member in ${team.name}.`,
    org,
    members: matches,
  };
}

export async function loadOrgDirectory(
  workspacePath: string,
  query: string | undefined,
  dependencies: DirectoryDependencies = directoryDependencies,
): Promise<OrgDirectoryResult> {
  const team = await dependencies.findTeam(workspacePath);
  if (!team) {
    return {
      status: 'noTeam',
      message: 'This workspace has no current organization, so there are no organization members to address.',
      org: null,
      members: [],
    };
  }

  const teamJwt = await dependencies.getTeamJwt(team.orgId);
  const roster = await dependencies.listMembers(team.orgId, teamJwt);
  return matchOrgMembers(team, roster.members, query);
}

export async function handleFindOrgMembers(
  args: unknown,
  workspacePath: string | undefined,
  dependencies: DirectoryDependencies = directoryDependencies,
): Promise<McpToolResult> {
  const workspace = requireWorkspacePath(workspacePath, 'findOrgMembers');
  const input = args as { query?: unknown } | null;
  if (input?.query !== undefined && typeof input.query !== 'string') {
    throw new Error('findOrgMembers query must be a string when provided.');
  }
  return result(await loadOrgDirectory(workspace, input?.query, dependencies));
}

async function readTrackerSharing(
  sourceId: string,
  workspacePath: string,
): Promise<{ found: boolean; teamVisible: boolean }> {
  let service = documentServices.get(workspacePath);
  let temporaryService: ElectronDocumentService | null = null;
  if (!service) {
    temporaryService = new ElectronDocumentService(workspacePath);
    service = temporaryService;
  }
  try {
    const item = await service.getTrackerItemById(sourceId);
    if (!item) return { found: false, teamVisible: false };
    const policy = getEffectiveTrackerSharingPolicy(workspacePath, item.type);
    return { found: true, teamVisible: shouldSyncTrackerItem(policy, item) };
  } finally {
    temporaryService?.destroy();
  }
}

async function readSharedDocumentFromRenderer(
  sourceId: string,
  workspacePath: string,
): Promise<ResourceSharingResult> {
  const windowId = await findWindowIdForWorkspacePath(workspacePath);
  const window = windowId ? BrowserWindow.fromId(windowId) : null;
  if (!window || window.isDestroyed()) {
    throw new Error('getResourceSharingStatus requires an open window for the requested workspace.');
  }

  const outcome = await requestFromRenderer<{ success: boolean; result?: ResourceSharingResult; error?: string }>(
    window,
    'mcp:getResourceSharingStatus',
    { sourceId },
    { timeoutMs: 5000, resultChannelPrefix: 'mcp-resource-sharing' },
  );
  if (outcome.status === 'timedOut') {
    throw new Error('Timed out while reading the shared-document index.');
  }

  const response = outcome.response;
  if (!response?.success || !response.result) {
    throw new Error(response?.error || 'The shared-document index did not return a result.');
  }
  return response.result;
}

export async function readResourceSharingStatus(
  kind: ResourceSharingKind,
  sourceId: string,
  workspacePath: string,
  dependencies: SharingDependencies = sharingDependencies,
): Promise<ResourceSharingResult> {
  if (kind === 'document') {
    return dependencies.readDocument(sourceId, workspacePath);
  }
  if (kind === 'session') {
    return { kind, sourceId, teamVisible: false, orgId: null, reason: 'notShared' };
  }
  if (kind === 'file') {
    // No containment check here on purpose: findLinkedDocumentForLocalPath
    // re-derives the workspace-relative path and rejects anything that lands
    // outside the workspace, so a `..` sourceId errors instead of reporting on
    // another project's file.
    const sourceFilePath = path.isAbsolute(sourceId) ? sourceId : path.resolve(workspacePath, sourceId);
    const binding = await dependencies.findLinkedDocument(workspacePath, sourceFilePath);
    return binding
      ? { kind, sourceId, teamVisible: true, orgId: binding.orgId, reason: 'shared' }
      : { kind, sourceId, teamVisible: false, orgId: null, reason: 'notShared' };
  }

  const tracker = await dependencies.readTracker(sourceId, workspacePath);
  if (!tracker.found) {
    return { kind, sourceId, teamVisible: false, orgId: null, reason: 'notFound' };
  }
  if (!tracker.teamVisible) {
    return { kind, sourceId, teamVisible: false, orgId: null, reason: 'notShared' };
  }
  const team = await dependencies.findTeam(workspacePath);
  return team
    ? { kind, sourceId, teamVisible: true, orgId: team.orgId, reason: 'shared' }
    : { kind, sourceId, teamVisible: false, orgId: null, reason: 'noTeam' };
}

export async function handleGetResourceSharingStatus(
  args: unknown,
  workspacePath: string | undefined,
  dependencies: SharingDependencies = sharingDependencies,
): Promise<McpToolResult> {
  const workspace = requireWorkspacePath(workspacePath, 'getResourceSharingStatus');
  const input = args as { kind?: unknown; sourceId?: unknown } | null;
  if (!['document', 'tracker', 'file', 'session'].includes(String(input?.kind))) {
    throw new Error("getResourceSharingStatus kind must be 'document', 'tracker', 'file', or 'session'.");
  }
  const sourceId = typeof input?.sourceId === 'string' ? input.sourceId.trim() : '';
  if (!sourceId) {
    throw new Error('getResourceSharingStatus requires a non-empty sourceId.');
  }
  return result(await readResourceSharingStatus(
    input!.kind as ResourceSharingKind,
    sourceId,
    workspace,
    dependencies,
  ));
}
