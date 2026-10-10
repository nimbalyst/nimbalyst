/**
 * The Wiki agent tools as one contract: the tools a terminal agent reaches on
 * the remote MCP server (`/mcp`), with the same names and arguments as the
 * desktop agent's tools, so one skill text serves both.
 *
 * Every tool here is offered remotely. A `shared` tool is also a desktop tool:
 * its `inputSchema` holds the desktop's arguments with the desktop's shapes
 * (the electron parity test compares them), minus `desktopOnlyArgs`, plus
 * `remoteOnlyArgs`. A `remoteOnly` tool exists only on the server (binding a
 * repo to a team project). Every remote tool also takes `repo` and `project`,
 * which pick the team project; `remoteToolDefinitions()` adds them.
 *
 * The remote server works on team pages only: `remoteAcceptedValues` names the
 * argument values it accepts (`section: team`), and `remoteArgumentRefusal`
 * is the one place a call outside them is refused, so the server and the CLI
 * say the same thing.
 *
 * Pure and dependency-free: imported by the desktop main process (parity
 * test), the sync worker and the CLI.
 */

import type { ConsoleLinkScope, ConsoleTeamScope } from './consoleLinks.js';
import type { PageFields } from './pageFields.js';

export type PageToolJsonSchema = { readonly [key: string]: unknown };

export interface PageToolInputSchema {
  type: 'object';
  properties: Readonly<Record<string, PageToolJsonSchema>>;
  required?: readonly string[];
}

export type PageToolAvailability = 'shared' | 'remoteOnly';

export interface PageToolAcceptedValues {
  values: readonly string[];
  /** Said to the agent when it passes another value. */
  message: string;
}

export interface PageToolContract {
  name: PageToolName;
  availability: PageToolAvailability;
  readOnly: boolean;
  /** The remote tool's description. */
  description: string;
  inputSchema: PageToolInputSchema;
  /** Desktop arguments the remote server refuses. */
  desktopOnlyArgs?: readonly string[];
  /** Arguments only the remote server takes (besides `repo` and `project`). */
  remoteOnlyArgs?: readonly string[];
  /** Arguments whose values the remote server narrows; an array argument is checked per element. */
  remoteAcceptedValues?: Readonly<Record<string, PageToolAcceptedValues>>;
  /**
   * The desktop tool takes `project` as `PAGE_TOOL_DESKTOP_PROJECT_ARG` (another
   * project in the window's org, by id or name) to read it. Read tools only:
   * desktop writes go to the current project. Remotely every tool takes
   * `project` as `PAGE_TOOL_PROJECT_ARG` instead.
   */
  desktopProjectArg?: true;
}

export const PAGE_TOOL_NAMES = [
  'pages_status',
  'pages_bind_repo',
  'pages_create_project',
  'listPages',
  'searchPages',
  'readCollabDoc',
  'applyCollabDocEdit',
  'createSharedDoc',
  'createSharedFolder',
  'moveSharedItem',
  'renameSharedItem',
  'deleteSharedItem',
  'setPageType',
  'setPageFields',
  'findOrgMembers',
  'tracker_list_types',
  'tracker_define_type',
  'tracker_list',
  'tracker_get',
  'tracker_create',
  'tracker_update',
  'list_citable_inputs',
] as const;

export type PageToolName = (typeof PAGE_TOOL_NAMES)[number];

