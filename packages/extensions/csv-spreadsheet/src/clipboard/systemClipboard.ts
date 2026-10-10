/**
 * The system clipboard, for copy/cut/paste in the grid.
 *
 * Keyboard copy and paste go through the native `copy` / `paste` events, whose
 * `DataTransfer` carries every MIME type at once (TSV, HTML, our JSON). Menu
 * actions have no event; they use the async Clipboard API, which only
 * round-trips `text/plain` and `text/html` reliably, so the last internal copy
 * is also kept in memory and offered whenever the plain text still matches it.
 */

import { copyToClipboard, readClipboard } from '@nimbalyst/extension-sdk';
import type { CellStyle, CellColor } from '../types';
import { INTERNAL_CLIPBOARD_MIME, type ClipboardInput, type CopyPayload } from './copyPayload';
import type { HtmlCellStyle } from './htmlTable';

let lastInternalJson: string | null = null;

export async function writeClipboard(payload: CopyPayload, transfer?: DataTransfer | null): Promise<void> {
  lastInternalJson = payload.internalJson;
  if (transfer) {
    transfer.setData('text/plain', payload.text);
    transfer.setData('text/html', payload.html);
    transfer.setData(INTERNAL_CLIPBOARD_MIME, payload.internalJson);
    return;
  }
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
          'text/html': new Blob([payload.html], { type: 'text/html' }),
        }),
      ]);
      return;
    }
  } catch {
    // Fall through to the host's text-only clipboard.
  }
  await copyToClipboard(payload.text);
}

export async function readClipboardInput(transfer?: DataTransfer | null): Promise<ClipboardInput> {
  if (transfer) {
    return {
      text: transfer.getData('text/plain'),
      html: transfer.getData('text/html'),
      internalJson: transfer.getData(INTERNAL_CLIPBOARD_MIME) || lastInternalJson,
    };
  }
  let html: string | null = null;
  let text: string | null = null;
  try {
    if (navigator.clipboard?.read) {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
    }
  } catch {
    // Permission denied or unsupported: the host can still read text.
  }
  text ??= (await readClipboard()) ?? '';
  return { text, html, internalJson: lastInternalJson };
}

const TEXT_COLORS: Record<Exclude<CellColor, 'default'>, string> = {
  red: '#c62828', orange: '#e65100', yellow: '#f9a825', green: '#2e7d32',
  blue: '#1565c0', purple: '#6a1b9a', gray: '#616161',
};
const FILL_COLORS: Record<Exclude<CellColor, 'default'>, string> = {
  red: '#fce8e6', orange: '#fef0e1', yellow: '#fef7d7', green: '#e6f4ea',
  blue: '#e8f0fe', purple: '#f3e8fd', gray: '#f1f3f4',
};

/** A named cell style as concrete inline HTML for other apps. */
export function toHtmlCellStyle(style: CellStyle | null): HtmlCellStyle | undefined {
  if (!style) return undefined;
  return {
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikethrough: style.strikethrough,
    color: style.textColor && style.textColor !== 'default'
      ? (style.textColor.startsWith('#') ? style.textColor : TEXT_COLORS[style.textColor as Exclude<CellColor, 'default'>])
      : undefined,
    backgroundColor: style.fillColor && style.fillColor !== 'default'
      ? (style.fillColor.startsWith('#') ? style.fillColor : FILL_COLORS[style.fillColor as Exclude<CellColor, 'default'>])
      : undefined,
    align: style.align,
  };
}
