import React from 'react';
import { MaterialSymbol } from './MaterialSymbol';

/**
 * Custom TypeScript icon component that matches Material Symbol style
 * Simple "TS" text in gray, similar to the JavaScript icon
 */
export function TypeScriptIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <text
        x="12"
        y="16"
        fontSize="11"
        fontWeight="600"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif"
        textAnchor="middle"
        fill="currentColor"
      >
        TS
      </text>
    </svg>
  );
}

/**
 * Get file icon based on file name or extension
 * Returns a React element (MaterialSymbol or custom icon)
 */
export function getFileIcon(fileName: string, size: number = 18): React.ReactElement {
  const lowerName = fileName.toLowerCase();

  // Special files
  if (lowerName === 'readme.md' || lowerName === 'readme.markdown') {
    return <MaterialSymbol icon="info" size={size} />;
  }
  if (lowerName === 'package.json') {
    return <MaterialSymbol icon="inventory_2" size={size} />;
  }
  if (lowerName === '.gitignore' || lowerName === '.gitattributes') {
    return <MaterialSymbol icon="folder_managed" size={size} />;
  }
  if (lowerName === 'license' || lowerName === 'license.md' || lowerName === 'license.txt') {
    return <MaterialSymbol icon="gavel" size={size} />;
  }

  // Programming languages
  if (lowerName.endsWith('.ts') || lowerName.endsWith('.tsx')) {
    return <TypeScriptIcon size={size} />;
  }
  if (lowerName.endsWith('.js') || lowerName.endsWith('.jsx') || lowerName.endsWith('.mjs') || lowerName.endsWith('.cjs')) {
    return <MaterialSymbol icon="javascript" size={size} />;
  }
  if (lowerName.endsWith('.json')) {
    return <MaterialSymbol icon="data_object" size={size} />;
  }
  if (lowerName.endsWith('.py')) {
    return <MaterialSymbol icon="code" size={size} />;
  }
  if (lowerName.endsWith('.java')) {
    return <MaterialSymbol icon="code" size={size} />;
  }
  if (lowerName.endsWith('.go')) {
    return <MaterialSymbol icon="code" size={size} />;
  }
  if (lowerName.endsWith('.rs')) {
    return <MaterialSymbol icon="code" size={size} />;
  }
  if (lowerName.endsWith('.cpp') || lowerName.endsWith('.c') || lowerName.endsWith('.h') || lowerName.endsWith('.hpp')) {
    return <MaterialSymbol icon="code" size={size} />;
  }

  // Markup and styling
  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    return <MaterialSymbol icon="html" size={size} />;
  }
  if (lowerName.endsWith('.css') || lowerName.endsWith('.scss') || lowerName.endsWith('.sass') || lowerName.endsWith('.less')) {
    return <MaterialSymbol icon="css" size={size} />;
  }
  if (lowerName.endsWith('.xml')) {
    return <MaterialSymbol icon="code" size={size} />;
  }
  if (lowerName.endsWith('.svg')) {
    return <MaterialSymbol icon="image" size={size} />;
  }

  // Data formats
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) {
    return <MaterialSymbol icon="settings" size={size} />;
  }
  if (lowerName.endsWith('.toml')) {
    return <MaterialSymbol icon="settings" size={size} />;
  }
  if (lowerName.endsWith('.csv')) {
    return <MaterialSymbol icon="table_chart" size={size} />;
  }

  // Images
  if (lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') ||
      lowerName.endsWith('.gif') || lowerName.endsWith('.webp') || lowerName.endsWith('.bmp') ||
      lowerName.endsWith('.ico') || lowerName.endsWith('.tiff')) {
    return <MaterialSymbol icon="image" size={size} />;
  }

  // Documents
  if (lowerName.endsWith('.pdf')) {
    return <MaterialSymbol icon="picture_as_pdf" size={size} />;
  }
  if (lowerName.endsWith('.doc') || lowerName.endsWith('.docx')) {
    return <MaterialSymbol icon="article" size={size} />;
  }
  if (lowerName.endsWith('.xls') || lowerName.endsWith('.xlsx')) {
    return <MaterialSymbol icon="table_chart" size={size} />;
  }
  if (lowerName.endsWith('.ppt') || lowerName.endsWith('.pptx')) {
    return <MaterialSymbol icon="slideshow" size={size} />;
  }

  // Text files
  if (lowerName.endsWith('.txt') || lowerName.endsWith('.log')) {
    return <MaterialSymbol icon="notes" size={size} />;
  }

  // Markdown (default for .md and .markdown)
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) {
    return <MaterialSymbol icon="description" size={size} />;
  }

  // Archives
  if (lowerName.endsWith('.zip') || lowerName.endsWith('.tar') || lowerName.endsWith('.gz') ||
      lowerName.endsWith('.7z') || lowerName.endsWith('.rar')) {
    return <MaterialSymbol icon="folder_zip" size={size} />;
  }

  // Shell scripts
  if (lowerName.endsWith('.sh') || lowerName.endsWith('.bash') || lowerName.endsWith('.zsh')) {
    return <MaterialSymbol icon="terminal" size={size} />;
  }

  // Video/Audio
  if (lowerName.endsWith('.mp4') || lowerName.endsWith('.avi') || lowerName.endsWith('.mov') ||
      lowerName.endsWith('.mkv') || lowerName.endsWith('.webm')) {
    return <MaterialSymbol icon="videocam" size={size} />;
  }
  if (lowerName.endsWith('.mp3') || lowerName.endsWith('.wav') || lowerName.endsWith('.ogg') ||
      lowerName.endsWith('.flac') || lowerName.endsWith('.m4a')) {
    return <MaterialSymbol icon="audio_file" size={size} />;
  }

  // Fonts
  if (lowerName.endsWith('.ttf') || lowerName.endsWith('.otf') || lowerName.endsWith('.woff') ||
      lowerName.endsWith('.woff2') || lowerName.endsWith('.eot')) {
    return <MaterialSymbol icon="font_download" size={size} />;
  }

  // Lock files
  if (lowerName.endsWith('.lock') || lowerName === 'package-lock.json' || lowerName === 'yarn.lock' || lowerName === 'pnpm-lock.yaml') {
    return <MaterialSymbol icon="lock" size={size} />;
  }

  // Default file icon
  return <MaterialSymbol icon="insert_drive_file" size={size} />;
}

