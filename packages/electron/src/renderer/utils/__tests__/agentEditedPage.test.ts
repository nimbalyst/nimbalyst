// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';

const { host, modeAtom } = vi.hoisted(() => ({
  host: {
    pageIdForFile: vi.fn(),
    resolveScope: vi.fn(async () => ({ kind: 'personal' })),
    openArtifact: vi.fn(),
  },
  modeAtom: { current: null as unknown },
}));

vi.mock('../../store/atoms/collabDocuments', () => ({
  activeCollabScopeAtom: atom(null),
  getElectronCollabHost: vi.fn(),
  getSharedDocumentsForScope: vi.fn(() => []),
  getPersonalCollabHost: () => ({
    source: () => ({ pageIdForFile: host.pageIdForFile }),
    resolveScope: host.resolveScope,
    openArtifact: host.openArtifact,
  }),
}));
vi.mock('../../store/atoms/windowMode', async () => {
  const { atom: makeAtom } = await import('jotai');
  const mode = makeAtom('files');
  modeAtom.current = mode;
  return { setWindowModeAtom: makeAtom(null, (_get, set, next: string) => set(mode, next)) };
});
vi.mock('../openSharedDocumentInTab', () => ({ openSharedDocumentInTab: vi.fn() }));

import { openFileAsWikiPage } from '../agentEditedPage';

const WORKSPACE = '/ws/project';
const mode = () => store.get(modeAtom.current as ReturnType<typeof atom<string>>);

describe('openFileAsWikiPage', () => {
  beforeEach(() => {
    host.pageIdForFile.mockReset();
    host.openArtifact.mockReset();
  });

  it('opens a Local wiki page in Pages and leaves any other file to Files', async () => {
    host.pageIdForFile.mockImplementation(async (path: string) => path === `${WORKSPACE}/wiki/Home.md` ? 'home' : null);

    await expect(openFileAsWikiPage(`${WORKSPACE}/src/index.ts`, WORKSPACE, 'quick_open')).resolves.toBe(false);
    expect(host.openArtifact).not.toHaveBeenCalled();
    expect(mode()).toBe('files');

    await expect(openFileAsWikiPage(`${WORKSPACE}/wiki/Home.md`, WORKSPACE, 'quick_open')).resolves.toBe(true);
    expect(mode()).toBe('collab');
    expect(host.openArtifact).toHaveBeenCalledWith(
      { kind: 'document', scope: { kind: 'personal' }, documentId: 'home', teamProjectId: null },
      'quick_open',
    );
  });

  it('falls back to Files when the wiki cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    host.pageIdForFile.mockRejectedValue(new Error('no wiki'));

    await expect(openFileAsWikiPage(`${WORKSPACE}/wiki/Home.md`, WORKSPACE, 'agent_tool')).resolves.toBe(false);
    expect(host.openArtifact).not.toHaveBeenCalled();
  });
});
