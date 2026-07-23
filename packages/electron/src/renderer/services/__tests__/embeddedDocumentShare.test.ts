import { describe, expect, it, vi } from 'vitest';

import {
  discoverEmbeddedDocuments,
  rewriteEmbeddedDocumentLinks,
  shareEmbeddedDocuments,
  type EmbeddedDocumentCandidate,
} from '../embeddedDocumentShare';

const mockupDescriptor = {
  documentType: 'mockup',
  displayName: 'Mockup',
  fileExtensions: ['.mockup.html'],
  defaultExtension: '.mockup.html',
  icon: 'web',
  editor: {
    kind: 'extension' as const,
    extensionId: 'com.nimbalyst.mockuplm',
    componentName: 'MockupEditor',
  },
  content: { strategy: 'structured-yjs' as const, codecId: 'mockup' },
  capabilities: {
    localCreate: true,
    shareToTeam: true,
    sharedCreate: true,
    history: true,
    export: true,
    embed: true,
  },
};

const calcDescriptor = {
  ...mockupDescriptor,
  documentType: 'calc',
  displayName: 'Calc Sheet',
  fileExtensions: ['.calc.md'],
  defaultExtension: '.calc.md',
  icon: 'table',
  editor: {
    kind: 'extension' as const,
    extensionId: 'com.nimbalyst.calc-sheets',
    componentName: 'CalcSheetEditor',
  },
  content: { strategy: 'structured-yjs' as const, codecId: 'calc' },
};

function catalog() {
  return {
    resolveShareability: vi.fn((fileName: string) => {
      if (fileName.endsWith('.mockup.html')) {
        return { state: 'ready' as const, descriptor: mockupDescriptor };
      }
      if (fileName.endsWith('.calc.md')) {
        return { state: 'ready' as const, descriptor: calcDescriptor };
      }
      return { state: 'unsupported' as const, reason: 'unsupported' };
    }),
  };
}