export function isPageToolName(name: string): name is PageToolName {
  return (PAGE_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Picks the team project: the git remote it is bound to. */
export const PAGE_TOOL_REPO_ARG = {
  type: 'string',
  description: 'Output of `git remote get-url origin`. Omit it for a checkout with no remote and pass `project` instead.',
} as const;

/** Picks the team project directly; wins over `repo` when the caller can access it. */
export const PAGE_TOOL_PROJECT_ARG = {
  type: 'object',
  description: 'The team project to act on, { orgId, projectId }, from .nimbalyst/wiki.json. Wins over the repo lookup when you can access it.',
  properties: { orgId: { type: 'string' }, projectId: { type: 'string' } },
  required: ['orgId', 'projectId'],
} as const;

/** The desktop read tools' `project`: another project in the window's org. */
export const PAGE_TOOL_DESKTOP_PROJECT_ARG = {
  type: 'string',
  description: "Read another project in this workspace's team instead of the current one: its project id or name (listPages names the team's other projects). Omit for the current project. Changes always go to the current project.",
} as const;

const SECTION = {
  type: 'string',
  enum: ['team', 'personal'],
  description: "Wiki section. Only 'team' here; Personal pages live in the desktop app.",
} as const;

const TEAM_SECTION_ONLY: Readonly<Record<string, PageToolAcceptedValues>> = {
  section: { values: ['team'], message: 'Personal pages live in the desktop app.' },
};

const PARENT_KIND = {
  type: 'string',
  enum: ['page', 'item'],
  description: "What the parent id names: a page, or a typed page ('item'). Inferred from the id when omitted.",
} as const;

const BESIDE = "Tree node id from listPages (e.g. 'document:<id>', 'item:<id>', 'type:<id>'), or a bare page id, issue key or type id.";

const PAGE_URI = {
  type: 'string',
  description: "The page's uri from listPages (collab://org:<o>:doc:<id>, or collab://tracker-content/<itemId> for a typed page's body), or its console link.",
} as const;

const PARENT_ID = {
  type: 'string',
  description: 'Parent page id, or typed page id / issue key. Omit for the top of the section.',
} as const;

const stringArray = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const PAGE_TOOL_CONTRACT: readonly PageToolContract[] = [
  {
    name: 'pages_status',
    availability: 'remoteOnly',
    readOnly: true,
    description:
      "Which team project this repository's pages belong to, and who you are signed in as. Returns state bound (use it), ambiguous (several projects: ask the user which, write { orgId, projectId } to .nimbalyst/wiki.json and pass it as `project`), or unbound (a team admin can bind it with pages_bind_repo or pages_create_project; anyone else should ask a team admin). A bound result carries the Home page link and the guide page link when the project has one.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pages_bind_repo',
    availability: 'remoteOnly',
    readOnly: false,
    description: 'Team admins only. Bind this repository to an existing team project.',
    inputSchema: {
      type: 'object',
      properties: { repo: PAGE_TOOL_REPO_ARG, orgId: { type: 'string' }, projectId: { type: 'string' } },
      required: ['repo', 'orgId', 'projectId'],
    },
  },
  {
    name: 'pages_create_project',
    availability: 'remoteOnly',
    readOnly: false,
    description: 'Team admins only. Create a team project with a Home page, and bind this repository to it when `repo` is a remote.',
    inputSchema: {
      type: 'object',
      properties: { orgId: { type: 'string' }, name: { type: 'string', description: 'The project name.' } },
      required: ['orgId', 'name'],
    },
  },
  {
    name: 'listPages',
    availability: 'shared',
    readOnly: true,
    description:
      "List the project's pages as a paginated tree (100 nodes by default, maximum 500): use nextCursor with the same query until truncated is false; changed trees require restarting. Supports root/maxDepth/kinds and compact projection. Nodes include childCount and available updatedAt/hasContent. Pages, placed types and typed pages, each with nodeId, kind, id, title, parentNodeId, depth, sortOrder and the https link to write in page content (types also a viewLink); pages carry the uri to read and edit their body, typed pages their issueKey and whether they are placed outside their type.",
    inputSchema: { type: 'object', properties: {
      section: SECTION,
      root: { type: 'string', description: 'Only this subtree, including its root: nodeId, page id, type id, or typed-page issue key.' },
      maxDepth: { type: 'integer', minimum: 0, maximum: 100, description: 'Depth below the root (0 returns the root only; without root, top-level nodes only).' },
      kinds: { type: 'array', minItems: 1, items: { type: 'string', enum: ['page', 'typedPage', 'type'] } },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum nodes per response. Default 100; at most 500.' },
      cursor: { type: 'string', description: 'nextCursor from the previous response. Keep the same query; restart if the tree changes.' },
      projection: { type: 'string', enum: ['full', 'compact'], description: 'Compact omits content links; full (default) preserves all navigation fields.' },
    } },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
    desktopProjectArg: true,
  },
  {
    name: 'searchPages',
    availability: 'shared',
    readOnly: true,
    description:
      "Search the project's pages by the text in their bodies and their titles: pages, typed pages and type pages. Every word must match; the last also matches as a word start. Returns the best matches first, each with kind, title, uri to read with readCollabDoc, the https link to write in page content, and a snippet of the matching text. Use it to find what the pages say about a topic (for example what was decided about X) before reading pages one by one.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find.' },
        section: SECTION,
        limit: { type: 'number', description: 'At most this many results (default 20, at most 50).' },
      },
      required: ['query'],
    },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
    desktopProjectArg: true,
  },
  {
    name: 'readCollabDoc',
    availability: 'shared',
    readOnly: true,
    description: "Read a page's body as markdown, from the shared document every collaborator sees.",
    inputSchema: { type: 'object', properties: { filePath: PAGE_URI }, required: ['filePath'] },
    desktopOnlyArgs: ['includeDecisionState'],
    desktopProjectArg: true,
  },
  {
    name: 'applyCollabDocEdit',
    availability: 'shared',
    readOnly: false,
    description:
      "Apply exact text replacements to a page's body. Collaborators see the change live and the page history keeps the version before it. Call readCollabDoc first; a replacement whose oldText is not found fails the whole call.",
    inputSchema: {
      type: 'object',
      properties: {
        filePath: PAGE_URI,
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Text to replace (must match the page content exactly).' },
              newText: { type: 'string', description: 'Replacement text.' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['filePath', 'replacements'],
    },
  },
  {
    name: 'createSharedDoc',
    availability: 'shared',
    readOnly: false,
    description:
      'Create a page, under a page, under a typed page, or at the top of the project. Returns the documentId, the uri of its body and the https link to it.',
    inputSchema: {
      type: 'object',
      properties: {
        section: SECTION,
        title: { type: 'string', description: 'The page title, a bare name (no parent path, no .md).' },
        documentType: { type: 'string', description: "Only 'markdown' here." },
        parentFolderId: PARENT_ID,
        parentKind: PARENT_KIND,
        folderPath: { type: 'string', description: "Parent by titles ('Architecture/Overview'); missing pages are created empty. Takes precedence over parentFolderId." },
        initialContent: { type: 'string', description: 'Markdown body the page is created with.' },
        before: { type: 'string', description: `Place the new page just before this sibling. ${BESIDE}` },
        after: { type: 'string', description: `Place the new page just after this sibling. ${BESIDE}` },
      },
      required: ['title'],
    },
    remoteAcceptedValues: {
      ...TEAM_SECTION_ONLY,
      documentType: { values: ['markdown'], message: 'Only markdown pages can be created here.' },
    },
  },
  {
    name: 'createSharedFolder',
    availability: 'shared',
    readOnly: false,
    description: 'Create an empty page that will hold child pages (createSharedDoc with no body). Returns its page id as folderId.',
    inputSchema: {
      type: 'object',
      properties: {
        section: SECTION,
        name: { type: 'string', description: 'The page title, a bare name.' },
        parentFolderId: PARENT_ID,
        parentKind: PARENT_KIND,
        folderPath: { type: 'string', description: "The PARENT by titles ('A/B'); missing pages are created. Takes precedence over parentFolderId." },
      },
      required: ['name'],
    },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
  },
  {
    name: 'moveSharedItem',
    availability: 'shared',
    readOnly: false,
    description:
      "Move or reorder a node in the page tree: a page (kind 'doc', 'folder' or 'page'), a typed page ('item': places it under a page or typed page, or back under its type with underType), or a type ('type': place the type, or move its placement). Give a new parent, or before/after a sibling to reorder. Refuses a move that would put a node inside itself.",
    inputSchema: {
      type: 'object',
      properties: {
        section: SECTION,
        itemId: { type: 'string', description: 'Page id, typed page id or issue key, or type id.' },
        kind: { type: 'string', enum: ['doc', 'folder', 'page', 'item', 'type'], description: "What itemId names. 'doc', 'folder' and 'page' all mean a page." },
        newParentFolderId: { type: 'string', description: 'New parent page id, or typed page id / issue key. Omit for the top of the project.' },
        parentKind: PARENT_KIND,
        folderPath: { type: 'string', description: "New parent by titles ('A/B'); missing pages are created. Takes precedence over newParentFolderId." },
        before: { type: 'string', description: `Move just before this sibling (its parent becomes the parent). ${BESIDE}` },
        after: { type: 'string', description: `Move just after this sibling. ${BESIDE}` },
        underType: { type: 'boolean', description: 'Typed page only: send it back under its type.' },
      },
      required: ['itemId', 'kind'],
    },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
  },
  {
    name: 'renameSharedItem',
    availability: 'shared',
    readOnly: false,
    description: 'Rename a page. Stores the bare name. A typed page is renamed with tracker_update (title).',
    inputSchema: {
      type: 'object',
      properties: {
        section: SECTION,
        itemId: { type: 'string', description: 'The page id.' },
        kind: { type: 'string', enum: ['doc', 'folder', 'page'], description: 'Always a page; kept for older callers.' },
        newName: { type: 'string', description: 'The new title, a bare name (no parent path).' },
      },
      required: ['itemId', 'newName'],
    },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
  },
  {
    name: 'deleteSharedItem',
    availability: 'shared',
    readOnly: false,
    description:
      "Delete a page by moving it to Trash, where a person can restore it. kind 'folder' moves the page with every page under it to Trash; kind 'doc' moves only a page that has no children to Trash. Ask a person before deleting a page someone else wrote.",
    inputSchema: {
      type: 'object',
      properties: {
        section: SECTION,
        itemId: { type: 'string', description: 'The page id.' },
        kind: { type: 'string', enum: ['doc', 'folder'], description: "'folder' for the page with its whole subtree, 'doc' for a page with no children." },
      },
      required: ['itemId', 'kind'],
    },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
  },
  {
    name: 'setPageType',
    availability: 'shared',
    readOnly: false,
    description:
      'Give a plain page a type in place: it becomes a typed page of that type with the same title, body, position and children, and the plain page is removed once the copy is verified. Returns the new item id.',
    inputSchema: {
      type: 'object',
      properties: {
        section: SECTION,
        pageId: { type: 'string', description: "The plain page's id." },
        typeId: { type: 'string', description: "A type from tracker_list_types." },
      },
      required: ['pageId', 'typeId'],
    },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
  },
  {
    name: 'setPageFields',
    availability: 'shared',
    readOnly: false,
    description:
      "Set a plain page's own fields: owner (a member's email from findOrgMembers), status (draft, current or outdated), summary (one line, at most 280 characters) and tags. Only the fields you pass change; null clears one. A value that does not fit is ignored, so the reply names the fields the page has now. listPages shows them on each page. A typed page's fields are set with tracker_update.",
    inputSchema: {
      type: 'object',
      properties: {
        section: SECTION,
        itemId: { type: 'string', description: 'The page id.' },
        fields: {
          type: 'object',
          description: 'The fields to change. Null clears one.',
          properties: {
            owner: { type: ['string', 'null'], description: "The owner's email." },
            status: { type: ['string', 'null'], enum: ['draft', 'current', 'outdated', null] },
            summary: { type: ['string', 'null'], description: 'One line: what the page is for.' },
            tags: { type: ['array', 'null'], items: { type: 'string' } },
          },
        },
      },
      required: ['itemId', 'fields'],
    },
    remoteAcceptedValues: TEAM_SECTION_ONLY,
  },
  {
    name: 'findOrgMembers',
    availability: 'shared',
    readOnly: true,
    description:
      "Look up a person in the project's team by name or email before naming, assigning or citing them. With query omitted it lists the members; with query it returns one status: matched, ambiguous, notFound or noTeam. Never guess between ambiguous people.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional name or email fragment. Omit to list all members.' } },
    },
  },
  {
    name: 'tracker_list_types',
    availability: 'shared',
    readOnly: true,
    description: "List the project's types (the kinds of typed page) with their fields, and the named relations between them.",
    inputSchema: {
      type: 'object',
      properties: {
        includeBuiltin: { type: 'boolean', description: 'Include built-in types (default: true).' },
        includeCustom: { type: 'boolean', description: 'Include custom types (default: true).' },
        search: { type: 'string', description: 'Optional case-insensitive search over type names and display names.' },
      },
    },
  },
  {
    name: 'tracker_define_type',
    availability: 'shared',
    readOnly: false,
    description:
      'Define or replace a custom type (`schema`), and/or merge named relations into the predicate registry (`predicates`, merged by id; omitted ones are kept). Removing predicates or narrowing them needs `confirmDestructive`.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'object', description: 'Full custom type schema. A subtype sets `extends: <baseType>` and declares only what it adds.' },
        predicates: { type: 'array', items: { type: 'object' }, description: 'Predicate entries to merge by id.' },
        removePredicates: stringArray('Predicate ids to delete. Requires `confirmDestructive`.'),
        overwrite: { type: 'boolean', description: 'Replace an existing custom type of the same name.' },
        confirmDestructive: { type: 'boolean', description: 'Confirm a removal or narrowing.' },
      },
    },
    desktopOnlyArgs: ['patch', 'fileName', 'promoteExistingItems'],
  },
  {
    name: 'tracker_list',
    availability: 'shared',
    readOnly: true,
    description:
      'List typed pages (tracker items) with optional filters. Only open items are returned unless includeClosed is set or a closed status is asked for.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by type.' },
        status: { type: 'string', description: 'Filter by status.' },
        statusCategory: { type: 'string', description: "'backlog', 'unstarted', 'started', 'done' or 'cancelled'." },
        includeClosed: { type: 'boolean', description: 'Include done and cancelled items (default: false).' },
        priority: { type: 'string', description: 'Filter by priority.' },
        owner: { type: 'string', description: 'Filter by owner.' },
        archived: { type: 'boolean', description: 'Include archived items (default: false).' },
        search: { type: 'string', description: 'Search title and description text.' },
        limit: { type: 'number', description: 'Maximum items (default 50, max 250).' },
        where: {
          type: 'array',
          description: "Field filters, each { field, op, value }. Ops: '=', '!=', 'contains', 'not-contains', 'in', 'not-in', '>', '>=', '<', '<=', 'between', 'is-empty', 'is-not-empty'.",
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'Field name.' },
              op: { type: 'string', description: 'Operator.' },
              value: { description: 'Value to compare against.' },
            },
            required: ['field', 'op'],
          },
        },
        whereCombinator: { type: 'string', description: "'and' (default) or 'or'." },
        full: { type: 'boolean', description: 'Return every stored field per item.' },
      },
    },
    desktopOnlyArgs: ['typeTag', 'readiness', 'inbox'],
  },
  {
    name: 'tracker_get',
    availability: 'shared',
    readOnly: true,
    description: 'Get one typed page with its body as markdown and its serverRevision.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The item id or issue key (e.g. NIM-123).' } },
      required: ['id'],
    },
  },
  {
    name: 'tracker_create',
    availability: 'shared',
    readOnly: false,
    description:
      'Create a typed page. It is a team item with an issue key at once. Returns itemId, issueKey and the https link. Never create an item already marked done.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'The type.' },
        title: { type: 'string', description: 'The title.' },
        description: { type: 'string', description: 'Markdown body.' },
        status: { type: 'string', description: "Status (default: the type's initial status)." },
        priority: { type: 'string', description: 'Priority.' },
        tags: stringArray('Tags.'),
        owner: { type: 'string', description: 'Owner.' },
        fields: { type: 'object', description: 'Any schema-defined field by name; relationship fields take item ids or issue keys.' },
      },
      required: ['type', 'title'],
    },
    desktopOnlyArgs: [
      'dueDate', 'progress', 'assigneeEmail', 'reporterEmail', 'assigneeId', 'reporterId',
      'labels', 'linkedCommitSha', 'typeTags', 'linkSession',
    ],
  },
  {
    name: 'tracker_update',
    availability: 'shared',
    readOnly: false,
    description:
      "Update a typed page's fields or title. `description` replaces the body only while nobody has edited it since it was written; change an edited body with applyCollabDocEdit on collab://tracker-content/<itemId>.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id or issue key.' },
        title: { type: 'string', description: 'New title.' },
        status: { type: 'string', description: 'New status.' },
        priority: { type: 'string', description: 'New priority.' },
        description: { type: 'string', description: 'New body (replaces it).' },
        tags: stringArray('New tags (replaces them).'),
        archived: { type: 'boolean', description: 'Set archive state.' },
        owner: { type: 'string', description: 'New owner.' },
        primaryType: { type: 'string', description: 'Change the type.' },
        fields: { type: 'object', description: 'Any schema-defined field by name.' },
        unsetFields: stringArray('Field names to clear.'),
        expectedRevision: { type: 'number', description: 'serverRevision from tracker_get; the write is refused if someone changed the item since.' },
      },
      required: ['id'],
    },
    desktopOnlyArgs: [
      'linkSession', 'published', 'dueDate', 'progress', 'assigneeEmail', 'reporterEmail',
      'assigneeId', 'reporterId', 'labels', 'linkedCommitSha', 'typeTags',
    ],
    remoteOnlyArgs: ['expectedRevision'],
  },
  {
    name: 'list_citable_inputs',
    availability: 'shared',
    readOnly: true,
    description:
      "List people's comments on the named pages that a page may cite. Each entry has a stable key, who (name and email), when, the commented passage, the quote, and `citation`: ready markdown to paste right after the sentence it supports. Nothing is cited automatically.",
    inputSchema: {
      type: 'object',
      properties: {
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['prompt', 'answer', 'comment'] },
          description: "Only 'comment' here; prompts and answers are cited from the desktop app.",
        },
        query: { type: 'string', description: 'Case-insensitive text to match in the quote or context.' },
        pages: stringArray('Page uris whose comments to list.'),
        limit: { type: 'number', description: 'Maximum entries, newest kept (default 50, max 200).' },
      },
      required: [],
    },
    remoteAcceptedValues: {
      kinds: { values: ['comment'], message: 'Prompts and answers are cited from the desktop app; only comments here.' },
    },
  },
];

