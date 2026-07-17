import { getExtensionLoader } from '@nimbalyst/runtime';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/sync';
import type {
  CollabCodec,
  CustomEditorContribution,
  ExtensionManifest,
  ExtensionModule,
  NewFileMenuContribution,
} from '@nimbalyst/extension-sdk';
import {
  getCollabContentAdapter,
  listRegisteredCollabContentAdapters,
  onCollabContentAdaptersChange,
  registerCollabContentAdapter,
} from '@nimbalyst/collab-adapters';
import {
  CODE_COLLAB_FILE_EXTENSIONS,
  CodeCollabContentAdapter,
} from '../utils/CodeCollabContentAdapter';

export interface CollaborativeDocumentTypeDescriptor {
  documentType: string;
  displayName: string;
  /** Normalized, leading-dot suffixes in longest-first order. */
  fileExtensions: string[];
  defaultExtension: string;
  icon: string;
  editor: {
    kind: 'lexical' | 'monaco' | 'extension' | 'opaque';
    extensionId?: string;
    componentName?: string;
  };
  content: {
    strategy: 'lexical' | 'text' | 'structured-yjs' | 'opaque-versioned';
    codecId: string;
  };
  creation?: {
    defaultContent: string | Uint8Array;
    source: 'builtin' | 'newFileMenu';
  };
  capabilities: {
    localCreate: boolean;
    shareToTeam: boolean;
    sharedCreate: boolean;
    history: boolean;
    export: boolean;
    embed: boolean;
    disabledReason?: string;
  };
}

export type CollaborativeShareability =
  | { state: 'ready'; descriptor: CollaborativeDocumentTypeDescriptor }
  | { state: 'unsupported'; descriptor?: CollaborativeDocumentTypeDescriptor; reason: string };

interface CatalogLoadedExtension {
  manifest: ExtensionManifest;
  module: Pick<ExtensionModule, 'components'>;
  enabled: boolean;
}

export interface CollaborativeCatalogExtensionSource {
  getLoadedExtensions(): CatalogLoadedExtension[];
  subscribe(listener: () => void): () => void;
}

export interface CollaborativeCatalogCodecSource {
  list(): CollabCodec[];
  subscribe(listener: () => void): () => void;
}

export interface CollaborativeDocumentTypeCatalogOptions {
  extensionSource?: CollaborativeCatalogExtensionSource;
  codecSource?: CollaborativeCatalogCodecSource;
  /** Phase 2 flips this when the built-in collaborative Monaco route lands. */
  monacoBindingAvailable?: boolean;
  includeBuiltinMarkdownCodec?: boolean;
}

interface CatalogEntry {
  descriptor: CollaborativeDocumentTypeDescriptor;
  extensionName?: string;
  hasEditorContribution: boolean;
  hasEditorComponent: boolean;
  declaresCollabBinding: boolean;
  codec?: CollabCodec;
  codecConflictReason?: string;
  sourceOrder: number;
}

interface CatalogState {
  entries: CatalogEntry[];
  descriptors: CollaborativeDocumentTypeDescriptor[];
  customOwnersBySuffix: Map<string, string[]>;
  revision: number;
}

const MARKDOWN_EXTENSIONS = ['.markdown', '.md'];
const CODE_EXTENSIONS = CODE_COLLAB_FILE_EXTENSIONS;

function normalizeSuffix(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function suffixFromPattern(pattern: string): string | null {
  if (!pattern.startsWith('*.')) return null;
  return normalizeSuffix(pattern.slice(1));
}

function sortSuffixes(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values, value => normalizeSuffix(value)).filter(
    (value): value is string => value !== null,
  ))).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function fileNameOnly(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  return (slash >= 0 ? fileName.slice(slash + 1) : fileName).toLowerCase();
}

function longestMatchingSuffix(fileName: string, suffixes: Iterable<string>): string | undefined {
  const basename = fileNameOnly(fileName);
  return sortSuffixes(suffixes).find(suffix => basename.endsWith(suffix));
}

function editorIdFor(descriptor: CollaborativeDocumentTypeDescriptor): string {
  if (descriptor.editor.kind === 'lexical') return 'builtin.lexical';
  if (descriptor.editor.kind === 'monaco') return 'builtin.monaco';
  return descriptor.editor.extensionId ?? 'unavailable';
}

function codecForSuffix(codecs: CollabCodec[], suffix: string): CollabCodec[] {
  return codecs.filter(codec => codec.fileExtensions.some(ext => normalizeSuffix(ext) === suffix));
}

function contributionSuffixes(contribution: CustomEditorContribution): string[] {
  return sortSuffixes(contribution.filePatterns.map(suffixFromPattern).filter(
    (suffix): suffix is string => suffix !== null,
  ));
}

