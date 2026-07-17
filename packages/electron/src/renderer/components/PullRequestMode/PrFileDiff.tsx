/**
 * PrFileDiff — GitHub-web-style unified diff for a single PR file.
 *
 * Renders directly from the GitHub `patch` string (already a unified diff) via
 * react-diff-view. No Monaco diff worker is involved, so added/removed files and
 * empty sides never trigger "no diff result available", and the light DOM output
 * virtualizes cleanly in the collapsed-diff stream.
 *
 * Syntax highlighting is produced by refractor (Prism) and colored by the
 * GitHub-style token palette in `prFileDiff.css`.
 */

import type { JSX } from 'react';
import { useMemo } from 'react';
import { Diff, Hunk, parseDiff, tokenize, type HunkData } from 'react-diff-view';
import refractor from 'refractor';
import type { PullRequestFileRow } from '../../services/RendererPullRequestService';
import 'react-diff-view/style/index.css';
import './prFileDiff.css';

interface PrFileDiffProps {
  file: PullRequestFileRow;
  isDark: boolean;
  /** 'unified' (stacked, GitHub default) or 'split' (side-by-side). */
  viewType?: 'unified' | 'split';
}

/** File extension → refractor/Prism language name. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  json5: 'json5',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
  pl: 'perl',
  ps1: 'powershell',
  proto: 'protobuf',
  hcl: 'hcl',
  tf: 'hcl',
};

/** Map a file path to a registered refractor language, or undefined. */
function refractorLanguage(filePath: string): string | undefined {
  const name = (filePath.split('/').pop() ?? filePath).toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const language = EXT_TO_LANGUAGE[ext];
  return language && refractor.registered(language) ? language : undefined;
}

/**
 * GitHub's per-file `patch` is hunk text only (`@@ ... @@`). react-diff-view's
 * parser needs a full git diff, so synthesize the file headers around it.
 */
function buildUnifiedDiff(file: PullRequestFileRow): string | null {
  if (file.patch == null) return null;

  const newPath = file.path;
  const oldPath = file.previousPath ?? file.path;
  const header: string[] = [];

  if (file.status === 'added') {
    header.push(`diff --git a/${newPath} b/${newPath}`);
    header.push('new file mode 100644');
    header.push('--- /dev/null');
    header.push(`+++ b/${newPath}`);
  } else if (file.status === 'removed') {
    header.push(`diff --git a/${oldPath} b/${oldPath}`);
    header.push('deleted file mode 100644');
    header.push(`--- a/${oldPath}`);
    header.push('+++ /dev/null');
  } else {
    header.push(`diff --git a/${oldPath} b/${newPath}`);
    if (file.previousPath && file.previousPath !== file.path) {
      header.push(`rename from ${oldPath}`);
      header.push(`rename to ${newPath}`);
    }
    header.push(`--- a/${oldPath}`);
    header.push(`+++ b/${newPath}`);
  }

  const patch = file.patch.endsWith('\n') ? file.patch : `${file.patch}\n`;
  return `${header.join('\n')}\n${patch}`;
}

export function PrFileDiff({ file, isDark, viewType = 'unified' }: PrFileDiffProps): JSX.Element {
  const parsed = useMemo(() => {
    const unified = buildUnifiedDiff(file);
    if (!unified) return { hunks: null as HunkData[] | null, diffType: 'modify' as const, error: null as string | null };
    try {
      const files = parseDiff(unified, { nearbySequences: 'zip' });
      const first = files[0];
      if (!first) return { hunks: null, diffType: 'modify' as const, error: null };
      return { hunks: first.hunks, diffType: first.type, error: null };
    } catch (err) {
      return {
        hunks: null,
        diffType: 'modify' as const,
        error: err instanceof Error ? err.message : 'Failed to parse diff',
      };
    }
  }, [file]);

  const tokens = useMemo(() => {
    if (!parsed.hunks) return undefined;
    const language = refractorLanguage(file.path);
    if (!language) return undefined;
    try {
      return tokenize(parsed.hunks, { highlight: true, refractor, language });
    } catch {
      // Highlighting is best-effort; fall back to plain text on any failure.
      return undefined;
    }
  }, [parsed.hunks, file.path]);

  if (parsed.error) {
    return (
      <div className="px-4 py-6 text-sm text-nim-error">Unable to render diff: {parsed.error}</div>
    );
  }

  if (!parsed.hunks || parsed.hunks.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-nim-faint">
        No textual changes to display for this file.
      </div>
    );
  }

  return (
    <div className={`pr-diff-view ${isDark ? 'pr-diff-view--dark' : ''}`}>
      <Diff viewType={viewType} diffType={parsed.diffType} hunks={parsed.hunks} tokens={tokens}>
        {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
      </Diff>
    </div>
  );
}
