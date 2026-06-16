/**
 * RtlTranscriptHost — a host component mounted by Nimbalyst that registers
 * transcript markdown contributions.
 *
 * Three-pronged strategy:
 *  1. rehypePlugin: dir attribute on hAST nodes (fallback for standard renderers)
 *  2. component overrides: p, li, blockquote, h1-h6, table/td/th — the main path
 *     (Nimbalyst's MarkdownRenderer uses custom React components)
 *  3. inline detection (optional): isolates RTL runs within LTR paragraphs
 */

import { createElement, useEffect, type ReactNode } from 'react';
import {
  setTranscriptMarkdownContributions,
  clearTranscriptMarkdownContributions,
} from '@nimbalyst/runtime';
import { rehypeRtlDetect } from './rehypeRtlDetect';
import { detectDirection, detectInlineRuns } from './detection';
import { loadSettings, type RtlSettings } from './settings';
import { debug } from './debug';

const SOURCE = 'com.nimbalyst.rtl-support';

function buildPluginOptions(settings: RtlSettings) {
  return {
    threshold: settings.threshold,
    perBlock: settings.perBlock,
    mode: settings.mode,
  };
}

/** Extract text from React children */
function textFromChildren(children: ReactNode): string {
  if (children == null || children === false) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join('');
  if (typeof children === 'object' && 'props' in (children as unknown as Record<string, unknown>)) {
    const props = (children as unknown as { props?: { children?: ReactNode } }).props;
    return props ? textFromChildren(props.children) : '';
  }
  return '';
}

/** Render children with inline isolation for RTL runs */
function renderInline(children: ReactNode, enableInline: boolean): ReactNode {
  if (!enableInline) return children;

  const text = textFromChildren(children);
  if (!text) return children;
  // Quick check: skip processing if text has no RTL characters
  // (Unicode ranges U+0590..U+08FF and presentation forms U+FB1D..U+FEFF)
  const hasRtl = Array.from(text).some((ch) => {
    const cp = ch.codePointAt(0)!;
    return (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfeff);
  });
  if (!hasRtl) return children;

  const runs = detectInlineRuns(text);
  if (runs.length <= 1) return children;

  return runs.map((run, i) =>
    run.direction === 'rtl'
      ? createElement('span', {
          key: i,
          dir: 'rtl',
          style: { unicodeBidi: 'isolate' },
        }, run.text)
      : createElement('span', {
          key: i,
          dir: 'ltr',
          style: { unicodeBidi: 'isolate' },
        }, run.text)
  );
}

/**
 * Build component overrides for text blocks.
 * Each override analyzes its children and applies the appropriate direction.
 */
function buildComponentOverrides(settings: RtlSettings) {
  const opts = buildPluginOptions(settings);
  const inline = settings.inlineDetect;

  const dirFor = (children: ReactNode): 'rtl' | 'ltr' => {
    if (opts.mode === 'rtl') return 'rtl';
    if (opts.mode === 'ltr') return 'ltr';
    return detectDirection(textFromChildren(children), opts.threshold);
  };

  // Text blocks with direction detection + styling
  const blockTag = (Tag: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function RtlBlock(props: any) {
      const dir = dirFor(props.children);
      const { className, style, children, ...rest } = props;
      return createElement(Tag, {
        ...rest,
        dir,
        className: 'nim-rtl-block nim-rtl-' + dir + (className ? ' ' + className : ''),
        style: dir === 'rtl'
          ? { direction: 'rtl', textAlign: 'right', unicodeBidi: 'plaintext', ...(style || {}) }
          : { ...(style || {}) },
      }, inline ? renderInline(children, inline) : children);
    };

  // Table cells — direction detection without inline (tables are usually simpler)
  const cellTag = (Tag: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function RtlCell(props: any) {
      const dir = dirFor(props.children);
      const { className, style, ...rest } = props;
      return createElement(Tag, {
        ...rest,
        dir,
        className: 'nim-rtl-cell nim-rtl-' + dir + (className ? ' ' + className : ''),
        style: dir === 'rtl'
          ? { direction: 'rtl', textAlign: 'right', ...(style || {}) }
          : { ...(style || {}) },
      });
    };

  // The table itself — mirrors if its dominant content is RTL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function RtlTable(props: any) {
    const dir = dirFor(props.children);
    const { className, style, ...rest } = props;
    return createElement('table', {
      ...rest,
      dir,
      className: 'nim-rtl-table nim-rtl-' + dir + (className ? ' ' + className : ''),
      style: dir === 'rtl'
        ? { direction: 'rtl', ...(style || {}) }
        : { ...(style || {}) },
    });
  }

  return {
    p: blockTag('p'),
    li: blockTag('li'),
    blockquote: blockTag('blockquote'),
    h1: blockTag('h1'),
    h2: blockTag('h2'),
    h3: blockTag('h3'),
    h4: blockTag('h4'),
    h5: blockTag('h5'),
    h6: blockTag('h6'),
    td: cellTag('td'),
    th: cellTag('th'),
    table: RtlTable,
  };
}

export function RtlTranscriptHost(): null {
  useEffect(() => {
    const settings = loadSettings();
    debug('host mounted', settings);

    if (!settings.enabled) {
      debug('disabled — not registering');
      return;
    }

    let registered = false;
    try {
      setTranscriptMarkdownContributions(SOURCE, {
        rehypePlugins: [[rehypeRtlDetect, buildPluginOptions(settings)] as const],
        components: buildComponentOverrides(settings),
      });
      registered = true;
      debug('contribution registered');
    } catch (e) {
      console.error('[RTL Support] failed to register contribution:', e);
    }

    return () => {
      if (registered) {
        try {
          clearTranscriptMarkdownContributions(SOURCE);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return null;
}
