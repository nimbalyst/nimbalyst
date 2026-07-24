import React, { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { MarkdownRenderer } from './MarkdownRenderer';

const COLLAPSE_THRESHOLD = 30;
const COLLAPSED_LINES = 20;

const extensionToLanguage: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', xml: 'xml', svg: 'svg',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sql: 'sql', graphql: 'graphql',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  dockerfile: 'docker',
};

const markdownExtensions = new Set(['md', 'mdx', 'markdown']);

/** Strip YAML frontmatter (---\n...\n---) from markdown content */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(end + 4).trimStart();
}

function getFileInfo(filePath?: string): { language: string; isMarkdown: boolean } {
  if (!filePath) return { language: '', isMarkdown: false };
  const filename = filePath.split('/').pop()?.toLowerCase() || '';
  if (filename === 'dockerfile') return { language: 'docker', isMarkdown: false };
  if (filename === 'makefile') return { language: 'makefile', isMarkdown: false };
  const ext = filename.split('.').pop() || '';
  if (markdownExtensions.has(ext)) return { language: 'markdown', isMarkdown: true };
  return { language: extensionToLanguage[ext] || '', isMarkdown: false };
}

interface NewFilePreviewProps {
  content: string;
  filePath?: string;
  maxHeight?: string;
  onOpenFile?: (filePath: string) => void;
  absoluteFilePath?: string;
}

export const NewFilePreview: React.FC<NewFilePreviewProps> = ({
  content,
  filePath,
  maxHeight = '18rem',
  onOpenFile,
  absoluteFilePath,
}) => {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const isLong = lineCount > COLLAPSE_THRESHOLD;
  const [isCollapsed, setIsCollapsed] = useState(isLong);
  const { language, isMarkdown } = getFileInfo(filePath);

  const displayContent = isCollapsed ? lines.slice(0, COLLAPSED_LINES).join('\n') : content;

  const pathToOpen = absoluteFilePath || filePath;
  const isClickable = !!(onOpenFile && pathToOpen);

  const handleOpenFile = (e: React.MouseEvent) => {
    if (isClickable) {
      e.preventDefault();
      onOpenFile!(pathToOpen!);
    }
  };

  return (
    <div className="new-file-preview rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] flex flex-col">
      {/* File header */}
      {filePath && (
        <div className="px-3 py-2 bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] font-medium border-b border-[var(--nim-border)] text-[0.7rem] shrink-0 flex items-center gap-2">
          {isClickable ? (
            <button
              className="bg-transparent border-none p-0 m-0 font-inherit text-[var(--nim-link)] cursor-pointer no-underline text-left hover:underline"
              onClick={handleOpenFile}
              title={`Open ${pathToOpen}`}
            >
              {filePath}
            </button>
          ) : (
            <span>{filePath}</span>
          )}
          <span className="text-[var(--nim-text-faint)] ml-auto">{lineCount} lines</span>
        </div>
      )}

      {/* Content - constrained when collapsed, full height when expanded */}
      <div className="relative" style={isCollapsed ? { maxHeight, overflow: 'hidden' } : undefined}>
        {isMarkdown ? (
          <div className="p-3">
            <MarkdownRenderer content={stripFrontmatter(displayContent)} />
          </div>
        ) : (
          <div className="markdown-content" style={{ color: 'var(--nim-text)' }}>
            <SyntaxHighlighter
              style={{} as any}
              customStyle={{
                backgroundColor: 'var(--nim-bg-secondary)',
                color: 'var(--nim-text)',
                padding: '0.5rem 0.75rem',
                margin: 0,
                fontSize: '0.8125rem',
                lineHeight: '1.5',
              }}
              language={language || undefined}
              PreTag="div"
              codeTagProps={{
                style: {
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 'inherit',
                  background: 'none',
                },
              }}
            >
              {displayContent}
            </SyntaxHighlighter>
          </div>
        )}

        {/* Gradient fade when collapsed */}
        {isCollapsed && (
          <div
            className="absolute bottom-0 left-0 right-0 flex items-end justify-center pb-2"
            style={{
              height: '4rem',
              background: 'linear-gradient(to bottom, transparent, var(--nim-bg-secondary))',
            }}
          >
            <button
              onClick={() => setIsCollapsed(false)}
              className="text-xs text-[var(--nim-link)] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-full px-3 py-1 cursor-pointer hover:bg-[var(--nim-bg-hover)]"
            >
              Show all {lineCount} lines
            </button>
          </div>
        )}
      </div>

      {/* Collapse button when expanded and file is long */}
      {!isCollapsed && isLong && (
        <div className="flex justify-center py-1.5 border-t border-[var(--nim-border)]">
          <button
            onClick={() => setIsCollapsed(true)}
            className="text-xs text-[var(--nim-text-faint)] bg-transparent border-none cursor-pointer hover:text-[var(--nim-text-muted)]"
          >
            Collapse
          </button>
        </div>
      )}
    </div>
  );
};
