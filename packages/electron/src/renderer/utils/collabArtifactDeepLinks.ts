import type { TrackerDeepLinkView } from '../../shared/trackerDeepLinks';

export function buildSharedDocumentDeepLink(documentId: string, orgId: string): string {
  return `nimbalyst://doc/${encodeURIComponent(documentId)}?orgId=${encodeURIComponent(orgId)}`;
}

export function buildSharedFolderDeepLink(folderId: string, orgId: string): string {
  return `nimbalyst://folder/${encodeURIComponent(folderId)}?orgId=${encodeURIComponent(orgId)}`;
}

export interface BuildTrackerDeepLinkOptions {
  view?: TrackerDeepLinkView;
}

export function buildTrackerDeepLink(
  trackerId: string,
  orgId: string,
  options: BuildTrackerDeepLinkOptions = {},
): string {
  if (options.view !== undefined && options.view !== 'document') {
    throw new Error(`Unsupported tracker deep-link view: ${options.view}`);
  }
  const viewParam = options.view === 'document' ? '&view=document' : '';
  return `nimbalyst://tracker/${encodeURIComponent(trackerId)}?orgId=${encodeURIComponent(orgId)}${viewParam}`;
}

export function buildTrackerDocumentDeepLink(trackerId: string, orgId: string): string {
  return buildTrackerDeepLink(trackerId, orgId, { view: 'document' });
}