describe('embedded document cascade sharing', () => {
  it('discovers only paragraph-isolated registered embed links and deduplicates paths', async () => {
    const findExisting = vi.fn(async (absolutePath: string) => (
      absolutePath.endsWith('wireframe.mockup.html')
        ? { documentId: 'existing-doc', orgId: 'team-1' }
        : null
    ));
    const candidates = await discoverEmbeddedDocuments({
      markdown: [
        '[Wireframe](./wireframe.mockup.html "width=800 height=600")',
        '',
        '[Wireframe again](./wireframe.mockup.html)',
        '',
        'See [inline sheet](./budget.calc.md) in context.',
        '',
        '[Plain markdown](./notes.md)',
        '',
        '[Root sheet](sheets/forecast.calc.md)',
      ].join('\n'),
      sourceFilePath: '/workspace/docs/host.md',
      workspacePath: '/workspace',
      embeddableExtensions: ['.mockup.html', '.calc.md'],
      catalog: catalog() as never,
      expectedOrgId: 'team-1',
      fileExists: async () => true,
      findExisting,
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.map(candidate => candidate.absolutePath)).toEqual([
      '/workspace/docs/wireframe.mockup.html',
      '/workspace/sheets/forecast.calc.md',
    ]);
    expect(candidates[0].occurrences).toBe(2);
    expect(candidates[0].alreadyShared).toEqual({
      documentId: 'existing-doc',
      orgId: 'team-1',
    });
    expect(findExisting).toHaveBeenCalledTimes(2);
  });

  it('ignores a prior share into a different org so the link is not cross-team', async () => {
    const candidates = await discoverEmbeddedDocuments({
      markdown: '[Wireframe](./wireframe.mockup.html)',
      sourceFilePath: '/workspace/docs/host.md',
      workspacePath: '/workspace',
      embeddableExtensions: ['.mockup.html'],
      catalog: catalog() as never,
      expectedOrgId: 'team-2',
      fileExists: async () => true,
      findExisting: async () => ({ documentId: 'existing-doc', orgId: 'team-1' }),
    });

    expect(candidates).toHaveLength(1);
    // Reusing the team-1 document would emit `?orgId=team-1`, which every
    // team-2 recipient renders as "belongs to a different team".
    expect(candidates[0].alreadyShared).toBeUndefined();
  });

  it('ignores block links inside fenced code blocks', async () => {
    const markdown = [
      '[Real embed](./wireframe.mockup.html)',
      '',
      '```markdown',
      '[Documented example](./example.mockup.html)',
      '```',
      '',
      '~~~',
      '[Tilde fenced](./tilde.mockup.html)',
      '~~~',
    ].join('\n');
    const candidates = await discoverEmbeddedDocuments({
      markdown,
      sourceFilePath: '/workspace/docs/host.md',
      workspacePath: '/workspace',
      embeddableExtensions: ['.mockup.html'],
      catalog: catalog() as never,
      expectedOrgId: 'team-1',
      fileExists: async () => true,
      findExisting: async () => null,
    });

    expect(candidates.map(candidate => candidate.absolutePath)).toEqual([
      '/workspace/docs/wireframe.mockup.html',
    ]);

    // The rewrite must agree with discovery, or a documented example gets
    // silently replaced by a deep link.
    const rewritten = rewriteEmbeddedDocumentLinks({
      markdown,
      sourceFilePath: '/workspace/docs/host.md',
      workspacePath: '/workspace',
      candidates: [
        ...candidates,
        {
          absolutePath: '/workspace/docs/example.mockup.html',
          sourceHref: './example.mockup.html',
          fileName: 'example.mockup.html',
          fileExtension: '.mockup.html',
          descriptor: mockupDescriptor,
          occurrences: 1,
        },
      ],
      sharedReferences: new Map([
        ['/workspace/docs/wireframe.mockup.html', { documentId: 'mockup-1', orgId: 'team-1' }],
        ['/workspace/docs/example.mockup.html', { documentId: 'mockup-2', orgId: 'team-1' }],
      ]),
    });

    expect(rewritten).toContain('[Documented example](./example.mockup.html)');
    expect(rewritten).toContain('[Real embed](nimbalyst://doc/mockup-1?orgId=team-1');
  });

  it('rewrites selected embeds with canonical deep links while preserving attrs', () => {
    const markdown = [
      '[Wireframe](./wireframe.mockup.html "width=800 height=600")',
      '',
      '[Sheet](sheets/forecast.calc.md)',
      '',
      '[Notes](./notes.md)',
    ].join('\n');
    const candidates = [
      {
        absolutePath: '/workspace/docs/wireframe.mockup.html',
        sourceHref: './wireframe.mockup.html',
        fileName: 'wireframe.mockup.html',
        fileExtension: '.mockup.html',
        descriptor: mockupDescriptor,
        occurrences: 1,
      },
      {
        absolutePath: '/workspace/sheets/forecast.calc.md',
        sourceHref: 'sheets/forecast.calc.md',
        fileName: 'forecast.calc.md',
        fileExtension: '.calc.md',
        descriptor: calcDescriptor,
        occurrences: 1,
      },
    ] satisfies EmbeddedDocumentCandidate[];

    const rewritten = rewriteEmbeddedDocumentLinks({
      markdown,
      sourceFilePath: '/workspace/docs/host.md',
      workspacePath: '/workspace',
      candidates,
      sharedReferences: new Map([
        ['/workspace/docs/wireframe.mockup.html', { documentId: 'mockup-1', orgId: 'team-1' }],
        ['/workspace/sheets/forecast.calc.md', { documentId: 'sheet/1', orgId: 'team-1' }],
      ]),
    });

    expect(rewritten).toContain(
      '[Wireframe](nimbalyst://doc/mockup-1?orgId=team-1 "width=800 height=600 embedType=.mockup.html")',
    );
    expect(rewritten).toContain(
      '[Sheet](nimbalyst://doc/sheet%2F1?orgId=team-1 "embedType=.calc.md")',
    );
    expect(rewritten).toContain('[Notes](./notes.md)');
  });

  it('shares each selected local document once without opening child tabs and tolerates partial failure', async () => {
    const createDocument = vi.fn()
      .mockResolvedValueOnce({ documentId: 'sheet-1', title: 'forecast.calc.md' })
      .mockRejectedValueOnce(new Error('room unavailable'));
    const candidates = [
      {
        absolutePath: '/workspace/sheets/forecast.calc.md',
        sourceHref: 'sheets/forecast.calc.md',
        fileName: 'forecast.calc.md',
        fileExtension: '.calc.md',
        descriptor: calcDescriptor,
        occurrences: 2,
      },
      {
        absolutePath: '/workspace/mockups/broken.mockup.html',
        sourceHref: 'mockups/broken.mockup.html',
        fileName: 'broken.mockup.html',
        fileExtension: '.mockup.html',
        descriptor: mockupDescriptor,
        occurrences: 1,
      },
    ] satisfies EmbeddedDocumentCandidate[];

    const result = await shareEmbeddedDocuments({
      candidates,
      selectedPaths: new Set(candidates.map(candidate => candidate.absolutePath)),
      parentFolderId: 'designs',
      readSourceContent: vi.fn(async candidate => `content:${candidate.fileName}`),
      createDocument,
      generateId: vi.fn()
        .mockReturnValueOnce('operation-1')
        .mockReturnValueOnce('operation-2'),
      resolveOrgId: vi.fn(async () => 'team-1'),
    });

    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(createDocument).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestedName: 'forecast.calc.md',
      parentFolderId: 'designs',
      openAfterCreate: false,
    }));
    expect(result.sharedReferences.get('/workspace/sheets/forecast.calc.md')).toEqual({
      documentId: 'sheet-1',
      orgId: 'team-1',
    });
    expect(result.failures).toEqual([
      expect.objectContaining({ absolutePath: '/workspace/mockups/broken.mockup.html' }),
    ]);
    // Only the created document is rollback-eligible.
    expect(result.createdDocumentIds).toEqual(['sheet-1']);
  });

  it('does not report a reused already-shared document as newly created', async () => {
    const result = await shareEmbeddedDocuments({
      candidates: [
        {
          absolutePath: '/workspace/docs/wireframe.mockup.html',
          sourceHref: './wireframe.mockup.html',
          fileName: 'wireframe.mockup.html',
          fileExtension: '.mockup.html',
          descriptor: mockupDescriptor,
          occurrences: 1,
          alreadyShared: { documentId: 'existing-doc', orgId: 'team-1' },
        },
      ] satisfies EmbeddedDocumentCandidate[],
      selectedPaths: new Set(['/workspace/docs/wireframe.mockup.html']),
      parentFolderId: null,
      readSourceContent: vi.fn(),
      createDocument: vi.fn(),
      generateId: vi.fn(),
      resolveOrgId: vi.fn(async () => 'team-1'),
    });

    expect(result.createdDocumentIds).toEqual([]);
    expect(result.sharedReferences.get('/workspace/docs/wireframe.mockup.html')).toEqual({
      documentId: 'existing-doc',
      orgId: 'team-1',
    });
  });
});
