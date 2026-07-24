/**
 * React hook helpers for consuming transcript markdown contributions.
 *
 * `useTranscriptMarkdownContributions` returns the merged contribution view
 * and re-renders whenever the registry changes.
 *
 * `useTranscriptMarkdownStyles` keeps a ref-counted set of `<style>` /
 * `<link>` tags in the document head in sync with the merged styles. Tags
 * are deduplicated by `id` so two contributors that ship the same KaTeX
 * stylesheet result in a single `<link>`, and tags are removed once the
 * last contributor that referenced them clears its registration.
 */

import { useEffect, useSyncExternalStore } from 'react';

import {
  getMergedTranscriptMarkdownContributions,
  subscribeToTranscriptMarkdownContributions,
  type MergedTranscriptMarkdownContribution,
  type TranscriptMarkdownContributedStyle,
} from './TranscriptMarkdownContributions';

export function useTranscriptMarkdownContributions(): MergedTranscriptMarkdownContribution {
  return useSyncExternalStore(
    subscribeToTranscriptMarkdownContributions,
    getMergedTranscriptMarkdownContributions,
    getMergedTranscriptMarkdownContributions,
  );
}

interface StyleRecord {
  element: HTMLStyleElement | HTMLLinkElement;
  refCount: number;
  signature: string;
}

const STYLE_DATA_ATTR = 'data-nim-transcript-style';
const installedStyles = new Map<string, StyleRecord>();

function styleSignature(style: TranscriptMarkdownContributedStyle): string {
  return style.type === 'css-text'
    ? `css:${style.cssText}`
    : `link:${style.href}`;
}

function installStyle(style: TranscriptMarkdownContributedStyle): void {
  const existing = installedStyles.get(style.id);
  const signature = styleSignature(style);
  if (existing) {
    if (existing.signature !== signature) {
      // Same id, different content -- e.g. a contributor swapped a CSS
      // payload. Drop the old element and rebuild so we never serve stale
      // styles to the renderer.
      existing.element.remove();
      installedStyles.delete(style.id);
    } else {
      existing.refCount += 1;
      return;
    }
  }
  if (typeof document === 'undefined') return;
  let element: HTMLStyleElement | HTMLLinkElement;
  if (style.type === 'css-text') {
    const styleEl = document.createElement('style');
    styleEl.textContent = style.cssText;
    element = styleEl;
  } else {
    const linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.href = style.href;
    element = linkEl;
  }
  element.setAttribute(STYLE_DATA_ATTR, style.id);
  element.id = `nim-transcript-style-${style.id}`;
  document.head.appendChild(element);
  installedStyles.set(style.id, { element, refCount: 1, signature });
}

function uninstallStyle(style: TranscriptMarkdownContributedStyle): void {
  const existing = installedStyles.get(style.id);
  if (!existing) return;
  existing.refCount -= 1;
  if (existing.refCount > 0) return;
  existing.element.remove();
  installedStyles.delete(style.id);
}

export function useTranscriptMarkdownStyles(
  styles: ReadonlyArray<TranscriptMarkdownContributedStyle>,
): void {
  useEffect(() => {
    if (styles.length === 0) return;
    for (const style of styles) {
      installStyle(style);
    }
    return () => {
      for (const style of styles) {
        uninstallStyle(style);
      }
    };
  }, [styles]);
}
