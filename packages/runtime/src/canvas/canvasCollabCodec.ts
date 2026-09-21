/**
 * `CollabCodec` for `.canvas` (Project Canvas / JSON Canvas superset).
 *
 * Y.Doc layout (keyed maps, "Pattern B"):
 *
 *   nodes   Y.Map<id, Y.Map<field>>   node fields minus `id`, plus the z rank
 *   edges   Y.Map<id, Y.Map<field>>   edge fields minus `id`
 *   meta    Y.Map<field>              board metadata: the contents of
 *                                     `x-nimbalyst.meta`, flat and first-class
 *                                     (`name`, `description`, `viewport`, ...)
 *   extras  Y.Map<'topLevel'|'namespace', object>
 *                                     verbatim pass-through for keys we do not
 *                                     model: unrecognised document-level keys
 *                                     and `x-nimbalyst` keys other than `meta`
 *
 * `meta` holds only user-facing board metadata, so the canvas UI and the
 * Slice 4 binding can bind to it directly; nothing the codec needs for its own
 * bookkeeping shares that key space. Everything in `nodes` / `edges` / `meta` /
 * `extras` round-trips to the file, so `applyFromFile` can treat the file as
 * authoritative and delete absent keys. The one exception is a node's z rank,
 * which is reconciled against file order rather than deleted -- see
 * `CANVAS_NODE_RANK_FIELD`.
 */
import type {
  CollabCodec,
  CollabContentFileSource,
} from '@nimbalyst/extension-sdk';
import * as Y from 'yjs';

import {
  NIMBALYST_CANVAS_NAMESPACE,
  type CanvasAnyNode,
  type CanvasDocument,
  type CanvasEdge,
  isCanvasSpecNode,
  parseCanvasDocument,
  serializeCanvasDocument,
} from './CanvasDocument';
import {
  canvasCommentAnchorState,
  canvasNodeIdFromAnchor,
  describeCanvasCommentAnchor,
  isCanvasCommentAnchor,
} from './canvasCommentAnchors';
import {
  CANVAS_NODE_RANK_FIELD,
  canvasRankBetween,
  canvasRankSequence,
  compareCanvasRank,
  normalizeCanvasRank,
} from './canvasRank';

export const CANVAS_Y_NODES = 'nodes';
export const CANVAS_Y_EDGES = 'edges';
export const CANVAS_Y_META = 'meta';
export const CANVAS_Y_EXTRAS = 'extras';
export const CANVAS_EXTRAS_TOP_LEVEL = 'topLevel';
export const CANVAS_EXTRAS_NAMESPACE = 'namespace';

type Entity = CanvasAnyNode | CanvasEdge;

// CRDT-only node fields. Null is a tombstone overriding legacy namespace blobs.
const NODE_EXTENSION_FIELDS = {
  locked: '__canvas_locked',
  group: '__canvas_group',
} as const;
const NODE_EXTENSION_KEYS: ReadonlySet<string> = new Set(Object.values(NODE_EXTENSION_FIELDS));
// Escape colliding file keys, including this prefix itself, for a reversible mapping.
const NODE_FILE_KEY_PREFIX = '__canvas_file:';

/** Keep lock/group writes independent from each other and other namespace data. */
export function canvasNodeFields(node: CanvasAnyNode): Map<string, unknown> {
  const fields = new Map(Array.from(entityFields(node), ([key, value]): [string, unknown] => [
    NODE_EXTENSION_KEYS.has(key) || key.startsWith(NODE_FILE_KEY_PREFIX)
      ? NODE_FILE_KEY_PREFIX + key : key,
    value,
  ]));
  const namespace = node[NIMBALYST_CANVAS_NAMESPACE];
  const rest = { ...namespace };
  for (const [name, key] of Object.entries(NODE_EXTENSION_FIELDS)) {
    // Older peers may have exported the CRDT field as a top-level file key.
    const legacy = node[key];
    const compatible = name === 'locked' ? typeof legacy === 'boolean' : typeof legacy === 'string';
    fields.set(key, namespace?.[name] ?? (compatible ? legacy : null));
    delete rest[name];
  }
  if (Object.keys(rest).length > 0) fields.set(NIMBALYST_CANVAS_NAMESPACE, rest);
  else fields.delete(NIMBALYST_CANVAS_NAMESPACE);
  return fields;
}

/** Node-map keys `applyFromFile` must not delete: they have no file counterpart. */
const NODE_RESERVED_KEYS: readonly string[] = [CANVAS_NODE_RANK_FIELD];

