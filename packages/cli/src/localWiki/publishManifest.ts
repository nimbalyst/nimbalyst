/**
 * What the last verified publish put in the team project
 * (`.nimbalyst/local-wiki-publish.json`): each local page's team ids, a hash
 * of what was sent, and a hash of the team body read back right after the
 * write. The server keeps no list of what an import created, so this is how a
 * later publish knows which team pages came from a local page that is gone,
 * and whether someone edited one on the team side since.
 *
 * Written whole to a temporary file and renamed into place, so a crash never
 * leaves half a manifest.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PUBLISH_MANIFEST_VERSION = 1;

export interface PublishedPage {
  /** Tree node id (`document:<id>` or `item:<id>`) and the team id. */
  nodeId: string;
  id: string;
  /** Where the body and comment threads live: the page's own document, or `tracker-content/<itemId>`. */
  documentId: string;
  kind: 'page' | 'typedPage' | 'editorPage';
  title: string;
  parentLocalId: string | null;
  /** The page file, relative to the wiki folder, to match it while its frontmatter does not parse. */
  path?: string;
  /** A typed page's type, and whether it is a table row, to hold it back while its table does not parse. */
  typeId?: string;
  underType?: true;
  link: string;
  uri?: string;
  /** Hash of what this publish sent for the page (title, place, fields, body). */
  sourceHash: string;
  /** Hash of the team body as read back after the publish; absent for an editor page. */
  teamBodyHash?: string;
  /** The local page is gone but its team copy was left in place (edited there, or not checkable). */
  removedLocally?: true;
}

export interface PublishManifest {
  version: number;
  orgId: string;
  projectId: string;
  wikiId: string;
  publishedAt: string;
  pages: Record<string, PublishedPage>;
}

export function publishManifestPath(root: string): string {
  return path.join(root, '.nimbalyst', 'local-wiki-publish.json');
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** The manifest, or null when there is none or it is for another project or wiki (nothing then counts as published). */
export function readPublishManifest(root: string, expect: { orgId: string; projectId: string; wikiId: string }): PublishManifest | null {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(publishManifestPath(root), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.pages !== 'object' || parsed.pages === null) return null;
  if (parsed.orgId !== expect.orgId || parsed.projectId !== expect.projectId || parsed.wikiId !== expect.wikiId) return null;
  return parsed as PublishManifest;
}

export function writePublishManifest(root: string, manifest: PublishManifest): void {
  const file = publishManifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
