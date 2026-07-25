/**
 * File Type Detection Utility
 *
 * Determines whether a file should be edited as markdown (Lexical),
 * code (Monaco), image viewer, or a custom editor.
 */

export type EditorType = 'markdown' | 'code' | 'image' | 'custom';

/**
 * Textual suffixes understood by the built-in Monaco editor. Keep this as the
 * single renderer source of truth for both language selection and the
 * collaborative document-type catalog.
 */
export const MONACO_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  // JavaScript/TypeScript
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.d.ts': 'typescript',

  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',

  // Data formats
  '.json': 'json',
  '.jsonc': 'json',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',

  // Python
  '.py': 'python',
  '.pyw': 'python',
  '.pyi': 'python',

  // Shell
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',

  // C/C++
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',

  // Other compiled languages
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.cs': 'csharp',
  '.dart': 'dart',

  // Scripting
  '.rb': 'ruby',
  '.php': 'php',
  '.pl': 'perl',
  '.lua': 'lua',

  // Functional
  '.hs': 'haskell',
  '.scala': 'scala',
  '.clj': 'clojure',
  '.fs': 'fsharp',
  '.fsx': 'fsharp',

  // Markup/config
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdc': 'markdown',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.dockerignore': 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'plaintext',

  // Text
  '.txt': 'plaintext',
  '.log': 'plaintext',
});

/** Longest suffix first so compound types such as `.d.ts` win. */
export const MONACO_TEXT_FILE_EXTENSIONS = Object.freeze(
  Object.keys(MONACO_LANGUAGE_BY_EXTENSION).sort((a, b) => b.length - a.length || a.localeCompare(b)),
);

/**
 * Browser-compatible path utilities
 */
function getExtname(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash && lastDot > 0) {
    return filePath.substring(lastDot);
  }
  return '';
}

function getBasename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
}

/**
 * Check if a file is an image
 */
export function isImageFile(filePath: string): boolean {
  const ext = getExtname(filePath).toLowerCase();
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp'];
  return imageExtensions.includes(ext);
}

/**
 * Determine which editor should be used for a given file
 *
 * Note: This function can optionally check for custom editors if a registry
 * check function is provided. To avoid circular dependencies, the custom editor
 * check is done by the caller (TabEditor).
 */
export function getFileType(
  filePath: string,
  customEditorCheck?: (ext: string) => boolean
): EditorType {
  const ext = getExtname(filePath).toLowerCase();

  // Check custom editors FIRST so extensions can override built-in types
  // (e.g., .slides.md handled by an extension instead of Lexical)
  if (customEditorCheck && customEditorCheck(ext)) {
    return 'custom';
  }

  if (ext === '.md' || ext === '.markdown' || ext === '.mdc') {
    return 'markdown';
  }

  if (isImageFile(filePath)) {
    return 'image';
  }

  return 'code';
}

/**
 * Map file extension to Monaco editor language ID
 *
 * Monaco supports many languages out of the box. This function
 * provides the language ID for syntax highlighting.
 *
 * See: https://microsoft.github.io/monaco-editor/monarch.html
 */
export function getMonacoLanguage(filePath: string): string {
  const ext = getExtname(filePath).toLowerCase();

  // Special case: files without extensions
  if (!ext) {
    const basename = getBasename(filePath);
    if (basename === 'Dockerfile') return 'dockerfile';
    if (basename === 'Makefile') return 'makefile';
    if (basename === 'Gemfile') return 'ruby';
    return 'plaintext';
  }

  const lowerName = getBasename(filePath).toLowerCase();
  const matchedSuffix = MONACO_TEXT_FILE_EXTENSIONS.find(suffix => lowerName.endsWith(suffix));
  return (matchedSuffix && MONACO_LANGUAGE_BY_EXTENSION[matchedSuffix]) ||
    MONACO_LANGUAGE_BY_EXTENSION[ext] ||
    'plaintext';
}

/**
 * Check if a file is likely binary (not suitable for text editing)
 */
export function isBinaryFile(filePath: string): boolean {
  const ext = getExtname(filePath).toLowerCase();

  const binaryExtensions = [
    // Images
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
    // Video/Audio
    '.mp4', '.avi', '.mov', '.wmv', '.mp3', '.wav', '.ogg', '.flac',
    // Archives
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    // Executables
    '.exe', '.dll', '.so', '.dylib', '.app', '.dmg',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // Other binary
    '.bin', '.dat', '.db', '.sqlite', '.wasm',
  ];

  return binaryExtensions.includes(ext);
}