function emptyCapabilities(localCreate: boolean): CollaborativeDocumentTypeDescriptor['capabilities'] {
  return {
    localCreate,
    shareToTeam: false,
    sharedCreate: false,
    history: false,
    export: false,
    embed: false,
  };
}

function strategyFor(documentType: string, codec: CollabCodec | undefined) {
  if (documentType === 'markdown') return 'lexical' as const;
  if (
    documentType === 'code' ||
    documentType === 'csv' ||
    documentType === 'mockup.html' ||
    documentType === 'calc.md' ||
    codec?.serializableDescriptor?.kind === 'text'
  ) {
    return 'text' as const;
  }
  if (documentType === 'imgproj') return 'opaque-versioned' as const;
  return 'structured-yjs' as const;
}

function getMenuIcon(
  manifest: ExtensionManifest,
  menu: NewFileMenuContribution | undefined,
  suffix: string,
): string {
  if (menu?.icon) return menu.icon;
  const fileIcons = manifest.contributions?.fileIcons ?? {};
  for (const [pattern, icon] of Object.entries(fileIcons)) {
    if (suffixFromPattern(pattern) === suffix) return icon;
  }
  return manifest.marketplace?.icon ?? 'extension';
}

function defaultExtensionSource(): CollaborativeCatalogExtensionSource {
  const loader = getExtensionLoader();
  return {
    getLoadedExtensions: () => loader.getLoadedExtensions(),
    subscribe: listener => loader.subscribe(listener),
  };
}

function defaultCodecSource(includeBuiltinMarkdownCodec: boolean): CollaborativeCatalogCodecSource {
  if (!getCollabContentAdapter('code')) {
    registerCollabContentAdapter(CodeCollabContentAdapter);
  }
  return {
    list: () => {
      const registered = listRegisteredCollabContentAdapters();
      const builtins: CollabCodec[] = [];
      if (includeBuiltinMarkdownCodec && !registered.some(codec => codec.documentType === 'markdown')) {
        builtins.push(MarkdownCollabContentAdapter);
      }
      if (!registered.some(codec => codec.documentType === 'code')) {
        builtins.push(CodeCollabContentAdapter);
      }
      return [...builtins, ...registered];
    },
    subscribe: listener => onCollabContentAdaptersChange(listener),
  };
}

/**
 * Live renderer projection over built-ins, extension contributions, and the
 * CollabCodec registry. It ensures the host-shipped code codec is registered,
 * but owns no extension registrations.
 */
export class CollaborativeDocumentTypeCatalog {
  private readonly extensionSource: CollaborativeCatalogExtensionSource;
  private readonly codecSource: CollaborativeCatalogCodecSource;
  private readonly monacoBindingAvailable: boolean;
  private readonly listeners = new Set<() => void>();
  private readonly disposeSources: Array<() => void>;
  private state: CatalogState;

  constructor(options: CollaborativeDocumentTypeCatalogOptions = {}) {
    this.extensionSource = options.extensionSource ?? defaultExtensionSource();
    this.codecSource = options.codecSource ?? defaultCodecSource(options.includeBuiltinMarkdownCodec !== false);
    this.monacoBindingAvailable = options.monacoBindingAvailable ?? false;
    this.state = this.buildState(0);
    const rebuild = () => this.rebuild();
    this.disposeSources = [
      this.extensionSource.subscribe(rebuild),
      this.codecSource.subscribe(rebuild),
    ];
  }

