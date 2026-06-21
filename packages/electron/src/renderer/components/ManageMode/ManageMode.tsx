import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types/types';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './ManageMode.css';

type HostFileTreeItem = {
  children?: HostFileTreeItem[];
  name: string;
  path: string;
  type: 'directory' | 'file';
};

type ManageFileEntry = {
  absolutePath: string;
  depth: number;
  kind: 'directory' | 'file';
  name: string;
  path: string;
};

type ManageFilePreview = {
  absolutePath: string;
  content?: string;
  error?: string;
  kind: 'text' | 'unsupported';
  name: string;
  path: string;
};

type ManageSidebarSide = 'left' | 'right';

type ExcalidrawFileData = {
  appState?: Record<string, unknown>;
  elements?: readonly ExcalidrawElement[];
  files?: BinaryFiles;
  source?: string;
  type?: string;
  version?: number;
};

interface ManageModeProps {
  isActive: boolean;
  workspaceName: string | null;
  workspacePath: string;
}

const MANAGE_SIDEBAR_SIDE_STORAGE_KEY = 'manage.artifacts.sidebarSide';

const TEXT_EXTENSIONS = new Set([
  'css',
  'csv',
  'env',
  'bash',
  'c',
  'cpp',
  'cs',
  'fish',
  'go',
  'h',
  'hpp',
  'html',
  'htm',
  'ini',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'lua',
  'md',
  'markdown',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
  'zig',
  'zsh',
]);

