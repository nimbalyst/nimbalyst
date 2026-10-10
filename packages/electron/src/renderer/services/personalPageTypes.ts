/**
 * Which page types a Local page can hold. A Local page is a file in the
 * project's wiki folder (the `@nimbalyst/local-wiki` format): markdown, or any
 * shareable editor type (drawing, mind map, data model...) as its own file
 * with a sidecar. Code stays out: a wiki is not a source folder.
 */
export function personalPageSupportsType(documentType: string): boolean {
  return documentType !== 'code';
}

interface EditorTypeDescriptor {
  documentType: string;
  defaultExtension: string;
  capabilities?: { shareToTeam?: boolean };
}

/**
 * Suffix to document type for every editor type the catalog can share, for
 * main to recognize those files when they are dropped into the wiki folder.
 * The default extension is the suffix the catalog has checked for sharing.
 */
export function localWikiEditorTypes(descriptors: readonly EditorTypeDescriptor[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const descriptor of descriptors) {
    if (descriptor.documentType === 'markdown' || !personalPageSupportsType(descriptor.documentType)) continue;
    if (descriptor.capabilities?.shareToTeam !== true || !descriptor.defaultExtension) continue;
    out[descriptor.defaultExtension.toLowerCase()] = descriptor.documentType;
  }
  return out;
}

/**
 * The tree shows a non-markdown page with its extension ("Flow.excalidraw"),
 * as the Team section does; the wiki stores the bare stem. These convert.
 */
export function localPageTreeTitle(title: string, documentType: string, fileExtension: string): string {
  return documentType === 'markdown' ? title : `${title}${fileExtension}`;
}

export function localPageWikiTitle(title: string, fileExtension: string | null | undefined): string {
  if (!fileExtension) return title;
  return title.toLowerCase().endsWith(fileExtension.toLowerCase()) && title.length > fileExtension.length
    ? title.slice(0, -fileExtension.length)
    : title;
}
