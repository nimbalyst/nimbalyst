// @vitest-environment node
/**
 * `section: personal` agent tools land in the Local wiki folder: the page tree
 * tools run on the desktop env and the Local section's session, whose data
 * source talks to the real main-process service (here over a fake IPC bridge),
 * and `personal://<id>` reads and edits resolve to the page's file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../main/utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../main/services/localWiki/personalPagesExportIpc', () => ({
  registerPersonalPagesExportIpc: vi.fn(),
  logLegacyPersonalPagesHeartbeat: vi.fn(),
}));
vi.mock('../../../main/utils/workspaceDetection', () => ({ resolveProjectPath: (p: string) => p }));

import { createPageTool, deletePageTool, listPagesTool, renamePageTool } from '@nimbalyst/collab-client/docs/pageTreeToolCore';
import { pruneCollabDocsSession } from '@nimbalyst/collab-client/docs';
import { LocalWikiService } from '../../../main/services/localWiki/LocalWikiService';
import { getPersonalCollabDocsSession } from '../../store/atoms/collabDocuments';
import { createDesktopPageTreeEnv } from '../pageTreeTools/desktopPageTreeEnv';
import { applyPersonalPageAgentEdit, readPersonalPageForAgent } from '../personalAgentEdit';

let project: string;
let service: LocalWikiService;

function bridge(): (channel: string, ...args: any[]) => Promise<unknown> {
  return async (channel, ...args) => {
    switch (channel) {
      case 'local-wiki:snapshot': return service.snapshot(args[0]);
      case 'local-wiki:command': return service.command(args[0], args[1]);
      case 'local-wiki:read-body': return service.readBody(args[0], args[1]);
      case 'local-wiki:write-body': return service.writeBody(args[0], args[1], args[2], args[3]);
      case 'local-wiki:search': return service.search(args[0], args[1]);
      case 'local-wiki:page-path': return service.pageFilePath(args[0], args[1]);
      case 'local-wiki:legacy-snapshot': return { items: [], typePlacements: [], itemPlacements: [], unexportedPageCount: 0 };
      case 'history:create-snapshot': return undefined;
      case 'workspace:get-state': return null;
      default: throw new Error(`unexpected channel ${channel}`);
    }
  };
}

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-wiki-mcp-')));
  service = new LocalWikiService({ broadcast: () => undefined, watch: false });
  (globalThis as any).window = { electronAPI: { invoke: vi.fn(bridge()), on: vi.fn(() => () => undefined) } };
});

afterEach(() => {
  pruneCollabDocsSession(getPersonalCollabDocsSession(project).scope.scopeKey);
  service.dispose();
  delete (globalThis as any).window;
  fs.rmSync(project, { recursive: true, force: true });
});

describe('section: personal agent tools', () => {
  it('create, list, rename, read, edit and delete pages as files in the wiki folder', async () => {
    const env = createDesktopPageTreeEnv(project);
    const root = path.join(project, 'nimbalyst-local', 'wiki');

    const created = await createPageTool(env, { section: 'personal', title: 'Plans', initialContent: 'First draft\n' });
    expect(created).toMatchObject({ success: true });
    const id = (created as unknown as { documentId: string }).documentId;
    expect(fs.readFileSync(path.join(root, 'Plans.md'), 'utf8')).toMatch(new RegExp(`^---\\nid: ${id}\\n[\\s\\S]*\\nFirst draft\\n$`));
    await createPageTool(env, { section: 'personal', title: 'Q3', folderPath: 'Plans' });
    expect(fs.existsSync(path.join(root, 'Plans', 'Q3.md'))).toBe(true);

    const listed = await listPagesTool(env, { section: 'personal' });
    expect(JSON.stringify(listed)).toContain('"title":"Q3"');

    await renamePageTool(env, { section: 'personal', itemId: id, newName: 'Roadmap' });
    expect(fs.existsSync(path.join(root, 'Roadmap.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Roadmap', 'Q3.md'))).toBe(true);

    const uri = `personal://${id}`;
    expect(await readPersonalPageForAgent(uri, project)).toBe('First draft\n');
    expect(await applyPersonalPageAgentEdit(uri, [{ oldText: 'First draft', newText: 'Second draft' }], { workspacePath: project }))
      .toEqual({ success: true });
    expect(fs.readFileSync(path.join(root, 'Roadmap.md'), 'utf8').endsWith('Second draft\n')).toBe(true);

    await deletePageTool(env, { section: 'personal', itemId: id, kind: 'folder' });
    expect(fs.existsSync(path.join(root, 'Roadmap.md'))).toBe(false);
    expect(fs.readdirSync(path.join(root, '.trash'))).toHaveLength(1);
  });
});