/*
CDXC:ManageArtifacts 2026-06-21-04:27:
The Manage workarea needs source-parity artifact editing inside the desktop renderer: workspace-scoped file browsing, UTF-8 text editing for HTML and CSV artifacts, Markdown edit/preview modes for text artifacts, and canvas editing for .excalidraw files through the existing save bridge.

CDXC:ManageArtifacts 2026-06-21-04:27:
The renderer already owns file read and save IPC with conflict detection, so this mode uses the existing bridge instead of adding a second filesystem channel. Keep durable state project-relative in the UI while writes go through absolute paths supplied by the workspace file tree.
*/
export function ManageMode({ isActive, workspaceName, workspacePath }: ManageModeProps) {
  const [entries, setEntries] = useState<ManageFileEntry[]>([]);
  const [rootName, setRootName] = useState('Project');
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string>();
  const selectedPathRef = useRef<string | undefined>(undefined);
  const [preview, setPreview] = useState<ManageFilePreview>();
  const [draftContent, setDraftContent] = useState('');
  const [lastSavedContent, setLastSavedContent] = useState('');
  const [listState, setListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [markdownMode, setMarkdownMode] = useState<'edit' | 'preview' | 'split'>('split');
  const [error, setError] = useState<string>();
  const [sidebarSide, setSidebarSide] = useState<ManageSidebarSide>(() => readStoredManageSidebarSide());
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const saveResetTimerRef = useRef<number | undefined>(undefined);

  const isEditablePreview = preview?.kind === 'text';
  const isDirty = Boolean(isEditablePreview && draftContent !== lastSavedContent);

  const readFile = useCallback(
    async (entry: ManageFileEntry) => {
      if (entry.kind !== 'file') return;
      setSelectedPath(entry.path);
      selectedPathRef.current = entry.path;
      setPreview(undefined);
      setDraftContent('');
      setLastSavedContent('');
      setPreviewState('loading');
      setSaveState('idle');
      setError(undefined);

      try {
        const result = await window.electronAPI?.readFileContent(entry.absolutePath);
        if (!result) {
          throw new Error('The file could not be opened.');
        }
        if (!result.success) {
          throw new Error(result.error || 'The file could not be read.');
        }
        if (result.isBinary || !isTextManagePath(entry.path)) {
          setPreview({
            absolutePath: entry.absolutePath,
            error: 'This file type is not editable in Manage.',
            kind: 'unsupported',
            name: entry.name,
            path: entry.path,
          });
          setPreviewState('ready');
          return;
        }

        const nextContent = result.content ?? '';
        setPreview({
          absolutePath: entry.absolutePath,
          content: nextContent,
          kind: 'text',
          name: entry.name,
          path: entry.path,
        });
        setDraftContent(nextContent);
        setLastSavedContent(nextContent);
        setMarkdownMode(isMarkdownPath(entry.path) ? 'split' : 'edit');
        setPreviewState('ready');
      } catch (readError) {
        setPreviewState('error');
        setError(readError instanceof Error ? readError.message : 'Could not open file.');
      }
    },
    [],
  );

  const refreshFiles = useCallback(async () => {
    if (!workspacePath) return;
    setListState('loading');
    setError(undefined);
    try {
      const tree = await window.electronAPI?.getFolderContents(workspacePath);
      const nextEntries = flattenFileTree(tree ?? [], workspacePath);
      setEntries(nextEntries);
      setRootName(workspaceName?.trim() || basename(workspacePath) || 'Project');
      setListState('ready');

      const currentSelectedPath = selectedPathRef.current;
      const selectedStillExists =
        currentSelectedPath &&
        nextEntries.some((entry) => entry.kind === 'file' && entry.path === currentSelectedPath);
      if (!selectedStillExists) {
        const firstFile = nextEntries.find((entry) => entry.kind === 'file' && isTextManagePath(entry.path));
        if (firstFile) {
          void readFile(firstFile);
        } else {
          selectedPathRef.current = undefined;
          setSelectedPath(undefined);
          setPreview(undefined);
          setDraftContent('');
          setLastSavedContent('');
          setPreviewState('idle');
        }
      }
    } catch (listError) {
      setListState('error');
      setError(listError instanceof Error ? listError.message : 'Could not load project files.');
    }
  }, [readFile, workspaceName, workspacePath]);

  useEffect(() => {
    if (!isActive) return;
    void refreshFiles();
  }, [isActive, refreshFiles]);

  useEffect(() => {
    window.localStorage.setItem(MANAGE_SIDEBAR_SIDE_STORAGE_KEY, sidebarSide);
  }, [sidebarSide]);

  useEffect(
    () => () => {
      if (saveResetTimerRef.current !== undefined) {
        window.clearTimeout(saveResetTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isActive || !window.electronAPI?.onFileChangedOnDisk) return undefined;
    return window.electronAPI.onFileChangedOnDisk((change) => {
      const selectedEntry = selectedPathRef.current
        ? entries.find((entry) => entry.path === selectedPathRef.current)
        : undefined;
      if (selectedEntry && normalizeSlashes(change.path) === normalizeSlashes(selectedEntry.absolutePath) && !isDirty) {
        void readFile(selectedEntry);
      }
    });
  }, [entries, isActive, isDirty, readFile]);

  const saveFile = useCallback(async () => {
    if (!selectedPath || !preview || preview.kind !== 'text' || saveState === 'saving') {
      return;
    }
    if (saveResetTimerRef.current !== undefined) {
      window.clearTimeout(saveResetTimerRef.current);
      saveResetTimerRef.current = undefined;
    }
    setSaveState('saving');
    setError(undefined);

    try {
      const response = await window.electronAPI?.saveFile(draftContent, preview.absolutePath, lastSavedContent);
      if (!response?.success) {
        if (response?.conflict) {
          throw new Error('The file changed on disk. Refresh the file before saving again.');
        }
        throw new Error('Could not save file.');
      }

      setPreview({
        ...preview,
        content: draftContent,
      });
      setLastSavedContent(draftContent);
      setSaveState('saved');
      saveResetTimerRef.current = window.setTimeout(() => {
        setSaveState('idle');
        saveResetTimerRef.current = undefined;
      }, 1600);
    } catch (saveError) {
      setSaveState('error');
      setError(saveError instanceof Error ? saveError.message : 'Could not save file.');
    }
  }, [draftContent, lastSavedContent, preview, saveState, selectedPath]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
        if (!selectedPath || !isDirty) {
          return;
        }
        event.preventDefault();
        void saveFile();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDirty, saveFile, selectedPath]);

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return entries;
    }
    return entries.filter((entry) => {
      const searchable = `${entry.name}\n${entry.path}`.toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    });
  }, [entries, query]);

  const sidebar = (
    <aside className="manage-mode-sidebar" aria-label="Manage files">
      <header className="manage-mode-sidebar-header">
        <div>
          <div className="manage-mode-eyebrow">Manage</div>
          <h2>{rootName}</h2>
        </div>
        <div className="manage-mode-sidebar-actions">
          <IconButton
            icon="refresh"
            label="Refresh"
            onClick={() => {
              void refreshFiles();
            }}
          />
          <IconButton
            icon={sidebarSide === 'left' ? 'dock_to_right' : 'dock_to_left'}
            label="Switch sidebar side"
            onClick={() => {
              setSidebarHidden(false);
              setSidebarSide((current) => (current === 'left' ? 'right' : 'left'));
            }}
          />
          <IconButton
            icon="left_panel_close"
            label="Hide sidebar"
            onClick={() => setSidebarHidden(true)}
          />
        </div>
      </header>
      <label className="manage-mode-search">
        <span className="material-symbols-outlined">search</span>
        <input
          aria-label="Search files"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search files"
          value={query}
        />
      </label>
      <div className="manage-mode-file-list" role="list">
        {listState === 'loading' ? (
          <ManageEmptyState icon="progress_activity" text="Loading files" />
        ) : visibleEntries.length === 0 ? (
          <ManageEmptyState icon="search_off" text="No files found" />
        ) : (
          visibleEntries.map((entry) => (
            <button
              aria-current={entry.path === selectedPath ? 'true' : undefined}
              className={`manage-mode-file-row${entry.path === selectedPath ? ' is-selected' : ''}`}
              disabled={entry.kind === 'directory'}
              key={`${entry.kind}:${entry.path}`}
              onClick={() => void readFile(entry)}
              role="listitem"
              style={{ '--manage-depth': entry.depth } as React.CSSProperties}
              type="button"
            >
              <span className="material-symbols-outlined manage-mode-file-icon">
                {fileIconForPath(entry)}
              </span>
              <span className="manage-mode-file-name">{entry.name}</span>
              {entry.kind === 'file' ? <span className="manage-mode-file-type">{languageLabelForPath(entry.path)}</span> : null}
            </button>
          ))
        )}
      </div>
    </aside>
  );

  return (
    <div
      className="manage-mode"
      data-sidebar-hidden={sidebarHidden ? 'true' : 'false'}
      data-sidebar-side={sidebarSide}
    >
      {!sidebarHidden && sidebarSide === 'left' ? sidebar : null}
      <section className="manage-mode-preview">
        {sidebarHidden ? (
          <button className="manage-mode-restore-sidebar" onClick={() => setSidebarHidden(false)} type="button">
            <span className="material-symbols-outlined">dock_to_right</span>
            Files
          </button>
        ) : null}
        <ManagePreview
          draftContent={draftContent}
          error={error}
          isDirty={isDirty}
          markdownMode={markdownMode}
          onDraftChange={setDraftContent}
          onMarkdownModeChange={setMarkdownMode}
          onSave={saveFile}
          preview={preview}
          previewState={previewState}
          saveState={saveState}
        />
      </section>
      {!sidebarHidden && sidebarSide === 'right' ? sidebar : null}
    </div>
  );
}