  dispose(): void {
    for (const dispose of this.disposeSources) dispose();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.state.revision;

  getDescriptors(): readonly CollaborativeDocumentTypeDescriptor[] {
    return this.state.descriptors;
  }

  resolveShareability(fileName: string): CollaborativeShareability {
    const allSuffixes = this.state.entries.flatMap(entry => entry.descriptor.fileExtensions);
    const suffix = longestMatchingSuffix(fileName, allSuffixes);
    if (!suffix) {
      return {
        state: 'unsupported',
        reason: `No collaborative document type is registered for "${fileNameOnly(fileName)}".`,
      };
    }

    const customOwners = this.state.customOwnersBySuffix.get(suffix) ?? [];
    let candidates = this.state.entries.filter(entry => entry.descriptor.fileExtensions.includes(suffix));
    if (customOwners.length > 0) {
      candidates = candidates.filter(entry => (
        entry.descriptor.editor.kind === 'extension' &&
        !!entry.descriptor.editor.extensionId &&
        customOwners.includes(entry.descriptor.editor.extensionId)
      ));
    } else {
      const builtinCandidates = candidates.filter(entry => entry.descriptor.editor.kind !== 'extension');
      if (builtinCandidates.length > 0) candidates = builtinCandidates;
    }

    const entry = this.preferredEntry(candidates, suffix);
    if (!entry) {
      return {
        state: 'unsupported',
        reason: `No collaborative editor owns the "${suffix}" file type.`,
      };
    }
    return this.resultForEntry(entry, suffix);
  }

  resolveMetadata(
    documentType: string,
    fileExtension?: string,
    editorId?: string,
  ): CollaborativeShareability {
    const suffix = fileExtension ? normalizeSuffix(fileExtension) ?? undefined : undefined;
    let candidates = this.state.entries.filter(entry => entry.descriptor.documentType === documentType);
    if (suffix) {
      candidates = candidates.filter(entry => entry.descriptor.fileExtensions.includes(suffix));
    }
    if (editorId) {
      candidates = candidates.filter(entry => editorIdFor(entry.descriptor) === editorId);
    }

    const resolvedSuffix = suffix ?? candidates[0]?.descriptor.defaultExtension;
    const entry = resolvedSuffix ? this.preferredEntry(candidates, resolvedSuffix) : undefined;
    if (!entry || !resolvedSuffix) {
      const owner = editorId ? ` editor "${editorId}"` : '';
      const ext = suffix ? ` for "${suffix}"` : '';
      return {
        state: 'unsupported',
        reason: `The collaborative${owner}${ext} is unavailable for document type "${documentType}".`,
      };
    }
    return this.resultForEntry(entry, resolvedSuffix);
  }

  inferFileExtension(documentType: string, title: string): string | undefined {
    const suffixes = this.state.entries
      .filter(entry => entry.descriptor.documentType === documentType)
      .flatMap(entry => entry.descriptor.fileExtensions);
    return longestMatchingSuffix(title, suffixes);
  }

  editorIdForDescriptor(descriptor: CollaborativeDocumentTypeDescriptor): string {
    return editorIdFor(descriptor);
  }

  private rebuild(): void {
    this.state = this.buildState(this.state.revision + 1);
    for (const listener of this.listeners) listener();
  }

  private preferredEntry(entries: CatalogEntry[], suffix: string): CatalogEntry | undefined {
    return [...entries].sort((a, b) => {
      const aExact = a.descriptor.defaultExtension === suffix ? 0 : 1;
      const bExact = b.descriptor.defaultExtension === suffix ? 0 : 1;
      return aExact - bExact || a.sourceOrder - b.sourceOrder;
    })[0];
  }

  private resultForEntry(entry: CatalogEntry, suffix: string): CollaborativeShareability {
    const reason = this.disabledReason(entry, suffix, this.state.customOwnersBySuffix);
    if (reason) return { state: 'unsupported', descriptor: entry.descriptor, reason };
    return { state: 'ready', descriptor: entry.descriptor };
  }

  private disabledReason(
    entry: CatalogEntry,
    suffix: string,
    customOwnersBySuffix: Map<string, string[]>,
  ): string | undefined {
    const owners = customOwnersBySuffix.get(suffix) ?? [];
    if (owners.length > 1) {
      return `Conflicting custom editors claim "${suffix}": ${owners.join(', ')}.`;
    }
    if (entry.codecConflictReason) return entry.codecConflictReason;

    const { descriptor } = entry;
    if (descriptor.editor.kind === 'extension') {
      const extensionLabel = entry.extensionName ?? descriptor.editor.extensionId ?? 'Unknown extension';
      if (!entry.hasEditorContribution) {
        return `The owning extension "${extensionLabel}" does not declare a custom editor for "${suffix}".`;
      }
      if (!entry.hasEditorComponent) {
        return `The owning extension "${extensionLabel}" does not provide editor component "${descriptor.editor.componentName ?? 'unknown'}".`;
      }
      if (!entry.declaresCollabBinding) {
        return `The owning extension "${extensionLabel}" does not declare a collaborative editor binding for "${suffix}".`;
      }
    } else if (descriptor.editor.kind === 'monaco' && !this.monacoBindingAvailable) {
      return `The built-in Monaco editor does not yet provide a collaborative binding for "${suffix}".`;
    } else if (descriptor.editor.kind === 'opaque') {
      return `No collaborative editor is registered for "${suffix}".`;
    }

    if (!entry.codec) {
      return `No collaborative codec is registered for document type "${descriptor.content.codecId}".`;
    }
    if (!entry.codec.fileExtensions.some(ext => normalizeSuffix(ext) === suffix)) {
      return `Collaborative codec "${entry.codec.documentType}" does not support the exact "${suffix}" suffix.`;
    }
    if (
      typeof entry.codec.seedFromFile !== 'function' ||
      typeof entry.codec.exportToFile !== 'function'
    ) {
      return `Collaborative codec "${entry.codec.documentType}" is missing deterministic seed/export support.`;
    }
    return undefined;
  }

  private buildState(revision: number): CatalogState {
    const extensions = this.extensionSource.getLoadedExtensions().filter(extension => extension.enabled);
    const codecs = this.codecSource.list();
    const codecsByType = new Map(codecs.map(codec => [codec.documentType, codec]));
    const customOwnersBySuffix = new Map<string, string[]>();
    const entries: CatalogEntry[] = [];
    let sourceOrder = 0;

    const markdownCodec = codecsByType.get('markdown');
    entries.push({
      descriptor: {
        documentType: 'markdown',
        displayName: 'Markdown',
        fileExtensions: MARKDOWN_EXTENSIONS,
        defaultExtension: '.md',
        icon: 'description',
        editor: { kind: 'lexical' },
        content: { strategy: 'lexical', codecId: 'markdown' },
        creation: { defaultContent: '', source: 'builtin' },
        capabilities: emptyCapabilities(true),
      },
      hasEditorContribution: true,
      hasEditorComponent: true,
      declaresCollabBinding: true,
      codec: markdownCodec,
      sourceOrder: sourceOrder++,
    });

    const codeCodec = codecsByType.get('code');
    entries.push({
      descriptor: {
        documentType: 'code',
        displayName: 'Text / Code',
        fileExtensions: sortSuffixes(CODE_EXTENSIONS),
        defaultExtension: '.txt',
        icon: 'code',
        editor: { kind: 'monaco' },
        content: { strategy: 'text', codecId: 'code' },
        creation: { defaultContent: '', source: 'builtin' },
        capabilities: emptyCapabilities(true),
      },
      hasEditorContribution: true,
      hasEditorComponent: true,
      declaresCollabBinding: this.monacoBindingAvailable,
      codec: codeCodec,
      sourceOrder: sourceOrder++,
    });

    const consumedMenus = new Set<string>();
    const representedCodecTypes = new Set(['markdown', 'code']);

    for (const extension of extensions) {
      const manifest = extension.manifest;
      const menus = manifest.contributions?.newFileMenu ?? [];
      const editors = manifest.contributions?.customEditors ?? [];

      editors.forEach((editor, editorIndex) => {
        const suffixes = contributionSuffixes(editor);
        if (suffixes.length === 0) return;
        for (const suffix of suffixes) {
          const owners = customOwnersBySuffix.get(suffix) ?? [];
          if (!owners.includes(manifest.id)) owners.push(manifest.id);
          customOwnersBySuffix.set(suffix, owners.sort());
        }

        const matchingCodecs = Array.from(new Set(
          suffixes.flatMap(suffix => codecForSuffix(codecs, suffix)),
        ));
        const codec = matchingCodecs.length === 1 ? matchingCodecs[0] : undefined;
        const documentType = codec?.documentType ?? suffixes[0].slice(1);
        if (codec) representedCodecTypes.add(codec.documentType);

        const menuMatch = menus.find((menu, menuIndex) => {
          const suffix = normalizeSuffix(menu.extension);
          if (menu.action === 'openVirtualTab' || !suffix || !suffixes.includes(suffix)) return false;
          consumedMenus.add(`${manifest.id}:${menuIndex}`);
          return true;
        });
        const menuSuffix = menuMatch ? normalizeSuffix(menuMatch.extension) ?? suffixes[0] : suffixes[0];
        const fileExtensions = sortSuffixes([...suffixes, ...(codec?.fileExtensions ?? [])]);
        const localCreate = !!menuMatch;
        const component = extension.module.components?.[editor.component];
        const codecConflictReason = matchingCodecs.length > 1
          ? `Conflicting collaborative codecs claim this editor's suffixes: ${matchingCodecs.map(item => item.documentType).sort().join(', ')}.`
          : undefined;

        entries.push({
          descriptor: {
            documentType,
            displayName: menuMatch?.displayName ?? editor.displayName,
            fileExtensions,
            defaultExtension: menuSuffix,
            icon: getMenuIcon(manifest, menuMatch, menuSuffix),
            editor: {
              kind: 'extension',
              extensionId: manifest.id,
              componentName: editor.component,
            },
            content: { strategy: strategyFor(documentType, codec), codecId: documentType },
            creation: menuMatch
              ? { defaultContent: menuMatch.defaultContent ?? '', source: 'newFileMenu' }
              : undefined,
            capabilities: emptyCapabilities(localCreate),
          },
          extensionName: manifest.name,
          hasEditorContribution: true,
          hasEditorComponent: !!component,
          declaresCollabBinding: editor.collaboration?.supported === true,
          codec,
          codecConflictReason,
          sourceOrder: sourceOrder++ + editorIndex / 100,
        });
      });

      menus.forEach((menu, menuIndex) => {
        if (menu.action === 'openVirtualTab' || consumedMenus.has(`${manifest.id}:${menuIndex}`)) return;
        const suffix = normalizeSuffix(menu.extension);
        if (!suffix) return;

        const builtinEntry = entries.find(entry => (
          entry.descriptor.editor.kind !== 'extension' && entry.descriptor.fileExtensions.includes(suffix)
        ));
        if (builtinEntry) {
          entries.push({
            ...builtinEntry,
            descriptor: {
              ...builtinEntry.descriptor,
              displayName: menu.displayName,
              fileExtensions: [suffix],
              defaultExtension: suffix,
              icon: menu.icon,
              creation: { defaultContent: menu.defaultContent ?? '', source: 'newFileMenu' },
              capabilities: emptyCapabilities(true),
            },
            sourceOrder: sourceOrder++,
          });
          return;
        }

        const matchingCodecs = codecForSuffix(codecs, suffix);
        const codec = matchingCodecs.length === 1 ? matchingCodecs[0] : undefined;
        const documentType = codec?.documentType ?? suffix.slice(1);
        if (codec) representedCodecTypes.add(codec.documentType);
        entries.push({
          descriptor: {
            documentType,
            displayName: menu.displayName,
            fileExtensions: sortSuffixes([suffix, ...(codec?.fileExtensions ?? [])]),
            defaultExtension: suffix,
            icon: getMenuIcon(manifest, menu, suffix),
            editor: { kind: 'extension', extensionId: manifest.id },
            content: { strategy: strategyFor(documentType, codec), codecId: documentType },
            creation: { defaultContent: menu.defaultContent ?? '', source: 'newFileMenu' },
            capabilities: emptyCapabilities(true),
          },
          extensionName: manifest.name,
          hasEditorContribution: false,
          hasEditorComponent: false,
          declaresCollabBinding: false,
          codec,
          codecConflictReason: matchingCodecs.length > 1
            ? `Conflicting collaborative codecs claim "${suffix}": ${matchingCodecs.map(item => item.documentType).sort().join(', ')}.`
            : undefined,
          sourceOrder: sourceOrder++,
        });
      });
    }

    for (const codec of codecs) {
      if (representedCodecTypes.has(codec.documentType)) continue;
      const suffixes = sortSuffixes(codec.fileExtensions);
      if (suffixes.length === 0) continue;
      entries.push({
        descriptor: {
          documentType: codec.documentType,
          displayName: codec.documentType,
          fileExtensions: suffixes,
          defaultExtension: suffixes[0],
          icon: 'extension',
          editor: { kind: 'opaque' },
          content: { strategy: strategyFor(codec.documentType, codec), codecId: codec.documentType },
          capabilities: emptyCapabilities(false),
        },
        hasEditorContribution: false,
        hasEditorComponent: false,
        declaresCollabBinding: false,
        codec,
        sourceOrder: sourceOrder++,
      });
    }

    const provisionalState: CatalogState = {
      entries,
      descriptors: [],
      customOwnersBySuffix,
      revision,
    };
    for (const entry of entries) {
      const suffix = entry.descriptor.defaultExtension;
      const reason = this.disabledReason(entry, suffix, customOwnersBySuffix);
      const ready = !reason;
      entry.descriptor.capabilities = {
        ...entry.descriptor.capabilities,
        shareToTeam: ready,
        sharedCreate: ready && entry.descriptor.capabilities.localCreate,
        history: ready,
        export: ready,
        embed: false,
        ...(reason ? { disabledReason: reason } : {}),
      };
    }
    provisionalState.descriptors = entries
      .sort((a, b) => a.sourceOrder - b.sourceOrder)
      .map(entry => entry.descriptor);
    return provisionalState;
  }
}

let catalogSingleton: CollaborativeDocumentTypeCatalog | null = null;

export function getCollaborativeDocumentTypeCatalog(): CollaborativeDocumentTypeCatalog {
  catalogSingleton ??= new CollaborativeDocumentTypeCatalog({ monacoBindingAvailable: true });
  return catalogSingleton;
}

export function resetCollaborativeDocumentTypeCatalogForTests(): void {
  catalogSingleton?.dispose();
  catalogSingleton = null;
}

export { longestMatchingSuffix, normalizeSuffix };
