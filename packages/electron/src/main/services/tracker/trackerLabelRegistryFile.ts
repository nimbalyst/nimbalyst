/**
 * The LOCAL COPY of a workspace's label registry: `.nimbalyst/labels.yaml`.
 *
 * Same contract as `trackerPredicateRegistryFile.ts`: the room owns the
 * registry and publishes it on the schema lane; this file is the projection of
 * what arrived, plus the authoring surface for a project with no room yet.
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import {
  parseLabelRegistryYAML,
  serializeLabelRegistryYAML,
  type LabelRegistry,
} from '@nimbalyst/tracker-schema';
import { logger } from '../../utils/logger';
import { requestTrackerSchemaFlush } from './trackerSchemaFlush';

export const LABEL_REGISTRY_FILENAME = 'labels.yaml';

export function workspaceLabelRegistryPath(workspacePath: string): string {
  return path.join(workspacePath, '.nimbalyst', LABEL_REGISTRY_FILENAME);
}

/**
 * Read the local copy: an empty registry when there is no file, the registry
 * when it is valid, and `null` when the file exists but is unreadable or
 * invalid -- the caller keeps the registry already in force rather than
 * replacing it with nothing mid hand-edit.
 */
export function readWorkspaceLabelRegistry(workspacePath: string): LabelRegistry | null {
  const filePath = workspaceLabelRegistryPath(workspacePath);
  let content: string;
  try {
    if (!fs.existsSync(filePath)) return { labels: [], properties: [], claimProperties: {} };
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.main.warn('[trackerLabelRegistry] could not read', filePath, err);
    return null;
  }

  const result = parseLabelRegistryYAML(content);
  if (!result.valid) {
    logger.main.warn(
      `[trackerLabelRegistry] ${filePath} is invalid; keeping the registry already in force:`,
      result.issues.map(issue => `${issue.code} at '${issue.path}': ${issue.message}`).join('; '),
    );
    return null;
  }
  return result.registry;
}

/** Project a registry onto the local copy and publish it to the room. */
export async function writeWorkspaceLabelRegistry(
  workspacePath: string,
  registry: LabelRegistry,
): Promise<string> {
  const filePath = workspaceLabelRegistryPath(workspacePath);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, serializeLabelRegistryYAML(registry), 'utf-8');
  requestTrackerSchemaFlush(workspacePath);
  return filePath;
}