function ManagePreview({
  draftContent,
  error,
  isDirty,
  markdownMode,
  onDraftChange,
  onMarkdownModeChange,
  onSave,
  preview,
  previewState,
  saveState,
}: {
  draftContent: string;
  error?: string;
  isDirty: boolean;
  markdownMode: 'edit' | 'preview' | 'split';
  onDraftChange: (content: string) => void;
  onMarkdownModeChange: (mode: 'edit' | 'preview' | 'split') => void;
  onSave: () => void;
  preview?: ManageFilePreview;
  previewState: 'idle' | 'loading' | 'ready' | 'error';
  saveState: 'idle' | 'saving' | 'saved' | 'error';
}) {
  if (previewState === 'loading') {
    return <ManagePreviewMessage icon="progress_activity" title="Loading file" />;
  }
  if (previewState === 'error') {
    return <ManagePreviewMessage icon="warning" title={error ?? 'Could not open file'} />;
  }
  if (!preview) {
    return <ManagePreviewMessage icon="description" title="Select a file" />;
  }
  if (preview.kind === 'unsupported') {
    return <ManagePreviewMessage icon="block" title={preview.error ?? 'Preview unavailable'} />;
  }

  const language = languageLabelForPath(preview.path);
  const isMarkdown = isMarkdownPath(preview.path);
  const isDrawing = isExcalidrawPath(preview.path);

  return (
    <div className="manage-mode-preview-content">
      <header className="manage-mode-preview-header">
        <div className="manage-mode-preview-title">
          <span className="material-symbols-outlined">{isDrawing ? 'draw' : 'description'}</span>
          <span>{preview.name}</span>
        </div>
        <div className="manage-mode-preview-meta">
          <span>{language}</span>
          {isDirty ? <span>Unsaved</span> : null}
        </div>
        <div className="manage-mode-preview-actions">
          {isMarkdown && !isDrawing ? (
            <div className="manage-mode-segmented-control" role="group" aria-label="Markdown mode">
              {(['edit', 'split', 'preview'] as const).map((mode) => (
                <button
                  aria-pressed={markdownMode === mode}
                  key={mode}
                  onClick={() => onMarkdownModeChange(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>
          ) : null}
          <button
            className="manage-mode-save-button"
            disabled={!isDirty || saveState === 'saving'}
            onClick={onSave}
            type="button"
          >
            <span className="material-symbols-outlined">{saveState === 'saved' ? 'check' : 'save'}</span>
            {saveStateLabel(saveState, isDirty)}
          </button>
        </div>
      </header>
      <div className="manage-mode-preview-path">{preview.path}</div>
      {error ? (
        <div className="manage-mode-inline-error">
          <span className="material-symbols-outlined">warning</span>
          <span>{error}</span>
        </div>
      ) : null}
      {isDrawing ? (
        <ManageExcalidrawEditor content={draftContent} fileName={preview.name} key={preview.path} onChange={onDraftChange} />
      ) : isMarkdown ? (
        <div className="manage-mode-markdown-workspace" data-mode={markdownMode}>
          {markdownMode !== 'preview' ? (
            <ManageTextEditor content={draftContent} language={language} onChange={onDraftChange} />
          ) : null}
          {markdownMode !== 'edit' ? <ManageMarkdownPreview content={draftContent} /> : null}
        </div>
      ) : (
        <ManageTextEditor content={draftContent} language={language} onChange={onDraftChange} />
      )}
    </div>
  );
}

function ManageTextEditor({
  content,
  language,
  onChange,
}: {
  content: string;
  language: string;
  onChange: (content: string) => void;
}) {
  return (
    <textarea
      aria-label={`${language} editor`}
      className="manage-mode-text-editor"
      onChange={(event) => onChange(event.currentTarget.value)}
      spellCheck={false}
      value={content}
    />
  );
}

function ManageMarkdownPreview({ content }: { content: string }) {
  return (
    <div className="manage-mode-markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ManageExcalidrawEditor({
  content,
  fileName,
  onChange,
}: {
  content: string;
  fileName: string;
  onChange: (content: string) => void;
}) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const hasAcceptedInitialSceneRef = useRef(false);
  const previousSceneSignatureRef = useRef('');
  const lastSerializedRef = useRef(content);
  const parsed = useMemo(() => parseExcalidrawFile(content), [content]);

  useEffect(() => {
    if (content !== lastSerializedRef.current) {
      lastSerializedRef.current = content;
      hasAcceptedInitialSceneRef.current = false;
      previousSceneSignatureRef.current = '';
    }
  }, [content]);

  if (!parsed.ok) {
    return (
      <div className="manage-mode-drawing-source">
        <ManagePreviewMessage icon="warning" title={parsed.error} />
        <textarea
          aria-label={`${fileName} source`}
          className="manage-mode-text-editor"
          onChange={(event) => onChange(event.currentTarget.value)}
          spellCheck={false}
          value={content}
        />
      </div>
    );
  }

  const data = parsed.data;
  return (
    <div className="manage-mode-drawing-editor">
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
        initialData={{
          appState: {
            collaborators: new Map(),
            viewBackgroundColor: '#101112',
            ...data.appState,
          },
          elements: data.elements ?? [],
          files: data.files ?? {},
        }}
        onChange={(elements, appState, files) => {
          const api = apiRef.current;
          const filesForSave = files ?? api?.getFiles() ?? {};
          const nextSignature = createExcalidrawSceneSignature(elements, appState, filesForSave);
          const nextContent = serializeExcalidrawFile(data, elements, appState, filesForSave);
          if (!hasAcceptedInitialSceneRef.current) {
            hasAcceptedInitialSceneRef.current = true;
            previousSceneSignatureRef.current = nextSignature;
            lastSerializedRef.current = nextContent;
            return;
          }
          if (nextSignature === previousSceneSignatureRef.current || nextContent === lastSerializedRef.current) {
            return;
          }
          previousSceneSignatureRef.current = nextSignature;
          lastSerializedRef.current = nextContent;
          onChange(nextContent);
        }}
        theme="dark"
      />
    </div>
  );
}

function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button aria-label={label} className="manage-mode-icon-button" onClick={onClick} title={label} type="button">
      <span className="material-symbols-outlined">{icon}</span>
    </button>
  );
}

function ManageEmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="manage-mode-empty">
      <span className="material-symbols-outlined">{icon}</span>
      <span>{text}</span>
    </div>
  );
}

