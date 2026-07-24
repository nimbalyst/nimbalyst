/**
 * TranscriptMathHost is mounted by the host as a Nimbalyst `hostComponent`.
 *
 * On mount it contributes `remark-math` / `rehype-katex` to the transcript
 * markdown registry; on unmount it clears its own registrations. The shared
 * KaTeX stylesheet is loaded once through the extension manifest.
 */

import { useEffect } from 'react';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  clearTranscriptMarkdownContributions,
  setTranscriptMarkdownContributions,
} from '@nimbalyst/runtime';
import { KATEX_SAFE_OPTIONS } from './katexOptions';

const SOURCE = 'com.nimbalyst.math';

export function TranscriptMathHost(): null {
  useEffect(() => {
    setTranscriptMarkdownContributions(SOURCE, {
      remarkPlugins: [remarkMath],
      rehypePlugins: [[rehypeKatex, KATEX_SAFE_OPTIONS]],
    });
    return () => {
      clearTranscriptMarkdownContributions(SOURCE);
    };
  }, []);
  return null;
}
