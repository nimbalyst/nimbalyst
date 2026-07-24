import type { StreamingConfig } from './types';

export interface TextReplacement {
  oldText: string;
  newText: string;
}

function getBridge(): any {
  const bridge = (globalThis as any).aiChatBridge;
  if (!bridge) throw new Error('Editor bridge not available');
  return bridge;
}

export function startStreamingEdit(config: StreamingConfig & { id: string }) {
  const bridge = getBridge();
  bridge.startStreamingEdit(config as any);
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('aiStreamEditStart', { detail: config }));
    }
  } catch {}
}

export function streamContent(streamId: string, content: string) {
  const bridge = getBridge();
  bridge.streamContent(streamId, content);
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('aiStreamEditContent', { detail: { streamId, content } }));
    }
  } catch {}
}

export function endStreamingEdit(streamId: string) {
  const bridge = getBridge();
  bridge.endStreamingEdit(streamId);
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('aiStreamEditEnd', { detail: { streamId } }));
    }
  } catch {}
}

export function getDocumentContent(): string {
  const bridge = getBridge();
  if (typeof bridge.getContent !== 'function') {
    throw new Error('Editor bridge cannot get content');
  }
  return bridge.getContent();
}

export async function applyReplacements(replacements: TextReplacement[]) {
  const bridge = getBridge();
  if (typeof bridge.applyReplacements !== 'function') {
    throw new Error('Editor bridge cannot apply replacements');
  }
  const count = Array.isArray(replacements) ? replacements.length : 0;
  try {
    // eslint-disable-next-line no-console
    console.info('[runtime][bridge] applyReplacements invoked', { replacements: count });
  } catch {}
  const result = await bridge.applyReplacements(replacements);
  try {
    // eslint-disable-next-line no-console
    console.info('[runtime][bridge] applyReplacements result', result);
  } catch {}
  return result;
}

export async function createDocument(args: {
  filePath: string;
  initialContent?: string;
  switchToFile?: boolean;
}): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const bridge = getBridge();
  if (typeof bridge.createDocument !== 'function') {
    throw new Error('Editor bridge cannot create documents');
  }
  try {
    // eslint-disable-next-line no-console
    console.info('[runtime][bridge] createDocument invoked', { filePath: args.filePath });
  } catch {}
  const result = await bridge.createDocument(args);
  try {
    // eslint-disable-next-line no-console
    console.info('[runtime][bridge] createDocument result', result);
  } catch {}
  return result;
}