function ManagePreviewMessage({ icon, title }: { icon: string; title: ReactNode }) {
  return (
    <div className="manage-mode-preview-message">
      <span className="material-symbols-outlined">{icon}</span>
      <span>{title}</span>
    </div>
  );
}

function flattenFileTree(items: HostFileTreeItem[], rootPath: string, depth = 0): ManageFileEntry[] {
  const entries: ManageFileEntry[] = [];
  for (const item of items) {
    const relative = relativePath(rootPath, item.path);
    entries.push({
      absolutePath: item.path,
      depth,
      kind: item.type === 'directory' ? 'directory' : 'file',
      name: item.name,
      path: relative,
    });
    if (item.type === 'directory' && item.children?.length) {
      entries.push(...flattenFileTree(item.children, rootPath, depth + 1));
    }
  }
  return entries;
}

function relativePath(rootPath: string, absolutePath: string): string {
  const root = normalizeSlashes(rootPath).replace(/\/+$/u, '');
  const absolute = normalizeSlashes(absolutePath);
  if (absolute === root) return '';
  if (absolute.startsWith(`${root}/`)) {
    return absolute.slice(root.length + 1);
  }
  return absolute;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/gu, '/');
}

function basename(path: string): string {
  const parts = normalizeSlashes(path).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function extensionForPath(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLocaleLowerCase() : '';
}

function languageLabelForPath(path: string): string {
  const extension = extensionForPath(path);
  if (!extension) return 'Text';
  const labels: Record<string, string> = {
    css: 'CSS',
    csv: 'CSV',
    excalidraw: 'Excalidraw',
    go: 'Go',
    h: 'C/C++',
    html: 'HTML',
    htm: 'HTML',
    ini: 'INI',
    js: 'JavaScript',
    json: 'JSON',
    jsonc: 'JSONC',
    jsx: 'React',
    md: 'Markdown',
    markdown: 'Markdown',
    mjs: 'JavaScript',
    py: 'Python',
    rs: 'Rust',
    sh: 'Shell',
    swift: 'Swift',
    ts: 'TypeScript',
    tsx: 'React',
    toml: 'TOML',
    txt: 'Text',
    xml: 'XML',
    yaml: 'YAML',
    yml: 'YAML',
  };
  return labels[extension] ?? extension.toLocaleUpperCase();
}

function isTextManagePath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extensionForPath(path)) || isExcalidrawPath(path);
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/iu.test(path);
}