/**
 * Get icon name for Material Symbols (returns string, not React element)
 * Used when you need just the icon name for components that render their own icon wrapper
 */
export function getFileIconName(fileName: string): string {
  const lowerName = fileName.toLowerCase();

  // Special files
  if (lowerName === 'readme.md' || lowerName === 'readme.markdown') return 'info';
  if (lowerName === 'package.json') return 'inventory_2';
  if (lowerName === '.gitignore' || lowerName === '.gitattributes') return 'folder_managed';
  if (lowerName === 'license' || lowerName === 'license.md' || lowerName === 'license.txt') return 'gavel';

  // Programming languages - TypeScript gets special handling
  if (lowerName.endsWith('.ts') || lowerName.endsWith('.tsx')) return 'typescript'; // Custom icon marker
  if (lowerName.endsWith('.js') || lowerName.endsWith('.jsx') || lowerName.endsWith('.mjs') || lowerName.endsWith('.cjs')) return 'javascript';
  if (lowerName.endsWith('.json')) return 'data_object';
  if (lowerName.endsWith('.py')) return 'code';
  if (lowerName.endsWith('.java')) return 'code';
  if (lowerName.endsWith('.go')) return 'code';
  if (lowerName.endsWith('.rs')) return 'code';
  if (lowerName.endsWith('.cpp') || lowerName.endsWith('.c') || lowerName.endsWith('.h') || lowerName.endsWith('.hpp')) return 'code';

  // Markup and styling
  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) return 'html';
  if (lowerName.endsWith('.css') || lowerName.endsWith('.scss') || lowerName.endsWith('.sass') || lowerName.endsWith('.less')) return 'css';
  if (lowerName.endsWith('.xml')) return 'code';
  if (lowerName.endsWith('.svg')) return 'image';

  // Data formats
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) return 'settings';
  if (lowerName.endsWith('.toml')) return 'settings';
  if (lowerName.endsWith('.csv')) return 'table_chart';

  // Images
  if (lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') ||
      lowerName.endsWith('.gif') || lowerName.endsWith('.webp') || lowerName.endsWith('.bmp') ||
      lowerName.endsWith('.ico') || lowerName.endsWith('.tiff')) return 'image';

  // Documents
  if (lowerName.endsWith('.pdf')) return 'picture_as_pdf';
  if (lowerName.endsWith('.doc') || lowerName.endsWith('.docx')) return 'article';
  if (lowerName.endsWith('.xls') || lowerName.endsWith('.xlsx')) return 'table_chart';
  if (lowerName.endsWith('.ppt') || lowerName.endsWith('.pptx')) return 'slideshow';

  // Text files
  if (lowerName.endsWith('.txt') || lowerName.endsWith('.log')) return 'notes';

  // Markdown
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) return 'description';

  // Archives
  if (lowerName.endsWith('.zip') || lowerName.endsWith('.tar') || lowerName.endsWith('.gz') ||
      lowerName.endsWith('.7z') || lowerName.endsWith('.rar')) return 'folder_zip';

  // Shell scripts
  if (lowerName.endsWith('.sh') || lowerName.endsWith('.bash') || lowerName.endsWith('.zsh')) return 'terminal';

  // Video/Audio
  if (lowerName.endsWith('.mp4') || lowerName.endsWith('.avi') || lowerName.endsWith('.mov') ||
      lowerName.endsWith('.mkv') || lowerName.endsWith('.webm')) return 'videocam';
  if (lowerName.endsWith('.mp3') || lowerName.endsWith('.wav') || lowerName.endsWith('.ogg') ||
      lowerName.endsWith('.flac') || lowerName.endsWith('.m4a')) return 'audio_file';

  // Fonts
  if (lowerName.endsWith('.ttf') || lowerName.endsWith('.otf') || lowerName.endsWith('.woff') ||
      lowerName.endsWith('.woff2') || lowerName.endsWith('.eot')) return 'font_download';

  // Lock files
  if (lowerName.endsWith('.lock') || lowerName === 'package-lock.json' || lowerName === 'yarn.lock' || lowerName === 'pnpm-lock.yaml') return 'lock';

  // Default
  return 'insert_drive_file';
}
