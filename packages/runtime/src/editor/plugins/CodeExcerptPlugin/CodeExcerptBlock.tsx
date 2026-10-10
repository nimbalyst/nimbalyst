/**
 * The rendered code excerpt: a header (path, range, commit, drift badge), the
 * snapshot highlighted with the transcript's Prism highlighter, and actions
 * to open the file or update the excerpt to what the file holds now.
 *
 * The snapshot is always what is shown. Drift is checked against the file as
 * committed at HEAD when a host can read it; without one the block is just
 * the quoted code.
 *
 * Nothing read from disk enters the document without a click: opening a page
 * (including an excerpt a teammate wrote, with or without a snapshot) only
 * reads for the badge. Every write is conditional on the block still holding
 * the source the read started from, so a concurrent edit is never overwritten.
 */

import React, { useEffect, useMemo, useState, type JSX } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $getNodeByKey, type NodeKey } from 'lexical';

import { $replaceExcerptSource } from './CodeExcerptNodeCore';
import { PlacedViewResizeFrame } from '../EmbedPlugin/PlacedViewResizeFrame';
import { useBlockActions, type BlockActionHandlers } from '../DraggableBlockPlugin/useBlockActions';
import { openExcerptFile, readExcerptFile, toWorkspaceRelative, type CodeExcerptFile } from './CodeExcerptCallbacks';
import { classifyExcerptDrift, diffLines, type ExcerptDrift } from './excerptDrift';
import {
  buildExcerptSource,
  excerptSizeAttrs,
  setExcerptSize,
  formatLineRange,
  parseExcerptRef,
  parseExcerptSource,
  sliceLines,
  updateExcerptSource,
  type LineRange,
} from './excerptSource';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', php: 'php',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown', mdx: 'markdown',
  sql: 'sql', graphql: 'graphql', sh: 'bash', bash: 'bash', zsh: 'bash',
};

function languageFor(path: string): string | undefined {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'docker';
  return LANGUAGE_BY_EXTENSION[name.split('.').pop() ?? ''];
}

type Check =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; source: string; file: CodeExcerptFile; drift: ExcerptDrift | null };

const BADGE: Record<ExcerptDrift['state'], { label: string; tone: string }> = {
  unchanged: { label: 'Up to date', tone: 'text-nim-success' },
  moved: { label: 'Moved', tone: 'text-nim-warning' },
  changed: { label: 'Changed', tone: 'text-nim-warning' },
  missing: { label: 'Not in the repo at HEAD', tone: 'text-nim-error' },
};

function NewExcerptForm({ onSubmit }: { onSubmit: (path: string, range: LineRange) => Promise<string | null> }): JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = parseExcerptRef(text);
  const valid = !!ref && !!ref.range;
  return (
    <form
      className="code-excerpt-new flex flex-wrap items-center gap-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (ref?.range) void onSubmit(toWorkspaceRelative(ref.path), ref.range).then(setError);
      }}
    >
      <input
        className="min-w-0 flex-1 rounded border border-nim bg-nim-tertiary px-2 py-1 font-mono text-xs text-nim focus:border-[var(--nim-border-focus)] focus:outline-none"
        placeholder="path/to/file.ts#L10-L40"
        value={text}
        autoFocus
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
        data-testid="code-excerpt-ref-input"
      />
      <button type="submit" disabled={!valid} className="rounded border border-nim bg-nim-tertiary px-2 py-1 text-xs text-nim disabled:opacity-50">
        Quote lines
      </button>
      {error ? <div role="alert" className="w-full text-xs text-nim-error">{error}</div> : null}
    </form>
  );
}