const BY_NAME = new Map<string, PageToolContract>(PAGE_TOOL_CONTRACT.map((tool) => [tool.name, tool]));

export function pageToolContract(name: string): PageToolContract | null {
  return BY_NAME.get(name) ?? null;
}

export interface RemotePageToolDefinition {
  name: PageToolName;
  description: string;
  inputSchema: PageToolInputSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

/** `tools/list` for the remote server: every tool with `repo` and `project` added. */
export function remoteToolDefinitions(): RemotePageToolDefinition[] {
  return PAGE_TOOL_CONTRACT.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: { repo: PAGE_TOOL_REPO_ARG, project: PAGE_TOOL_PROJECT_ARG, ...tool.inputSchema.properties },
      ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
    },
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.name === 'deleteSharedItem', openWorldHint: false },
  }));
}

/**
 * Why the remote server refuses these arguments, or null when it takes them:
 * a desktop-only argument, or a value outside `remoteAcceptedValues`.
 */
export function remoteArgumentRefusal(name: string, args: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const tool = BY_NAME.get(name);
  if (!tool || !args) return null;
  for (const arg of tool.desktopOnlyArgs ?? []) {
    if (args[arg] !== undefined) return `${name}: \`${arg}\` is only available in the Nimbalyst desktop app.`;
  }
  for (const [arg, accepted] of Object.entries(tool.remoteAcceptedValues ?? {})) {
    const value = args[arg];
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((entry) => typeof entry !== 'string' || !accepted.values.includes(entry))) return `${name}: ${accepted.message}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Results (JSON payloads; the other tools answer with text, as on desktop)
// ---------------------------------------------------------------------------

/** A team project as the remote tools report it. */
export interface PagesProjectRef {
  orgId: string;
  orgName: string;
  orgSlug: string;
  projectId: string;
  projectName: string;
  role: string;
  /** The project's console page. */
  url: string;
}

export interface PagesTeamSummary {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: string;
  /** Projects in this team the caller can access. */
  projects: Array<{ projectId: string; projectName: string }>;
}

/** The signed-in person: who a mark written from a terminal names. */
export interface PagesSignedInUser {
  email: string;
  displayName?: string;
}

export type PagesStatusResult =
  | {
      state: 'bound';
      user: PagesSignedInUser;
      project: PagesProjectRef;
      consoleScope: ConsoleTeamScope;
      homeLink?: string;
      /** The "How we write this wiki" page, when the project has one. */
      guideLink?: string;
    }
  | { state: 'ambiguous'; user: PagesSignedInUser; projects: PagesProjectRef[] }
  | { state: 'unbound'; user: PagesSignedInUser; teams: PagesTeamSummary[] };

export interface PagesBindRepoResult {
  project: PagesProjectRef;
}

export interface PagesCreateProjectResult {
  project: PagesProjectRef;
  homeLink?: string;
}

interface PageTreeNodeBase {
  /** `document:<id>`, `item:<id>` or `type:<id>`. */
  nodeId: string;
  id: string;
  title: string;
  parentNodeId: string | null;
  depth: number;
  sortOrder: number | null;
  /** The https link to write in page content; absent when the section has no console scope yet. */
  link?: string;
  childCount?: number;
  updatedAt?: number;
  hasContent?: boolean;
}

export type PageTreeNodeSummary =
  /** `fields`: the page's own fields, when any are set. */
  | (PageTreeNodeBase & { kind: 'page'; uri: string | null; fields?: PageFields })
  | (PageTreeNodeBase & { kind: 'typedPage'; typeId: string; issueKey?: string; placed: boolean })
  | (PageTreeNodeBase & { kind: 'type'; viewLink?: string });

/** A team project an agent can name in `project`. */
export interface PageToolProjectSummary {
  projectId: string;
  projectName: string | null;
}

/** `listPages`: the text answer is this object as JSON. */
export interface ListPagesResult {
  section: 'team' | 'personal';
  consoleScope: ConsoleLinkScope | null;
  openMarksViewLink?: string;
  nodes: PageTreeNodeSummary[];
  total?: number;
  truncated?: boolean;
  nextCursor?: string | null;
  /** Desktop, team section: the project listed, and the org's other projects to pass as `project`. */
  project?: PageToolProjectSummary;
  otherProjects?: PageToolProjectSummary[];
}

/** One `searchPages` result. `kind`, `id` and `link` match the `listPages` node it names. */
export interface SearchPagesResultEntry {
  kind: 'page' | 'typedPage' | 'type';
  id: string;
  title: string;
  issueKey?: string;
  /** Where to read the body with readCollabDoc. */
  uri: string | null;
  link?: string;
  /** Plain text around the match in the body; empty for a title-only match. */
  snippet: string;
  matchedIn: 'body' | 'title' | 'both';
  updatedAt: number | null;
}

/** `searchPages`: the text answer is this object as JSON. */
export interface SearchPagesResult {
  section: 'team' | 'personal';
  query: string;
  /** `partial` while the team index has not read every page once yet. */
  status: 'ready' | 'partial';
  results: SearchPagesResultEntry[];
}

export interface CreateSharedDocResult {
  documentId: string;
  uri: string | null;
  link?: string;
  /** Created, but a requested order was not applied. */
  warning?: string;
}

export interface MoveSharedItemResult {
  outcome?: 'unchanged' | 'reordered' | 'moved';
}

export interface DeleteSharedItemResult {
  /** Pages removed, for kind 'folder'. */
  removedCount?: number;
}

export interface SetPageTypeResult {
  itemId?: string;
  issueKey?: string;
  link?: string;
}

export interface SetPageFieldsResult {
  /** The page's fields after the write. */
  fields: PageFields;
}

export interface FindOrgMembersResult {
  status: 'listed' | 'matched' | 'ambiguous' | 'notFound' | 'noTeam';
  message: string;
  org: { orgId: string; name: string; teamProjectId?: string } | null;
  members: Array<{ memberId: string; displayName: string; email: string }>;
}

export interface PageToolCitableInput {
  kind: 'prompt' | 'answer' | 'comment';
  key: string;
  /** The desktop session it came from; absent for a comment listed by the remote server. */
  sessionId?: string;
  by: string;
  email?: string;
  /** ISO 8601. */
  at: string;
  context: string;
  /** At most 400 characters. */
  quote: string;
  answer?: string;
  typed?: boolean;
  /** Ready-to-paste citation markdown. */
  citation: string;
}

export interface ListCitableInputsResult {
  inputs: PageToolCitableInput[];
  notes: string[];
}

export interface TrackerCreateResult {
  itemId: string;
  issueKey?: string;
  link?: string;
}
