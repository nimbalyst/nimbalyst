import type { CollabHost } from '@nimbalyst/collab-client/core';

export function bucketItemCount(count: number): '0' | '1' | '2-5' | '6-20' | '21+' {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '21+';
}

export function bucketQueryLength(length: number): '1-3' | '4-10' | '11-30' | '31+' {
  if (length <= 3) return '1-3';
  if (length <= 10) return '4-10';
  if (length <= 30) return '11-30';
  return '31+';
}

export function stableCategory(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return normalized || 'unknown';
}

export function trackDocumentAction(host: CollabHost, params: {
  action: string;
  documentType: string | null | undefined;
  entryPoint: string;
}) {
  host.trackEvent?.('collab_document_action', {
    surface: host.surface ?? 'desktop',
    action: params.action,
    actorType: 'user',
    documentType: stableCategory(params.documentType),
    entryPoint: params.entryPoint,
  });
}
