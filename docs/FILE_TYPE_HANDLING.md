# File Type Handling and Custom Editors

This document explains how Nimbalyst handles different file types and how extensions can register custom editors for new file formats.

## Overview

Nimbalyst has a multi-layered approach to file type handling:

1. **Default text-based files**: Markdown, plain text, code files open in the Lexical editor
2. **Built-in custom editors**: Mockup files (.mockup.html), DataModel files (.datamodel.json)
3. **Extension-provided editors**: PDF Viewer, and any future extension-based editors
4. **Excluded file types**: Binary files that should open in external apps

## Architecture

### File Opening Flow

When a user attempts to open a file:

1. **Main Process (FileOpener.ts)** checks if the file should be excluded
2. **Registered File Types** checks if an extension has registered a custom editor for this file type
3. **Custom Editor Registry** determines which component should handle the file
4. **Renderer Process** instantiates the appropriate editor component

### Extension File Type Registration

Extensions can register custom editors via their `manifest.json`:

```json
{
  "contributions": {
    "customEditors": [
      {
        "filePatterns": ["*.pdf"],
        "displayName": "PDF Viewer",
        "component": "PDFViewerEditor"
      }
    ]
  }
}
```

During app startup, `ExtensionHandlers.initializeExtensionFileTypes()` scans all extension manifests and registers file patterns with the main process. This allows file types that would normally be excluded (like PDFs) to be opened when an extension provides a custom editor.

### File Exclusion System

The file exclusion system (`fileFilters.ts`) has two parts:

**1. Excluded Extensions List**
Binary and non-text file types that Nimbalyst doesn't handle by default:
- Images: .png, .jpg, .gif, etc.
- Documents: .pdf, .doc, .xlsx, etc.
- Archives: .zip, .tar, .gz, etc.
- Executables: .exe, .dll, .so, etc.

**2. Custom Editor Override**
Before excluding a file, the system checks if any extension has registered a custom editor for that file type. If so, the file is allowed to open.

This design allows extensions to "claim" file types that would otherwise be excluded.

## Reading File Content

### The readFileContent API

Extensions and internal code use `window.electronAPI.readFileContent()` to read files. This API is smart about handling different file types:

**Text Files (Auto-detected encoding)**
```typescript
const result = await window.electronAPI.readFileContent('file.txt');
// Returns: { success: true, content: "...", isBinary: false, detectedEncoding: "utf8" }
```

The system automatically detects text encoding using the `chardet` library, supporting:
- UTF-8 (most common)
- UTF-16LE/BE (Windows Unicode)
- ISO-8859-1/Latin-1 (Western European)
- Windows-1252
- And more

**Binary Files (Auto-detected by extension)**
```typescript
const result = await window.electronAPI.readFileContent('image.png');
// Returns: { success: true, content: "base64data...", isBinary: true }
```

Files with binary extensions are automatically returned as base64-encoded content.

**Explicit Options**
```typescript
// Force binary mode
const pdf = await window.electronAPI.readFileContent('doc.pdf', { binary: true });

// Specify text encoding
const legacy = await window.electronAPI.readFileContent('old.txt', { encoding: 'latin1' });

// Explicit auto-detection
const auto = await window.electronAPI.readFileContent('file.txt', { encoding: 'auto' });
```

### When to Use Each Mode

- **Default (no options)**: Let the system auto-detect - works for 99% of cases
- **`{ binary: true }`**: When your extension needs raw binary data (PDFs, images, custom formats)
- **`{ encoding: 'latin1' }`**: When you know the file uses a specific encoding
- **`{ encoding: 'auto' }`**: Explicitly request auto-detection (same as default)

## Creating a Custom Editor Extension

### 1. Define Your Manifest

Specify which file patterns your editor handles:

```json
{
  "id": "com.example.my-editor",
  "name": "My File Viewer",
  "contributions": {
    "customEditors": [
      {
        "filePatterns": ["*.myformat"],
        "displayName": "My Format Viewer",
        "component": "MyEditorComponent"
      }
    ],
    "fileIcons": [
      {
        "pattern": "*.myformat",
        "icon": "description",
        "color": "#4CAF50"
      }
    ]
  }
}
```