export function CodeExcerptBlock({ source, nodeKey }: { source: string; nodeKey: NodeKey }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const excerpt = useMemo(() => parseExcerptSource(source), [source]);
  const [check, setCheck] = useState<Check>({ status: 'idle' });
  const [showDiff, setShowDiff] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const { path, range, snapshot } = excerpt;

  useEffect(() => {
    if (!path || !range || excerpt.error) return;
    let live = true;
    const readFor = source;
    setCheck({ status: 'loading' });
    // Read only: the result feeds the badge, never the document.
    void readExcerptFile(path).then((file) => {
      if (!live) return;
      if (!file) {
        setCheck({ status: 'idle' });
        return;
      }
      const drift = file.refused || !snapshot ? null : classifyExcerptDrift(snapshot, file.text, range);
      setCheck({ status: 'done', source: readFor, file, drift });
    });
    return () => {
      live = false;
    };
    // `source` covers path/range/snapshot; `refresh` re-reads on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, refresh]);

  /** Write only if the block still holds what the read was based on; otherwise re-read. */
  const writeIfUnchanged = (expected: string, next: string): void => {
    let applied = false;
    editor.update(() => {
      applied = $replaceExcerptSource(nodeKey, expected, next);
    }, { discrete: true });
    if (!applied) setRefresh((n) => n + 1);
  };

  /** The slash flow: the user typed a reference and clicked, so quoting the lines is their action. */
  const quoteNew = async (newPath: string, newRange: LineRange): Promise<string | null> => {
    const startedFrom = source;
    const file = await readExcerptFile(newPath);
    if (!file) return 'The repo is not available here.';
    if (file.refused) return file.refused;
    if (file.text === null) return `${newPath} is not in the repo at HEAD.`;
    writeIfUnchanged(startedFrom, buildExcerptSource({ path: newPath, range: newRange, commit: file.head, snapshot: sliceLines(file.text, newRange) }));
    return null;
  };

  // Block-menu actions, filled in below once the drift check is known (the hook must run before the early return).
  const menuActions: Record<string, BlockActionHandlers[string]> = {};
  useBlockActions(nodeKey, menuActions);

  if (!path && !excerpt.error && editable) {
    return (
      <div className="code-excerpt-block my-3 rounded-lg border border-nim bg-nim-secondary" contentEditable={false} data-testid="code-excerpt-block">
        <NewExcerptForm onSubmit={quoteNew} />
      </div>
    );
  }

  const drift = check.status === 'done' ? check.drift : null;
  const file = check.status === 'done' ? check.file : null;
  const canQuote = editable && !!file?.text && !!range && !file.refused;
  const updateToCurrent = () => {
    if (check.status !== 'done' || !check.file.text || !range) return;
    const nextRange = drift?.state === 'moved' ? drift.movedTo : range;
    writeIfUnchanged(check.source, updateExcerptSource(check.source, { range: nextRange, commit: check.file.head, snapshot: sliceLines(check.file.text, nextRange) }));
    setShowDiff(false);
  };
  const action = 'cursor-pointer border-none bg-transparent p-0 text-[11px] text-nim-link hover:underline';
  if (canQuote && (!snapshot || drift?.state === 'changed' || drift?.state === 'moved')) menuActions.update = updateToCurrent;
  if (file && drift?.state !== 'missing' && range) menuActions['open-file'] = () => openExcerptFile(file.absolutePath, drift?.state === 'moved' ? drift.movedTo.start : range.start);
  if (file) menuActions.recheck = () => setRefresh((n) => n + 1);
  // Width and code-area height from the corner grip, saved as header keys.
  const sizeAttrs = excerptSizeAttrs(source);
  const codeHeight = sizeAttrs.height ? `${sizeAttrs.height}px` : undefined;
  const onSizeChange = editable ? (patch: Readonly<Record<string, string | null>>) => writeIfUnchanged(source, setExcerptSize(source, patch)) : undefined;

  return (
    <PlacedViewResizeFrame attrs={sizeAttrs} onAttrsChange={onSizeChange}>
    <div className="code-excerpt-block my-3 max-w-full overflow-hidden rounded-lg border border-nim bg-nim-secondary" contentEditable={false} data-testid="code-excerpt-block" data-drift={drift?.state ?? 'unknown'}>
      <div className="code-excerpt-header flex min-w-0 items-center gap-2 border-b border-nim px-3 py-1.5 text-[11px] text-nim-muted">
        <span className="truncate font-mono text-nim select-text" title={path}>{path || 'excerpt'}</span>
        {range ? <span className="shrink-0 font-mono">L{formatLineRange(range)}</span> : null}
        {excerpt.commit ? <span className="shrink-0 font-mono text-nim-faint" title={`Quoted at ${excerpt.commit}`}>@{excerpt.commit.slice(0, 9)}</span> : null}
        {drift ? (
          <span className={`code-excerpt-drift shrink-0 font-medium ${BADGE[drift.state].tone}`} data-testid="code-excerpt-drift">
            {drift.state === 'moved' ? `Moved to L${formatLineRange(drift.movedTo)}` : BADGE[drift.state].label}
          </span>
        ) : null}
        {file?.refused ? (
          <span className="code-excerpt-drift shrink-0 text-nim-faint" title={file.refused} data-testid="code-excerpt-drift">Not checked</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {canQuote && !snapshot ? (
            <button type="button" className={action} onClick={updateToCurrent} data-testid="code-excerpt-update">Quote lines</button>
          ) : null}
          {drift?.state === 'changed' ? (
            <button type="button" className={action} onClick={() => setShowDiff(!showDiff)}>{showDiff ? 'Hide changes' : 'Show changes'}</button>
          ) : null}
          {canQuote && (drift?.state === 'changed' || drift?.state === 'moved') ? (
            <button type="button" className={action} onClick={updateToCurrent} data-testid="code-excerpt-update">
              {drift.state === 'moved' ? 'Update range' : 'Update to current'}
            </button>
          ) : null}
          {file && drift?.state !== 'missing' && range ? (
            <button type="button" className={action} onClick={() => openExcerptFile(file.absolutePath, drift?.state === 'moved' ? drift.movedTo.start : range.start)}>Open file</button>
          ) : null}
          {file ? (
            <button type="button" className={action} title="Check again" onClick={() => setRefresh((n) => n + 1)}>Recheck</button>
          ) : null}
        </span>
      </div>
      {excerpt.error ? (
        <div role="alert" className="code-excerpt-error px-3 py-2 font-mono text-xs text-nim-error select-text">{excerpt.error}</div>
      ) : null}
      {showDiff && drift?.state === 'changed' ? (
        <pre className="code-excerpt-diff m-0 max-h-[360px] overflow-auto px-3 py-2 font-mono text-xs select-text">
          {diffLines(snapshot, drift.current).map((op, index) => (
            <div key={index} className={op.kind === 'added' ? 'text-nim-success' : op.kind === 'removed' ? 'text-nim-error' : 'text-nim-muted'}>
              {op.kind === 'added' ? '+ ' : op.kind === 'removed' ? '- ' : '  '}{op.text}
            </div>
          ))}
        </pre>
      ) : (
        // The global Prism theme paints boxes behind operators; tokens here carry color only.
        <div className={`code-excerpt-code overflow-auto select-text [&_.token]:!bg-transparent ${codeHeight ? '' : 'max-h-[480px]'}`} style={codeHeight ? { height: codeHeight } : undefined} data-placed-view-body="">
          <SyntaxHighlighter
            style={{} as any}
            language={languageFor(path)}
            showLineNumbers={!!range}
            startingLineNumber={range?.start ?? 1}
            PreTag="div"
            customStyle={{ background: 'transparent', color: 'var(--nim-text)', margin: 0, padding: '0.5rem 0.75rem', fontSize: '0.8125rem', lineHeight: '1.5' }}
            lineNumberStyle={{ color: 'var(--nim-text-faint)', minWidth: '2.5em' }}
            codeTagProps={{ style: { fontFamily: 'var(--font-mono, monospace)', fontSize: 'inherit', background: 'none' } }}
          >
            {snapshot}
          </SyntaxHighlighter>
        </div>
      )}
      {!snapshot ? <div className="px-3 py-2 text-xs text-nim-faint">No lines quoted yet.</div> : null}
    </div>
    </PlacedViewResizeFrame>
  );
}