export const canvasCollabCodec: CollabCodec = {
  documentType: 'canvas',
  fileExtensions: ['.canvas'],
  mimeType: 'application/json',
  layoutVersion: 1,

  isEmpty(yDoc) {
    return (
      getCanvasYNodes(yDoc).size === 0 &&
      getCanvasYEdges(yDoc).size === 0 &&
      getCanvasYMeta(yDoc).size === 0 &&
      getCanvasYExtras(yDoc).size === 0
    );
  },

  seedFromFile(yDoc, source) {
    const document = parseCanvasDocument(decodeSource(source));
    yDoc.transact(() => {
      seedNodes(getCanvasYNodes(yDoc), document.nodes ?? []);
      seedEntities(getCanvasYEdges(yDoc), document.edges ?? []);
      seedFields(getCanvasYMeta(yDoc), boardMetaFields(document));
      seedFields(getCanvasYExtras(yDoc), extrasFields(document));
    });
  },

  applyFromFile(yDoc, source) {
    const document = parseCanvasDocument(decodeSource(source));
    const nodes = document.nodes ?? [];
    yDoc.transact(() => {
      const yNodes = getCanvasYNodes(yDoc);
      patchEntities(yNodes, nodes, NODE_RESERVED_KEYS, true);
      reconcileNodeRanks(
        yNodes,
        nodes.map((node) => node.id)
      );
      patchEntities(getCanvasYEdges(yDoc), document.edges ?? [], []);
      patchFields(getCanvasYMeta(yDoc), boardMetaFields(document));
      patchFields(getCanvasYExtras(yDoc), extrasFields(document));
    });
  },

  exportToFile(yDoc) {
    return serializeCanvasDocument(readCanvasDocumentFromYDoc(yDoc));
  },

  /**
   * Anchor resolution for headless hosts -- the MCP comment tools and the
   * notification/inbox paths, which must answer "does this thread still point
   * at anything?" without a board mounted.
   *
   * Reads only. The snapshot handed in is a detached, disposable Y.Doc, and
   * nothing below writes to it or holds a reference past the call.
   */
  commentAnchors: {
    handles(anchor) {
      return isCanvasCommentAnchor(anchor);
    },

    getState(snapshot, anchor) {
      const nodes = getCanvasYNodes(snapshot);
      return canvasCommentAnchorState(anchor, (nodeId) => nodes.has(nodeId));
    },

    describe(snapshot, anchor) {
      const nodeId = canvasNodeIdFromAnchor(anchor);
      const fields =
        nodeId === null ? undefined : getCanvasYNodes(snapshot).get(nodeId);
      return describeCanvasCommentAnchor(
        anchor,
        fields === undefined ? null : canvasNodeFieldLabel(fields)
      );
    },
  },

  toPlainText(yDoc) {
    const document = readCanvasDocumentFromYDoc(yDoc);
    const meta = document[NIMBALYST_CANVAS_NAMESPACE]?.meta;
    const lines: string[] = [];
    if (typeof meta?.name === 'string' && meta.name) lines.push(meta.name);
    if (typeof meta?.description === 'string' && meta.description) {
      lines.push(meta.description);
    }
    for (const node of document.nodes ?? []) {
      const label = node[NIMBALYST_CANVAS_NAMESPACE]?.label;
      if (typeof label === 'string' && label) {
        lines.push(label);
        continue;
      }
      if (!isCanvasSpecNode(node)) continue;
      if (node.type === 'text') lines.push(node.text);
      else if (node.type === 'file') lines.push(node.file);
      else if (node.type === 'link') lines.push(node.url);
      else if (node.label) lines.push(node.label);
    }
    return lines.join('\n');
  },
};

export function getCanvasYNodes(yDoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return yDoc.getMap<Y.Map<unknown>>(CANVAS_Y_NODES);
}

export function getCanvasYEdges(yDoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return yDoc.getMap<Y.Map<unknown>>(CANVAS_Y_EDGES);
}

export function getCanvasYMeta(yDoc: Y.Doc): Y.Map<unknown> {
  return yDoc.getMap<unknown>(CANVAS_Y_META);
}

export function getCanvasYExtras(yDoc: Y.Doc): Y.Map<unknown> {
  return yDoc.getMap<unknown>(CANVAS_Y_EXTRAS);
}

function decodeSource(source: CollabContentFileSource): string {
  return typeof source === 'string'
    ? source
    : new TextDecoder('utf-8').decode(source);
}