### 2. Implement Your Editor Component

Your component receives these props:

```typescript
interface CustomEditorComponentProps {
  filePath: string;           // Absolute path to the file
  fileName: string;           // Just the filename
  initialContent: string;     // Initial content (may be empty for binary)
  theme: string;
  isActive: boolean;          // Is this tab active?
  workspaceId?: string;
  onContentChange?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onGetContentReady?: (getContentFn: () => string) => void;
}
```

### 3. Read File Content

Use the file reading API to load your file:

```typescript
export function MyEditorComponent({ filePath, theme }: CustomEditorComponentProps) {
  const [content, setContent] = useState<MyFileData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadFile = async () => {
      const electronAPI = (window as any).electronAPI;

      // For binary formats, request binary mode
      const result = await electronAPI.readFileContent(filePath, { binary: true });

      if (result?.success) {
        // Decode base64 to binary
        const binaryString = atob(result.content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Parse your custom format
        const parsed = parseMyFormat(bytes);
        setContent(parsed);
      }

      setLoading(false);
    };

    loadFile();
  }, [filePath]);

  if (loading) return <div>Loading...</div>;

  return <div className={`my-editor theme-${theme}`}>
    {/* Render your custom format */}
  </div>;
}
```

### 4. Handle Read-Only vs Editable

**Read-only editors** (like PDF Viewer):
```typescript
useEffect(() => {
  if (onGetContentReady) {
    onGetContentReady(() => ''); // No content to save
  }
  if (onDirtyChange) {
    onDirtyChange(false); // Never dirty
  }
}, [onGetContentReady, onDirtyChange]);
```

**Editable editors** would implement save functionality and track dirty state.

## Best Practices

### For Extension Authors

1. **Use explicit binary mode** for binary formats - don't rely on auto-detection
2. **Handle encoding carefully** - let the system auto-detect unless you have a specific reason not to
3. **Respect the theme prop** - use CSS variables for colors to support all themes
4. **Handle loading and error states** - provide good UX during file loading
5. **Consider performance** - for large files, implement virtualization or pagination

### For Core Developers

1. **Add new binary extensions** to the `binaryExtensions` list in `WorkspaceHandlers.ts`
2. **Don't hardcode file types** - use the extension system for new formats
3. **Update RegisteredFileTypes** when adding built-in custom editors
4. **Test with different encodings** - ensure auto-detection works correctly

## Examples in the Codebase

- **PDF Viewer Extension**: `/packages/extensions/pdf-viewer/` - Binary file handling, worker loading
- **DataModelLM Extension**: `/packages/extensions/datamodellm/` - Custom JSON format, AI tools integration
- **Mockup Editor**: `/packages/electron/src/renderer/components/CustomEditors/MockupEditor/` - HTML-based custom format

## Technical Details

### Main Process Components

- **`RegisteredFileTypes.ts`**: Tracks which file extensions have custom editors
- **`ExtensionHandlers.ts`**: Scans extension manifests and registers file types
- **`fileFilters.ts`**: Determines if a file should be excluded from opening
- **`WorkspaceHandlers.ts`**: Handles `read-file-content` IPC with encoding detection

### Renderer Process Components

- **`ExtensionLoader.ts`**: Loads extension modules and components
- **`CustomEditorRegistry.ts`**: Maps file paths to custom editor components
- **`TabContent.tsx`**: Switches between standard and custom editors

## Future Enhancements

Potential improvements to the file type system:

- **Content-based detection**: Use file content magic numbers for more reliable binary detection
- **Lazy loading**: Load custom editor extensions only when needed
- **Editor preferences**: Let users choose which editor to use for a file type
- **Streaming API**: Support streaming large files instead of loading entirely into memory
- **Write support**: Allow custom editors to save modified content
