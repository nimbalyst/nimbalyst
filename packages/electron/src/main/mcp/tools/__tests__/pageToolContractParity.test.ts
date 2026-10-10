// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PAGE_TOOL_CONTRACT, PAGE_TOOL_DESKTOP_PROJECT_ARG, type PageToolJsonSchema } from '@nimbalyst/collab-protocol';

/**
 * The remote Pages tools (collab-protocol `pageToolContract.ts`) take the
 * desktop tools' arguments, so one skill text serves both. A desktop argument
 * added, renamed or reshaped without a decision about the remote server fails
 * here: it either joins the contract or is listed in `desktopOnlyArgs`. A
 * desktop `project` (another project to read) is `desktopProjectArg`, since
 * the remote `project` is a different shape.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: { fromId: () => null, getAllWindows: () => [] } }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => ({ query: vi.fn() }) }));
vi.mock('../../../utils/store', () => ({ getWorkspaceState: vi.fn(() => ({})), isAnalyticsEnabled: vi.fn(() => false) }));
vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(() => null),
  getMostRecentlyFocusedWorkspaceWindow: vi.fn(() => null),
  documentServices: new Map(),
}));

const { getCollabIndexToolSchemas } = await import('../collabIndexToolHandlers');
const { getEditorToolSchemas } = await import('../editorToolHandlers');
const { getCollabReadToolSchemas } = await import('../collabReadToolHandlers');
const { trackerToolSchemas } = await import('../trackerToolHandlers');
const { LIST_CITABLE_INPUTS_TOOL_SCHEMA } = await import('../../../services/pageCitations/listCitableInputs');

type DesktopTool = { name: string; inputSchema: { properties?: Record<string, PageToolJsonSchema>; required?: readonly string[] } };

const desktopTools = new Map<string, DesktopTool>(
  ([
    ...getCollabIndexToolSchemas(),
    ...getEditorToolSchemas(undefined),
    ...getCollabReadToolSchemas(),
    ...trackerToolSchemas,
    LIST_CITABLE_INPUTS_TOOL_SCHEMA,
  ] as DesktopTool[]).map((tool) => [tool.name, tool]),
);

/** A schema's structure: everything but the prose. */
function shape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(shape);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== 'description').map(([key, value]) => [key, shape(value)]),
  );
}

const sorted = (values: Iterable<string>) => [...values].sort();

describe('Pages tool contract matches the desktop tools', () => {
  it.each(PAGE_TOOL_CONTRACT.filter((tool) => tool.availability === 'shared').map((tool) => [tool.name, tool] as const))(
    '%s',
    (name, tool) => {
      const desktop = desktopTools.get(name);
      expect(desktop, `${name} is not a desktop tool`).toBeDefined();
      const desktopProps = desktop!.inputSchema.properties ?? {};
      const desktopOnly = new Set(tool.desktopOnlyArgs ?? []);
      const remoteOnly = new Set(tool.remoteOnlyArgs ?? []);
      if (tool.desktopProjectArg) {
        expect(shape(desktopProps.project), `${name}.project`).toEqual(shape(PAGE_TOOL_DESKTOP_PROJECT_ARG));
        desktopOnly.add('project');
      } else {
        expect(desktopProps, `${name} names another project without desktopProjectArg`).not.toHaveProperty('project');
      }

      for (const arg of tool.desktopOnlyArgs ?? []) expect(desktopProps, `${name}: stale desktopOnlyArgs entry`).toHaveProperty(arg);
      const shared = sorted(Object.keys(desktopProps).filter((arg) => !desktopOnly.has(arg)));
      expect(sorted(Object.keys(tool.inputSchema.properties).filter((arg) => !remoteOnly.has(arg)))).toEqual(shared);
      for (const arg of shared) {
        expect(shape(tool.inputSchema.properties[arg]), `${name}.${arg}`).toEqual(shape(desktopProps[arg]));
      }
      expect(sorted((tool.inputSchema.required ?? []).filter((arg) => !remoteOnly.has(arg))))
        .toEqual(sorted((desktop!.inputSchema.required ?? []).filter((arg) => !desktopOnly.has(arg))));
    },
  );

  it('remote-only tools are not desktop tools', () => {
    for (const tool of PAGE_TOOL_CONTRACT.filter((entry) => entry.availability === 'remoteOnly')) {
      expect(desktopTools.has(tool.name)).toBe(false);
    }
  });
});