function isExcalidrawPath(path: string): boolean {
  return /\.excalidraw$/iu.test(path);
}

function fileIconForPath(entry: ManageFileEntry): string {
  if (entry.kind === 'directory') return 'folder';
  if (isExcalidrawPath(entry.path)) return 'draw';
  if (/\.(csv|tsv)$/iu.test(entry.path)) return 'table';
  if (/\.(html|htm)$/iu.test(entry.path)) return 'html';
  if (isMarkdownPath(entry.path)) return 'description';
  return 'article';
}

function saveStateLabel(state: 'idle' | 'saving' | 'saved' | 'error', isDirty: boolean): string {
  switch (state) {
    case 'error':
      return 'Retry';
    case 'saved':
      return 'Saved';
    case 'saving':
      return 'Saving';
    case 'idle':
      return isDirty ? 'Save' : 'Saved';
  }
}

function readStoredManageSidebarSide(): ManageSidebarSide {
  const stored = window.localStorage.getItem(MANAGE_SIDEBAR_SIDE_STORAGE_KEY);
  return stored === 'right' ? 'right' : 'left';
}

function parseExcalidrawFile(content: string): { data: ExcalidrawFileData; ok: true } | { error: string; ok: false } {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      data: createEmptyExcalidrawFile(),
      ok: true,
    };
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!isRecord(value)) {
      return { error: 'Drawing JSON must be an object.', ok: false };
    }
    if (value.type !== 'excalidraw' && !Array.isArray(value.elements)) {
      return { error: 'Drawing JSON is missing scene elements.', ok: false };
    }
    return {
      data: {
        appState: isRecord(value.appState) ? value.appState : {},
        elements: Array.isArray(value.elements) ? (value.elements as ExcalidrawElement[]) : [],
        files: isRecord(value.files) ? (value.files as BinaryFiles) : {},
        source: typeof value.source === 'string' ? value.source : 'https://excalidraw.com',
        type: 'excalidraw',
        version: typeof value.version === 'number' ? value.version : 2,
      },
      ok: true,
    };
  } catch (parseError) {
    return {
      error: parseError instanceof Error ? parseError.message : 'Drawing JSON is invalid.',
      ok: false,
    };
  }
}