// ---------------------------------------------------------------------------
// File -> Y.Doc
// ---------------------------------------------------------------------------

function seedNodes(
  target: Y.Map<Y.Map<unknown>>,
  nodes: readonly CanvasAnyNode[]
): void {
  const ranks = canvasRankSequence(nodes.length);
  nodes.forEach((node, index) => {
    if (target.has(node.id)) return;
    const fields = new Y.Map<unknown>();
    for (const [key, value] of canvasNodeFields(node)) fields.set(key, value);
    fields.set(CANVAS_NODE_RANK_FIELD, ranks[index]);
    target.set(node.id, fields);
  });
}

function seedEntities(
  target: Y.Map<Y.Map<unknown>>,
  entities: readonly Entity[]
): void {
  for (const entity of entities) {
    if (target.has(entity.id)) continue;
    const fields = new Y.Map<unknown>();
    writeAllEntityFields(fields, entity);
    target.set(entity.id, fields);
  }
}

function patchEntities(
  target: Y.Map<Y.Map<unknown>>,
  entities: readonly Entity[],
  reservedKeys: readonly string[],
  nodes = false
): void {
  const incoming = new Set(entities.map((entity) => entity.id));

  for (const id of Array.from(target.keys())) {
    if (!incoming.has(id)) target.delete(id);
  }

  for (const entity of entities) {
    const current = target.get(entity.id);
    const incomingFields = nodes
      ? canvasNodeFields(entity as CanvasAnyNode)
      : entityFields(entity);
    if (current) {
      patchFields(current, incomingFields, reservedKeys);
    } else {
      const fields = new Y.Map<unknown>();
      for (const [key, value] of incomingFields) fields.set(key, value);
      target.set(entity.id, fields);
    }
  }
}

/**
 * Give every node in `orderedIds` a rank consistent with that order, writing
 * only where the existing rank already disagrees. A file whose node order is
 * unchanged therefore produces zero rank writes.
 */
function reconcileNodeRanks(
  target: Y.Map<Y.Map<unknown>>,
  orderedIds: readonly string[]
): void {
  const ranks = orderedIds.map((id) =>
    normalizeCanvasRank(target.get(id)?.get(CANVAS_NODE_RANK_FIELD))
  );

  let previous: string | null = null;
  for (let index = 0; index < orderedIds.length; index += 1) {
    const rank = ranks[index];
    if (rank !== null && (previous === null || rank > previous)) {
      previous = rank;
      continue;
    }
    let next: string | null = null;
    for (let ahead = index + 1; ahead < ranks.length; ahead += 1) {
      const candidate = ranks[ahead];
      if (candidate !== null && (previous === null || candidate > previous)) {
        next = candidate;
        break;
      }
    }
    const assigned = canvasRankBetween(previous, next);
    target.get(orderedIds[index])?.set(CANVAS_NODE_RANK_FIELD, assigned);
    ranks[index] = assigned;
    previous = assigned;
  }
}

function writeAllEntityFields(target: Y.Map<unknown>, entity: Entity): void {
  for (const [key, value] of entityFields(entity)) target.set(key, value);
}

function entityFields(entity: Entity): Map<string, unknown> {
  return new Map(Object.entries(entity).filter(([key]) => key !== 'id'));
}

function seedFields(
  target: Y.Map<unknown>,
  fields: Map<string, unknown>
): void {
  for (const [key, value] of fields) {
    if (!target.has(key)) target.set(key, value);
  }
}

function patchFields(
  target: Y.Map<unknown>,
  fields: Map<string, unknown>,
  reservedKeys: readonly string[] = []
): void {
  for (const key of Array.from(target.keys())) {
    if (!fields.has(key) && !reservedKeys.includes(key)) target.delete(key);
  }
  for (const [key, value] of fields) {
    if (!target.has(key) || !jsonEqual(target.get(key), value)) {
      target.set(key, value);
    }
  }
}

function boardMetaFields(document: CanvasDocument): Map<string, unknown> {
  const meta = document[NIMBALYST_CANVAS_NAMESPACE]?.meta;
  return new Map(isRecord(meta) ? Object.entries(meta) : []);
}

