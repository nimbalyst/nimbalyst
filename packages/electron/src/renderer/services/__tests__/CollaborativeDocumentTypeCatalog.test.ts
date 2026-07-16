import { describe, expect, it, vi } from 'vitest';
import type {
  CollabCodec,
  CustomEditorContribution,
  ExtensionManifest,
  NewFileMenuContribution,
} from '@nimbalyst/extension-sdk';
import {
  CollaborativeDocumentTypeCatalog,
  type CollaborativeCatalogCodecSource,
  type CollaborativeCatalogExtensionSource,
} from '../CollaborativeDocumentTypeCatalog';
import {
  inferSharedDocumentTypeMetadata,
  resolveSharedDocumentTypePresentation,
} from '../../utils/sharedDocumentTypeMetadata';
import {
  getMonacoLanguage,
  MONACO_LANGUAGE_BY_EXTENSION,
} from '../../utils/fileTypeDetector';

type LoadedExtension = ReturnType<typeof extension>;

class MutableExtensionSource implements CollaborativeCatalogExtensionSource {
  private listeners = new Set<() => void>();
  constructor(private extensions: LoadedExtension[] = []) {}
  getLoadedExtensions() { return this.extensions; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(extensions: LoadedExtension[]) {
    this.extensions = extensions;
    for (const listener of this.listeners) listener();
  }
}

class MutableCodecSource implements CollaborativeCatalogCodecSource {
  private listeners = new Set<() => void>();
  constructor(private codecs: CollabCodec[] = []) {}
  list() { return this.codecs; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(codecs: CollabCodec[]) {
    this.codecs = codecs;
    for (const listener of this.listeners) listener();
  }
}

function codec(documentType: string, fileExtensions: string[]): CollabCodec {
  return {
    documentType,
    fileExtensions,
    layoutVersion: 1,
    isEmpty: () => true,
    seedFromFile: () => {},
    applyFromFile: () => {},
    exportToFile: () => '',
    toPlainText: () => '',
  };
}

function extension(params: {
  id: string;
  name?: string;
  menus?: NewFileMenuContribution[];
  editors?: CustomEditorContribution[];
  components?: string[];
  enabled?: boolean;
  marketplaceIcon?: string;
}) {
  const manifest: ExtensionManifest = {
    id: params.id,
    name: params.name ?? params.id,
    version: '1.0.0',
    main: 'dist/index.js',
    marketplace: params.marketplaceIcon ? { icon: params.marketplaceIcon } : undefined,
    contributions: {
      newFileMenu: params.menus,
      customEditors: params.editors,
    },
  };
  return {
    manifest,
    enabled: params.enabled ?? true,
    module: {
      components: Object.fromEntries((params.components ?? []).map(name => [name, vi.fn()])),
    },
  };
}

function customEditor(
  suffixes: string[],
  component: string,
  collaboration: boolean | undefined = true,
): CustomEditorContribution {
  return {
    filePatterns: suffixes.map(suffix => `*${suffix}`),
    displayName: `${component} display`,
    component,
    collaboration: collaboration === undefined ? undefined : { supported: collaboration },
  };
}

function menu(extensionName: string, displayName: string, icon: string): NewFileMenuContribution {
  return { extension: extensionName, displayName, icon, defaultContent: `new ${displayName}` };
}

function makeCatalog(
  extensions: MutableExtensionSource,
  codecs: MutableCodecSource,
  monacoBindingAvailable = false,
) {
  return new CollaborativeDocumentTypeCatalog({
    extensionSource: extensions,
    codecSource: codecs,
    monacoBindingAvailable,
  });
}

describe('CollaborativeDocumentTypeCatalog', () => {
  it('keeps built-ins first and merges menu, editor, and codec contributions', () => {
    const extensions = new MutableExtensionSource([
      extension({
        id: 'com.example.diagram',
        name: 'Diagrammer',
        menus: [menu('.diagram', 'Diagram', 'draw')],
        editors: [customEditor(['.diagram'], 'DiagramEditor')],
        components: ['DiagramEditor'],
      }),
    ]);
    const codecs = new MutableCodecSource([
      codec('markdown', ['.md', '.markdown']),
      codec('diagram', ['.diagram']),
    ]);
    const catalog = makeCatalog(extensions, codecs);

    expect(catalog.getDescriptors().slice(0, 2).map(item => item.documentType)).toEqual([
      'markdown',
      'code',
    ]);
    const diagram = catalog.getDescriptors().find(item => item.documentType === 'diagram');
    expect(diagram).toMatchObject({
      displayName: 'Diagram',
      fileExtensions: ['.diagram'],
      defaultExtension: '.diagram',
      icon: 'draw',
      editor: {
        kind: 'extension',
        extensionId: 'com.example.diagram',
        componentName: 'DiagramEditor',
      },
      creation: { defaultContent: 'new Diagram', source: 'newFileMenu' },
      capabilities: { localCreate: true, shareToTeam: true, export: true },
    });
    catalog.dispose();
  });

  it('updates on extension activation/deactivation and codec registry changes', () => {
    const diagramExtension = extension({
      id: 'com.example.diagram',
      menus: [menu('.diagram', 'Diagram', 'draw')],
      editors: [customEditor(['.diagram'], 'DiagramEditor')],
      components: ['DiagramEditor'],
    });
    const extensions = new MutableExtensionSource([]);
    const codecs = new MutableCodecSource([codec('markdown', ['.md']), codec('diagram', ['.diagram'])]);
    const catalog = makeCatalog(extensions, codecs);
    const listener = vi.fn();
    catalog.subscribe(listener);

    expect(catalog.resolveShareability('roadmap.diagram').state).toBe('unsupported');
    extensions.set([diagramExtension]);
    expect(catalog.resolveShareability('roadmap.diagram').state).toBe('ready');
    codecs.set([codec('markdown', ['.md'])]);
    expect(catalog.resolveShareability('roadmap.diagram')).toMatchObject({
      state: 'unsupported',
      reason: 'No collaborative codec is registered for document type "diagram".',
    });
    extensions.set([]);
    expect(catalog.resolveShareability('roadmap.diagram').state).toBe('unsupported');
    expect(listener).toHaveBeenCalledTimes(3);
    catalog.dispose();
  });

  it('rejects conflicting custom editor ownership deterministically', () => {
    const editors = ['com.example.a', 'com.example.b'].map(id => extension({
      id,
      editors: [customEditor(['.diagram'], 'DiagramEditor')],
      components: ['DiagramEditor'],
    }));
    const catalog = makeCatalog(
      new MutableExtensionSource(editors),
      new MutableCodecSource([codec('markdown', ['.md']), codec('diagram', ['.diagram'])]),
    );

    const result = catalog.resolveShareability('conflict.diagram');
    expect(result).toMatchObject({
      state: 'unsupported',
      reason: 'Conflicting custom editors claim ".diagram": com.example.a, com.example.b.',
    });
    catalog.dispose();
  });

  it('uses longest compound suffixes before generic suffixes', () => {
    const extensions = new MutableExtensionSource([
      extension({
        id: 'com.example.calc',
        menus: [menu('.calc.md', 'Calc Sheet', 'calculate')],
        editors: [customEditor(['.calc.md'], 'CalcEditor')],
        components: ['CalcEditor'],
      }),
      extension({
        id: 'com.example.mockup',
        menus: [menu('.mockup.html', 'Mockup', 'palette')],
        editors: [customEditor(['.mockup.html'], 'MockupEditor')],
        components: ['MockupEditor'],
      }),
    ]);
    const codecs = new MutableCodecSource([
      codec('markdown', ['.md']),
      codec('calc.md', ['.calc.md']),
      codec('mockup.html', ['.mockup.html']),
    ]);
    const catalog = makeCatalog(extensions, codecs);

    expect(catalog.resolveShareability('budget.calc.md')).toMatchObject({
      state: 'ready', descriptor: { documentType: 'calc.md' },
    });
    expect(catalog.resolveShareability('screen.mockup.html')).toMatchObject({
      state: 'ready', descriptor: { documentType: 'mockup.html' },
    });
    expect(catalog.inferFileExtension('code', 'types.d.ts')).toBe('.d.ts');
    catalog.dispose();
  });

  it('projects the Monaco suffix/language map without treating markdown as code', () => {
    const catalog = makeCatalog(
      new MutableExtensionSource(),
      new MutableCodecSource([codec('markdown', ['.md'])]),
    );
    const code = catalog.getDescriptors().find(item => item.documentType === 'code');

    expect(MONACO_LANGUAGE_BY_EXTENSION['.swift']).toBe('swift');
    expect(MONACO_LANGUAGE_BY_EXTENSION['.d.ts']).toBe('typescript');
    expect(getMonacoLanguage('ambient.d.ts')).toBe('typescript');
    expect(code?.fileExtensions).toContain('.swift');
    expect(code?.fileExtensions).toContain('.d.ts');
    expect(code?.fileExtensions).not.toContain('.md');
    catalog.dispose();
  });

  it('returns precise missing editor, component, binding, and codec reasons', () => {
    const extensions = new MutableExtensionSource([
      extension({ id: 'menu-only', menus: [menu('.menuonly', 'Menu only', 'draft')] }),
      extension({
        id: 'missing-component',
        editors: [customEditor(['.component'], 'MissingEditor')],
      }),
      extension({
        id: 'missing-binding',
        editors: [customEditor(['.binding'], 'BindingEditor', false)],
        components: ['BindingEditor'],
      }),
      extension({
        id: 'missing-codec',
        editors: [customEditor(['.codec'], 'CodecEditor')],
        components: ['CodecEditor'],
      }),
    ]);
    const codecs = new MutableCodecSource([
      codec('markdown', ['.md']),
      codec('component', ['.component']),
      codec('binding', ['.binding']),
    ]);
    const catalog = makeCatalog(extensions, codecs);

    expect(catalog.resolveShareability('x.menuonly')).toMatchObject({
      state: 'unsupported',
      reason: 'The owning extension "menu-only" does not declare a custom editor for ".menuonly".',
    });
    expect(catalog.resolveShareability('x.component')).toMatchObject({
      state: 'unsupported',
      reason: 'The owning extension "missing-component" does not provide editor component "MissingEditor".',
    });
    expect(catalog.resolveShareability('x.binding')).toMatchObject({
      state: 'unsupported',
      reason: 'The owning extension "missing-binding" does not declare a collaborative editor binding for ".binding".',
    });
    expect(catalog.resolveShareability('x.codec')).toMatchObject({
      state: 'unsupported',
      reason: 'No collaborative codec is registered for document type "codec".',
    });
    expect(catalog.resolveShareability('x.ts')).toMatchObject({
      state: 'unsupported',
      reason: 'The built-in Monaco editor does not yet provide a collaborative binding for ".ts".',
    });
    catalog.dispose();
  });

  it('excludes openVirtualTab contributions from persistent shared creation', () => {
    const catalog = makeCatalog(
      new MutableExtensionSource([
        extension({
          id: 'com.example.browser',
          menus: [{
            extension: '.browser',
            displayName: 'Browser Tab',
            icon: 'language',
            action: 'openVirtualTab',
            virtualScheme: 'browser://',
          }],
        }),
      ]),
      new MutableCodecSource([codec('markdown', ['.md'])]),
    );

    expect(catalog.getDescriptors().some(item => item.defaultExtension === '.browser')).toBe(false);
    expect(catalog.resolveShareability('tab.browser')).toMatchObject({ state: 'unsupported' });
    catalog.dispose();
  });
});

describe('shared document metadata and presentation', () => {
  const structuredExtension = extension({
    id: 'com.example.diagram',
    name: 'Diagrammer',
    menus: [menu('.diagram', 'Diagram', 'draw')],
    editors: [customEditor(['.diagram'], 'DiagramEditor')],
    components: ['DiagramEditor'],
  });

  it('infers legacy metadata by document type and longest title suffix', () => {
    const catalog = makeCatalog(
      new MutableExtensionSource([structuredExtension]),
      new MutableCodecSource([
        codec('markdown', ['.md']),
        codec('code', ['.ts', '.d.ts']),
        codec('diagram', ['.diagram']),
      ]),
      true,
    );

    expect(inferSharedDocumentTypeMetadata({
      title: 'types.d.ts',
      documentType: 'code',
    }, catalog)).toEqual({
      metadataVersion: 2,
      fileExtension: '.d.ts',
      editorId: 'builtin.monaco',
      source: 'legacy-inferred',
    });
    catalog.dispose();
  });

  it('resolves markdown, Monaco, structured, and unavailable-extension icons safely', () => {
    const catalog = makeCatalog(
      new MutableExtensionSource([structuredExtension]),
      new MutableCodecSource([
        codec('markdown', ['.md']),
        codec('code', ['.ts']),
        codec('diagram', ['.diagram']),
      ]),
      true,
    );

    const presentation = (document: Parameters<typeof resolveSharedDocumentTypePresentation>[0]) =>
      resolveSharedDocumentTypePresentation(document, catalog);

    expect(presentation({
      title: 'Notes.md', documentType: 'markdown', metadataVersion: 2,
      fileExtension: '.md', editorId: 'builtin.lexical',
    })).toMatchObject({ state: 'ready', icon: 'description', typeLabel: 'Markdown' });
    expect(presentation({
      title: 'index.ts', documentType: 'code', metadataVersion: 2,
      fileExtension: '.ts', editorId: 'builtin.monaco',
    })).toMatchObject({ state: 'ready', icon: 'code', typeLabel: 'Text / Code' });
    expect(presentation({
      title: 'Flow.diagram', documentType: 'diagram', metadataVersion: 2,
      fileExtension: '.diagram', editorId: 'com.example.diagram',
    })).toMatchObject({ state: 'ready', icon: 'draw', typeLabel: 'Diagram' });
    expect(presentation({
      title: 'Map.mindmap', documentType: 'mindmap', metadataVersion: 2,
      fileExtension: '.mindmap', editorId: 'com.example.unavailable',
    })).toMatchObject({ state: 'unsupported', icon: 'lock', typeLabel: 'Unsupported document' });
    catalog.dispose();
  });
});
