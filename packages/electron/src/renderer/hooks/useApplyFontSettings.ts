import { useLayoutEffect } from 'react';
import { CODE_FONT_CHANGED_EVENT } from '@nimbalyst/runtime';
import { useSetting } from './useSetting';
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  toFontFamilyCss,
} from '../utils/fontSettings';

/**
 * Publishes the font settings as CSS variables on the document root:
 * `--nim-font-ui` (read by index.css) and `--nim-code-font-family` / `--nim-code-font-size`
 * (read by Monaco through the runtime's `useCodeFont`). The terminal reads its own settings.
 */
export function useApplyFontSettings(): void {
  const uiFamily = useSetting('appearance.uiFontFamily');
  const codeFamily = useSetting('appearance.codeFontFamily');
  const codeSize = useSetting('appearance.editorFontSize');

  useLayoutEffect(() => {
    const root = document.documentElement.style;
    if (uiFamily.trim() === '') {
      root.removeProperty('--nim-font-ui');
    } else {
      root.setProperty('--nim-font-ui', toFontFamilyCss(uiFamily, DEFAULT_UI_FONT_STACK));
    }
    root.setProperty('--nim-code-font-family', toFontFamilyCss(codeFamily, DEFAULT_CODE_FONT_STACK));
    root.setProperty('--nim-code-font-size', String(codeSize));
    window.dispatchEvent(new Event(CODE_FONT_CHANGED_EVENT));
  }, [uiFamily, codeFamily, codeSize]);
}
