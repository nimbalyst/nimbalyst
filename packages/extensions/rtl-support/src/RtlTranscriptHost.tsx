/**
 * RtlTranscriptHost — host component که توسط Nimbalyst mount می‌شه
 * و transcript markdown contributions رو ثبت می‌کنه.
 *
 * استراتژی سه‌گانه:
 *  1. rehypePlugin: dir attribute روی hAST nodes (fallback برای renderer‌های استاندارد)
 *  2. components overrides: p, li, blockquote, h1-h6, table/td/th — راه‌حل اصلی
 *     (Nimbalyst MarkdownRenderer از component سفارشی استفاده می‌کنه)
 *  3. inline detection (اختیاری): run‌های RTL داخل پاراگراف LTR رو isolate می‌کنه
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

/** استخراج متن از React children */
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

/** رندر children با inline isolation برای run‌های RTL */
function renderInline(children: ReactNode, enableInline: boolean): ReactNode {
  if (!enableInline) return children;

  const text = textFromChildren(children);
  if (!text || !/[֐-ࣿיִ-﻿]/.test(text)) return children;

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
 * ساخت component overrides برای بلاک‌های متنی.
 * هر override متن children رو تحلیل می‌کنه و dir مناسب رو اعمال می‌کنه.
 */
function buildComponentOverrides(settings: RtlSettings) {
  const opts = buildPluginOptions(settings);
  const inline = settings.inlineDetect;

  const dirFor = (children: ReactNode): 'rtl' | 'ltr' => {
    if (opts.mode === 'rtl') return 'rtl';
    if (opts.mode === 'ltr') return 'ltr';
    return detectDirection(textFromChildren(children), opts.threshold);
  };

  // بلاک‌های متنی با تشخیص جهت + استایل
  const blockTag = (Tag: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function RtlBlock(props: any) {
      const dir = dirFor(props.children);
      const { className, style, children, ...rest } = props;
      return createElement(Tag, {
        ...rest,
        dir,
        className: `nim-rtl-block nim-rtl-${dir}${className ? ` ${className}` : ''}`,
        style: dir === 'rtl'
          ? { direction: 'rtl', textAlign: 'right', unicodeBidi: 'plaintext', ...(style || {}) }
          : { ...(style || {}) },
      }, inline ? renderInline(children, inline) : children);
    };

  // table cells — تشخیص جهت ولی بدون inline (جدول معمولاً ساده‌ست)
  const cellTag = (Tag: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function RtlCell(props: any) {
      const dir = dirFor(props.children);
      const { className, style, ...rest } = props;
      return createElement(Tag, {
        ...rest,
        dir,
        className: `nim-rtl-cell nim-rtl-${dir}${className ? ` ${className}` : ''}`,
        style: dir === 'rtl'
          ? { direction: 'rtl', textAlign: 'right', ...(style || {}) }
          : { ...(style || {}) },
      });
    };

  // table خودش — اگر محتوای غالب RTL باشه، کل جدول mirror بشه
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function RtlTable(props: any) {
    const dir = dirFor(props.children);
    const { className, style, ...rest } = props;
    return createElement('table', {
      ...rest,
      dir,
      className: `nim-rtl-table nim-rtl-${dir}${className ? ` ${className}` : ''}`,
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
