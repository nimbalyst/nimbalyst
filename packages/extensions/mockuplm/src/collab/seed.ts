/**
 * Bootstrap seeding for the MockupLM collaborative Y.Docs.
 *
 * Two formats live in one extension and each has its own Y.Doc shape:
 *
 * `.mockup.html` (single mockup) -- a single `Y.Text` named `html` carrying
 *   the raw HTML/CSS source. Same shape as `csv-spreadsheet`: identical char-
 *   level CRDT merge semantics mean two clients racing on the seed produce
 *   identical inserts that Y.Text dedupes naturally.
 *
 * `.mockupproject` (canvas of mockups + connections) -- Pattern A from the
 *   collaboration guide:
 *
 *     Y.Doc
 *     |-- mockups: Y.Map<mockupId, Y.Map>      // { path, label, position, size }
 *     |-- connections: Y.Map<edgeId, Y.Map>    // { fromMockupId, toMockupId, label, trigger, fromElementSelector }
 *     |-- meta: Y.Map<string, unknown>         // { version, name, description, designSystem, viewport }
 *
 *   Mockup ids and connection ids in the parsed `MockupProjectFile` are
 *   already stable strings (assigned at creation, persisted to disk). We use
 *   them verbatim as Y.Map keys for deterministic seeding -- two clients
 *   racing the seed will write the same key/value pairs and Y.Map's last-
 *   write-wins-per-key merge collapses to either client's individual shape.
 *
 *   Viewport lives in `meta` rather than per-client because the existing
 *   .mockupproject file format treats it as document state (same as the
 *   pre-collab Zustand store).
 */

import * as Y from 'yjs';
import {
  createEmptyProject,
  type Connection,
  type MockupProjectFile,
  type MockupReference,
} from '../types/project';

// =====================================================================
// .mockup.html (single mockup) -- Y.Text shape
// =====================================================================

export const Y_MOCKUP_HTML = 'html';

export function getYMockupText(yDoc: Y.Doc): Y.Text {
  return yDoc.getText(Y_MOCKUP_HTML);
}

export function isMockupYDocEmpty(yDoc: Y.Doc): boolean {
  return getYMockupText(yDoc).length === 0;
}

export function seedMockupYDoc(
  yDoc: Y.Doc,
  content: string | ArrayBuffer,
): void {
  const text = typeof content === 'string' ? content : decodeBuffer(content);
  if (!text) return;
  const yText = getYMockupText(yDoc);
  // Belt-and-suspenders: the SDK hook re-checks emptiness before calling
  // the seed, but a concurrent seed could land in our await gap.
  if (yText.length > 0) return;
  yText.insert(0, text);
}

// =====================================================================
// .mockupproject (canvas) -- keyed entities shape
// =====================================================================

export const Y_PROJECT_MOCKUPS = 'mockups';
export const Y_PROJECT_CONNECTIONS = 'connections';
export const Y_PROJECT_META = 'meta';

/** Schema version stored in `meta.version`. Bump if the on-wire shape changes. */
export const PROJECT_SCHEMA_VERSION = 1;

export function getYProjectMockups(yDoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return yDoc.getMap<Y.Map<unknown>>(Y_PROJECT_MOCKUPS);
}

export function getYProjectConnections(yDoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return yDoc.getMap<Y.Map<unknown>>(Y_PROJECT_CONNECTIONS);
}

export function getYProjectMeta(yDoc: Y.Doc): Y.Map<unknown> {
  return yDoc.getMap<unknown>(Y_PROJECT_META);
}

/**
 * The shape of a row in the `mockups` Y.Map. Stored as plain primitives in
 * a Y.Map so individual fields can be observed independently.
 */
export interface YMockupFields {
  path: string;
  label: string;
  positionX: number;
  positionY: number;
  sizeWidth: number;
  sizeHeight: number;
}

export interface YConnectionFields {
  fromMockupId: string;
  toMockupId: string;
  fromElementSelector?: string;
  label?: string;
  trigger?: 'click' | 'hover' | 'navigate';
}

/**
 * Whether the Y.Doc has any MockupLM project content yet. Used as the
 * `useCollaborativeEditor` `isEmpty` guard so we don't re-seed a doc that
 * was just sync'd in. We include `meta` deliberately: a previous client may
 * have written name/viewport into `meta` but not (yet) added any mockups,
 * and treating that as "empty" would let us race in and overwrite their
 * metadata with our defaults.
 */
export function isMockupProjectYDocEmpty(yDoc: Y.Doc): boolean {
  return (
    getYProjectMockups(yDoc).size === 0 &&
    getYProjectConnections(yDoc).size === 0 &&
    getYProjectMeta(yDoc).size === 0
  );
}