function extrasFields(document: CanvasDocument): Map<string, unknown> {
  const fields = new Map<string, unknown>();

  const topLevel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === 'nodes' || key === 'edges') continue;
    if (key === NIMBALYST_CANVAS_NAMESPACE) continue;
    topLevel[key] = value;
  }
  if (Object.keys(topLevel).length > 0) {
    fields.set(CANVAS_EXTRAS_TOP_LEVEL, topLevel);
  }

  const namespace = document[NIMBALYST_CANVAS_NAMESPACE];
  if (isRecord(namespace)) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(namespace)) {
      if (key !== 'meta') rest[key] = value;
    }
    if (Object.keys(rest).length > 0) {
      fields.set(CANVAS_EXTRAS_NAMESPACE, rest);
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Y.Doc -> file
// ---------------------------------------------------------------------------

export function readCanvasDocumentFromYDoc(
  yDoc: Y.Doc,
  options: { includeNodeRanks?: boolean } = {}
): CanvasDocument {
  const extras = getCanvasYExtras(yDoc);
  const document: Record<string, unknown> = {
    ...asRecord(extras.get(CANVAS_EXTRAS_TOP_LEVEL)),
    nodes: readNodes(getCanvasYNodes(yDoc), options.includeNodeRanks === true),
    edges: readEdges(getCanvasYEdges(yDoc)),
  };

  const namespace = { ...asRecord(extras.get(CANVAS_EXTRAS_NAMESPACE)) };
  const meta = readFields(getCanvasYMeta(yDoc));
  if (Object.keys(meta).length > 0) namespace.meta = meta;
  if (Object.keys(namespace).length > 0) {
    document[NIMBALYST_CANVAS_NAMESPACE] = namespace;
  }

  return document as CanvasDocument;
}

function readNodes(
  source: Y.Map<Y.Map<unknown>>,
  includeRanks: boolean
): CanvasAnyNode[] {
  const entries: Array<{ node: CanvasAnyNode; rank: string | null }> = [];
  source.forEach((fields, id) => {
    const node: Record<string, unknown> = { id };
    let rank: string | null = null;
    fields.forEach((value, key) => {
      if (key === CANVAS_NODE_RANK_FIELD) {
        rank = normalizeCanvasRank(value);
        if (includeRanks && rank !== null) node[key] = rank;
      } else if (key.startsWith(NODE_FILE_KEY_PREFIX)) {
        node[key.slice(NODE_FILE_KEY_PREFIX.length)] = value;
      } else if (key !== 'id' && !NODE_EXTENSION_KEYS.has(key)) {
        node[key] = value;
      }
    });
    const namespace = { ...asRecord(node[NIMBALYST_CANVAS_NAMESPACE]) };
    for (const [name, key] of Object.entries(NODE_EXTENSION_FIELDS)) {
      if (!fields.has(key)) continue; // Older rooms still store these in the blob.
      const value = fields.get(key);
      if (value === null) delete namespace[name];
      else namespace[name] = value;
    }
    if (Object.keys(namespace).length > 0) {
      node[NIMBALYST_CANVAS_NAMESPACE] = namespace;
    } else delete node[NIMBALYST_CANVAS_NAMESPACE];
    entries.push({ node: node as CanvasAnyNode, rank });
  });

  entries.sort(
    (left, right) =>
      compareCanvasRank(left.rank, right.rank) ||
      left.node.id.localeCompare(right.node.id)
  );
  return entries.map((entry) => entry.node);
}

function readEdges(source: Y.Map<Y.Map<unknown>>): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  source.forEach((fields, id) => {
    const edge: Record<string, unknown> = { id };
    fields.forEach((value, key) => {
      if (key !== 'id') edge[key] = value;
    });
    edges.push(edge as CanvasEdge);
  });
  // JSON Canvas gives edge order no meaning, so sort by id for a stable file.
  return edges.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * A node's display name straight off its Y fields.
 *
 * Mirrors `canvasCardLabel`'s precedence without projecting the whole document:
 * `describe` runs on a detached snapshot for one thread at a time, and reading
 * every node to answer for one of them would make a busy inbox quadratic. Falls
 * through to the card's target, because "Card: docs/pricing.md" tells a reader
 * more than "Card: 4f3a".
 */
function canvasNodeFieldLabel(fields: Y.Map<unknown>): string {
  const namespace = fields.get(NIMBALYST_CANVAS_NAMESPACE);
  if (isRecord(namespace) && typeof namespace.label === 'string') {
    if (namespace.label) return namespace.label;
  }
  for (const key of ['label', 'file', 'url'] as const) {
    const value = fields.get(key);
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function readFields(source: Y.Map<unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  source.forEach((value, key) => {
    fields[key] = value;
  });
  return fields;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => hasOwn(right, key) && jsonEqual(left[key], right[key])
      )
    );
  }
  return false;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