function createEmptyExcalidrawFile(): ExcalidrawFileData {
  return {
    appState: {
      viewBackgroundColor: '#101112',
    },
    elements: [],
    files: {},
    source: 'https://excalidraw.com',
    type: 'excalidraw',
    version: 2,
  };
}

function serializeExcalidrawFile(
  previousData: ExcalidrawFileData,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): string {
  const savedAppState: Record<string, unknown> = {
    ...(previousData.appState ?? {}),
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    theme: appState.theme,
    viewBackgroundColor: appState.viewBackgroundColor,
    zoom: normalizeExcalidrawZoom(appState.zoom),
  };
  delete savedAppState.collaborators;
  return JSON.stringify(
    {
      appState: savedAppState,
      elements,
      files,
      source: previousData.source ?? 'https://excalidraw.com',
      type: 'excalidraw',
      version: previousData.version ?? 2,
    },
    null,
    2,
  );
}

function createExcalidrawSceneSignature(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): string {
  return JSON.stringify({
    appState: {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      viewBackgroundColor: appState.viewBackgroundColor,
      zoom: normalizeExcalidrawZoom(appState.zoom),
    },
    elements: elements.map((element) => ({
      id: element.id,
      isDeleted: element.isDeleted,
      version: element.version,
      versionNonce: element.versionNonce,
    })),
    files: Object.keys(files).sort(),
  });
}

function normalizeExcalidrawZoom(zoom: AppState['zoom']): number {
  if (typeof zoom === 'object' && zoom !== null && 'value' in zoom && typeof zoom.value === 'number') {
    return zoom.value;
  }
  return typeof zoom === 'number' ? zoom : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
