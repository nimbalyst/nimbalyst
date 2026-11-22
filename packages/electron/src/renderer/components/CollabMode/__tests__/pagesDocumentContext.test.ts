// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPagesDocumentContext, pagesDocumentIdentity } from '../pagesDocumentContext';
import { clearTextSelection, setTextSelection } from '../../UnifiedAI/TextSelectionIndicator';
import { clearEditorContext, dismissEditorContextItem, setEditorContextItems } from '../../../stores/editorContextStore';

// File type lookup is the only dependency on the shared document index.
vi.mock('../../../store/atoms/collabDocuments', () => ({ findSharedDocumentTypeById: () => 'markdown' }));

const FILE = '/workspace/wiki/Home.md';
const SHARED = 'collab://org:test-org:doc:shared';
const PERSONAL = 'personal://my-page';
afterEach(() => {
  clearTextSelection();
  for (const path of [FILE, SHARED, PERSONAL]) clearEditorContext(path);
});

describe('wiki chat context', () => {
  it.each([FILE, SHARED, PERSONAL])('sends the live page and only its current, non-dismissed selections: %s', async (filePath) => {
    const tab = { filePath, fileName: 'Home' };
    const readFile = vi.fn(async () => 'stale disk body');
    let body = 'initial body';
    setTextSelection('Selected passage', filePath);
    setEditorContextItems(filePath, [{ id: 'shape', label: 'Shape', description: 'Selected shape' }]);
    const read = () => getPagesDocumentContext(tab, { filePath, read: () => body }, readFile);
    expect(pagesDocumentIdentity(tab)).toEqual({ filePath, fileName: 'Home' });
    body = 'latest body';
    expect(await read()).toMatchObject({ filePath, fileName: 'Home', content: 'latest body', textSelection: { text: 'Selected passage', filePath }, editorContextItems: [{ id: 'shape' }] });
    expect(readFile).not.toHaveBeenCalled();

    clearTextSelection();
    dismissEditorContextItem('shape', filePath);
    expect(await read()).toMatchObject({ filePath, content: 'latest body', textSelection: undefined, editorContextItems: undefined });
    setTextSelection('Another document', '/elsewhere.md');
    expect((await read()).textSelection).toBeUndefined();
  });

  it('reads a Local wiki file when its editor has no content getter', async () => {
    const readFile = vi.fn(async () => 'file body');
    expect(await getPagesDocumentContext({ filePath: FILE, fileName: 'Home' }, undefined, readFile)).toMatchObject({ filePath: FILE, content: 'file body', fileType: 'markdown' });
    expect(readFile).toHaveBeenCalledWith(FILE);
  });

  it('does not send the previous page body while a reused tab loads its new page', async () => {
    const staleRead = vi.fn(() => 'previous page body');
    const readFile = vi.fn(async () => 'new page body');
    const context = await getPagesDocumentContext(
      { filePath: FILE, fileName: 'Home' },
      { filePath: SHARED, read: staleRead },
      readFile,
    );
    expect(context.content).toBe('new page body');
    expect(staleRead).not.toHaveBeenCalled();
  });

  it.each([SHARED, PERSONAL])('never reads a virtual document from disk: %s', async (filePath) => {
    const readFile = vi.fn();
    expect(await getPagesDocumentContext({ filePath, fileName: 'Page' }, undefined, readFile)).toMatchObject({ filePath, content: '' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(['pages-search://team', 'type://decision', '', 'virtual://shared-home'])('excludes navigation tabs and their stale selection: %s', async (filePath) => {
    setTextSelection('Stale selection', FILE);
    const getContent = vi.fn(() => 'not document content');
    const readFile = vi.fn();
    const tab = { filePath, fileName: 'View' };
    expect(pagesDocumentIdentity(tab)).toEqual({});
    expect(await getPagesDocumentContext(tab, { filePath, read: getContent }, readFile)).toEqual({});
    expect(getContent).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
