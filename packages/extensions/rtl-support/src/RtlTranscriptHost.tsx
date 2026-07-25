/**
 * RtlTranscriptHost — a host component mounted by Nimbalyst that registers
 * transcript markdown contributions.
 *
 * Two-pronged strategy:
 *  1. rehypePlugin: dir attribute on hAST nodes (fallback for standard renderers)
 *  2. inline detection (optional): isolates RTL runs without replacing the
 *     host's markdown presentation components
 */

import { useEffect } from 'react';
import {
  setTranscriptMarkdownContributions,
  clearTranscriptMarkdownContributions,
} from '@nimbalyst/runtime';
import { rehypeRtlDetect } from './rehypeRtlDetect';
import { loadSettings, type RtlSettings } from './settings';
import { debug } from './debug';

const SOURCE = 'com.nimbalyst.rtl-support';

function buildPluginOptions(settings: RtlSettings) {
  return {
    threshold: settings.threshold,
    perBlock: settings.perBlock,
    mode: settings.mode,
    inlineDetect: settings.inlineDetect,
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