export function seedMockupProjectYDoc(
  yDoc: Y.Doc,
  content: string | ArrayBuffer,
): void {
  // A recipient opening a shared project with no in-memory initial-content
  // payload gets `''` (or an empty buffer) from `loadInitialContent`. There
  // is no file data to seed from -- writing our "createEmptyProject()"
  // defaults into `meta` here would set the shared project name to
  // "New Project" and the viewport to `(0, 0, 1)`, last-write-win clobbering
  // whatever the sender's seed wrote. Bail and wait for the server's sync
  // response instead.
  const text = typeof content === 'string' ? content : decodeBuffer(content);
  if (!text.trim()) return;

  const file = parseProjectFile(text);
  const yMockups = getYProjectMockups(yDoc);
  const yConnections = getYProjectConnections(yDoc);
  const yMeta = getYProjectMeta(yDoc);

  // Meta first -- always written so subsequent loads can detect a seeded doc
  // even if it had zero mockups.
  yMeta.set('version', PROJECT_SCHEMA_VERSION);
  yMeta.set('name', file.name ?? 'New Project');
  if (file.description !== undefined) yMeta.set('description', file.description);
  if (file.designSystem !== undefined) yMeta.set('designSystem', file.designSystem);
  if (file.viewport) {
    yMeta.set('viewportX', file.viewport.x);
    yMeta.set('viewportY', file.viewport.y);
    yMeta.set('viewportZoom', file.viewport.zoom);
  }

  for (const mockup of file.mockups ?? []) {
    if (!mockup.id) continue;
    // Concurrent-seed safety: if another client already wrote this key during
    // our await gap, skip. Y.Map's last-write-wins-per-key would otherwise
    // clobber their potentially newer state with our stale read.
    if (yMockups.has(mockup.id)) continue;
    const yEntry = new Y.Map<unknown>();
    writeMockupFields(yEntry, mockup);
    yMockups.set(mockup.id, yEntry);
  }

  for (const connection of file.connections ?? []) {
    if (!connection.id) continue;
    if (yConnections.has(connection.id)) continue;
    const yEntry = new Y.Map<unknown>();
    writeConnectionFields(yEntry, connection);
    yConnections.set(connection.id, yEntry);
  }
}

/**
 * Internal helper. Writes mockup fields onto the supplied Y.Map. Caller is
 * responsible for being inside a transaction.
 */
export function writeMockupFields(
  yEntry: Y.Map<unknown>,
  mockup: MockupReference,
): void {
  yEntry.set('path', mockup.path);
  yEntry.set('label', mockup.label);
  yEntry.set('positionX', mockup.position.x);
  yEntry.set('positionY', mockup.position.y);
  yEntry.set('sizeWidth', mockup.size.width);
  yEntry.set('sizeHeight', mockup.size.height);
}

export function writeConnectionFields(
  yEntry: Y.Map<unknown>,
  conn: Connection,
): void {
  yEntry.set('fromMockupId', conn.fromMockupId);
  yEntry.set('toMockupId', conn.toMockupId);
  if (conn.fromElementSelector !== undefined) {
    yEntry.set('fromElementSelector', conn.fromElementSelector);
  } else {
    yEntry.delete('fromElementSelector');
  }
  if (conn.label !== undefined) {
    yEntry.set('label', conn.label);
  } else {
    yEntry.delete('label');
  }
  if (conn.trigger !== undefined) {
    yEntry.set('trigger', conn.trigger);
  } else {
    yEntry.delete('trigger');
  }
}

/**
 * Project a single mockup Y.Map back to the on-disk shape. Defaults match
 * the values used by `createMockupProjectStore` when fields are absent.
 */
export function readMockupFields(
  id: string,
  yEntry: Y.Map<unknown>,
): MockupReference {
  const path = (yEntry.get('path') as string) ?? '';
  const label = (yEntry.get('label') as string) ?? '';
  const positionX = numberOr(yEntry.get('positionX'), 0);
  const positionY = numberOr(yEntry.get('positionY'), 0);
  const sizeWidth = numberOr(yEntry.get('sizeWidth'), 400);
  const sizeHeight = numberOr(yEntry.get('sizeHeight'), 300);
  return {
    id,
    path,
    label,
    position: { x: positionX, y: positionY },
    size: { width: sizeWidth, height: sizeHeight },
  };
}

export function readConnectionFields(
  id: string,
  yEntry: Y.Map<unknown>,
): Connection {
  const fromMockupId = (yEntry.get('fromMockupId') as string) ?? '';
  const toMockupId = (yEntry.get('toMockupId') as string) ?? '';
  const fromElementSelector = yEntry.get('fromElementSelector') as
    | string
    | undefined;
  const label = yEntry.get('label') as string | undefined;
  const trigger = yEntry.get('trigger') as
    | 'click'
    | 'hover'
    | 'navigate'
    | undefined;
  return {
    id,
    fromMockupId,
    toMockupId,
    ...(fromElementSelector !== undefined ? { fromElementSelector } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
  };
}

/** Project the full Y.Doc back to a MockupProjectFile (for save/export). */
export function readProjectFromYDoc(yDoc: Y.Doc): MockupProjectFile {
  const yMockups = getYProjectMockups(yDoc);
  const yConnections = getYProjectConnections(yDoc);
  const yMeta = getYProjectMeta(yDoc);

  const mockups: MockupReference[] = [];
  yMockups.forEach((value, key) => {
    mockups.push(readMockupFields(key, value));
  });
  const connections: Connection[] = [];
  yConnections.forEach((value, key) => {
    connections.push(readConnectionFields(key, value));
  });

  const name = (yMeta.get('name') as string) ?? 'New Project';
  const description = yMeta.get('description') as string | undefined;
  const designSystem = yMeta.get('designSystem') as
    | MockupProjectFile['designSystem']
    | undefined;
  const viewportX = numberOr(yMeta.get('viewportX'), 0);
  const viewportY = numberOr(yMeta.get('viewportY'), 0);
  const viewportZoom = numberOr(yMeta.get('viewportZoom'), 1);

  return {
    version: 1,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(designSystem !== undefined ? { designSystem } : {}),
    mockups,
    connections,
    viewport: { x: viewportX, y: viewportY, zoom: viewportZoom },
  };
}

// =====================================================================
// Helpers
// =====================================================================

function parseProjectFile(content: string | ArrayBuffer): MockupProjectFile {
  if (typeof content !== 'string') {
    try {
      content = new TextDecoder().decode(content);
    } catch {
      return createEmptyProject();
    }
  }
  if (!content.trim()) return createEmptyProject();
  try {
    return JSON.parse(content) as MockupProjectFile;
  } catch {
    return createEmptyProject();
  }
}

function decodeBuffer(buf: ArrayBuffer): string {
  try {
    return new TextDecoder().decode(buf);
  } catch {
    return '';
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
