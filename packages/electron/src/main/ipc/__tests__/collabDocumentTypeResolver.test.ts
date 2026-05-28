/**
 * Regression test for "shared extension doc reopens blank".
 *
 * The `document-sync:open` IPC handler used to echo back whatever
 * `payload.documentType` the renderer passed -- so any caller that
 * forgot to pass it (CollabMode restore-on-mount, TabContent collab
 * loadContent) ended up with `documentType = undefined`, which
 * `CollaborativeTabEditor` collapsed to `markdown`, rendering shared
 * Excalidraw / mockup Y.Docs as blank Lexical panes.
 *
 * The renderer fix carries `documentType` through workspace-state
 * persistence; this helper is the main-process backstop that recovers
 * it locally if any future caller still forgets.
 */
import { describe, expect, it } from 'vitest';
import { resolveCollabDocumentType } from '../collabDocumentTypeResolver';

describe('resolveCollabDocumentType', () => {
  it('prefers the caller-supplied documentType when present', () => {
    const result = resolveCollabDocumentType({
      callerDocumentType: 'excalidraw',
      workspaceState: {
        openCollabDocumentEntries: [
          { documentId: 'doc-1', documentType: 'mockup.html' },
        ],
      },
      documentId: 'doc-1',
    });
    expect(result).toBe('excalidraw');
  });

  it('falls back to the persisted entry when caller omits documentType', () => {
    // This is the exact bug shape: a restore path opened the doc with
    // documentType=undefined; without this fallback the response carried
    // undefined and the renderer mounted a markdown editor over an
    // Excalidraw Y.Doc.
    const result = resolveCollabDocumentType({
      callerDocumentType: undefined,
      workspaceState: {
        openCollabDocumentEntries: [
          { documentId: 'doc-1', documentType: 'excalidraw' },
        ],
      },
      documentId: 'doc-1',
    });
    expect(result).toBe('excalidraw');
  });

  it('returns undefined when neither caller nor persisted state knows the type', () => {
    expect(
      resolveCollabDocumentType({
        callerDocumentType: undefined,
        workspaceState: {},
        documentId: 'doc-1',
      }),
    ).toBeUndefined();

    expect(
      resolveCollabDocumentType({
        callerDocumentType: undefined,
        workspaceState: { openCollabDocumentEntries: [] },
        documentId: 'doc-1',
      }),
    ).toBeUndefined();
  });

  it('only matches the entry with the same documentId', () => {
    const result = resolveCollabDocumentType({
      callerDocumentType: undefined,
      workspaceState: {
        openCollabDocumentEntries: [
          { documentId: 'other', documentType: 'excalidraw' },
          { documentId: 'doc-1', documentType: 'mockup.html' },
        ],
      },
      documentId: 'doc-1',
    });
    expect(result).toBe('mockup.html');
  });

  it('skips malformed entries instead of throwing', () => {
    const result = resolveCollabDocumentType({
      callerDocumentType: undefined,
      workspaceState: {
        openCollabDocumentEntries: [
          null,
          'not-an-object',
          { documentId: 'doc-1' }, // missing documentType
          { documentType: 'excalidraw' }, // missing documentId
          { documentId: 'doc-1', documentType: 'excalidraw' },
        ],
      },
      documentId: 'doc-1',
    });
    expect(result).toBe('excalidraw');
  });

  it('returns undefined when openCollabDocumentEntries is not an array', () => {
    expect(
      resolveCollabDocumentType({
        callerDocumentType: undefined,
        workspaceState: {
          openCollabDocumentEntries: 'corrupt' as unknown,
        },
        documentId: 'doc-1',
      }),
    ).toBeUndefined();
  });
});
