/**
 * Project Canvas document model.
 *
 * The on-disk format is a JSON Canvas 1.0 superset: every field the spec
 * defines keeps its spec meaning, Nimbalyst-specific data lives under the
 * `x-nimbalyst` namespace, and unknown keys from any level are preserved
 * verbatim so a file written by another tool survives a Nimbalyst round-trip.
 *
 * Serialization is *canonical*, not input-preserving: equal documents always
 * produce byte-equal output, which is what makes diffs readable and makes the
 * collab codec's export comparable to a direct serialize. Reproducing the
 * author's original JSON key insertion order is explicitly a non-goal.
 */
export const NIMBALYST_CANVAS_NAMESPACE = 'x-nimbalyst' as const;

// Compatibility re-export. Rank algebra is deliberately isolated from the
// persisted document model; existing callers may keep importing it here.
export {
  CANVAS_NODE_RANK_FIELD,
  canvasRankBetween,
  canvasRankSequence,
  compareCanvasRank,
  normalizeCanvasRank,
} from './canvasRank';

/** The four node types JSON Canvas 1.0 defines. */
export const CANVAS_SPEC_NODE_TYPES = [
  'text',
  'file',
  'link',
  'group',
] as const;

export type CanvasColor = string;
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';
export type CanvasEdgeKind = 'flow' | (string & {});
export type CanvasNativeKind =
  | 'sticky'
  | 'text'
  | 'image'
  | 'group'
  | (string & {});

export interface CanvasDocumentTarget {
  uri: `nimbalyst://doc/${string}/${string}`;
  /** Omitted for the document head; set to pin the card to one revision. */
  revisionId?: string;
  [key: string]: unknown;
}

export interface CanvasFileReference {
  kind: 'file';
  path: string;
  sharedAs?: CanvasDocumentTarget;
  [key: string]: unknown;
}

export interface CanvasDocReference extends CanvasDocumentTarget {
  kind: 'doc';
}

export interface CanvasNativeReference {
  kind: 'native';
  nativeKind: CanvasNativeKind;
  content?: unknown;
  [key: string]: unknown;
}

export type CanvasNodeReference =
  | CanvasFileReference
  | CanvasDocReference
  | CanvasNativeReference;

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
  [key: string]: unknown;
}

export interface CanvasDesignSystemReference {
  uri?: string;
  styleGuide?: string;
  theme?: string;
  [key: string]: unknown;
}

export interface CanvasMeta {
  name?: string;
  description?: string;
  viewport?: CanvasViewport;
  designSystem?: CanvasDesignSystemReference;
  [key: string]: unknown;
}

export interface CanvasNodeNimbalystExtension {
  reference?: CanvasNodeReference;
  label?: string;
  locked?: boolean;
  group?: string;
  [key: string]: unknown;
}

export interface CanvasEdgeNimbalystExtension {
  kind?: CanvasEdgeKind;
  flow?: {
    fromElementSelector?: string;
    trigger?: 'click' | 'hover' | 'navigate';
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CanvasDocumentNimbalystExtension {
  version?: number;
  meta?: CanvasMeta;
  [key: string]: unknown;
}

interface CanvasNodeBase {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  [NIMBALYST_CANVAS_NAMESPACE]?: CanvasNodeNimbalystExtension;
  [key: string]: unknown;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: 'file';
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link';
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}

/**
 * A node whose `type` is outside JSON Canvas 1.0.
 *
 * We pass these through instead of rejecting the file. The format's whole
 * selling point is that a board stays readable by other tools and by future
 * spec revisions; throwing on an unrecognised `type` would make one foreign
 * card render the entire board unopenable, and would silently delete that
 * card if we instead dropped it. The surface renders these as an
 * "unsupported card" placeholder and writes them back untouched.
 */
export interface CanvasUnknownNode extends CanvasNodeBase {
  type: string;
}

/** The four spec node types, narrowed. */
export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode;

/** Any node a `.canvas` file may contain, spec-typed or pass-through. */
export type CanvasAnyNode = CanvasNode | CanvasUnknownNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: CanvasColor;
  label?: string;
  [NIMBALYST_CANVAS_NAMESPACE]?: CanvasEdgeNimbalystExtension;
  [key: string]: unknown;
}

/**
 * JSON Canvas 1.0 makes both arrays optional. Documents created by Nimbalyst
 * always write both, while the optional shape lets plain-spec files round-trip
 * without acquiring fields they did not contain.
 *
 * `nodes` order is meaningful: the spec states nodes are stored in ascending
 * z-index, so the last entry paints on top. See {@link canvasRankBetween}.
 */
export interface CanvasDocument {
  nodes?: CanvasAnyNode[];
  edges?: CanvasEdge[];
  [NIMBALYST_CANVAS_NAMESPACE]?: CanvasDocumentNimbalystExtension;
  [key: string]: unknown;
}

/** True when `node` is one of the four types JSON Canvas 1.0 defines. */
export function isCanvasSpecNode(node: CanvasAnyNode): node is CanvasNode {
  return (CANVAS_SPEC_NODE_TYPES as readonly string[]).includes(node.type);
}

export function parseCanvasDocument(
  source: string | Uint8Array
): CanvasDocument {
  const text =
    typeof source === 'string'
      ? source
      : new TextDecoder('utf-8').decode(source);
  const value: unknown = JSON.parse(text);
  assertCanvasDocument(value);
  return value;
}

/**
 * Serialize to the canonical form: keys in the order below, edges sorted by
 * id, node geometry rounded to the integers the spec requires. Equal input
 * always yields byte-equal output, and the result is a fixed point --
 * `serialize(parse(serialize(d))) === serialize(d)`.
 */
export function serializeCanvasDocument(document: CanvasDocument): string {
  assertCanvasDocument(document);
  const normalized: Record<string, unknown> = { ...document };
  if (document.nodes !== undefined) {
    normalized.nodes = document.nodes.map(withCanvasGeometryRounded);
  }
  if (document.edges !== undefined) {
    normalized.edges = [...document.edges].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
  }
  return JSON.stringify(canonicalValue(normalized, DOCUMENT_SHAPE), null, 2);
}

export function createEmptyCanvasDocument(
  meta: CanvasMeta = {}
): CanvasDocument {
  return {
    nodes: [],
    edges: [],
    [NIMBALYST_CANVAS_NAMESPACE]: {
      version: 1,
      meta: { ...meta },
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry: the integer boundary
// ---------------------------------------------------------------------------

/**
 * Coerce one geometry value to the integer JSON Canvas requires.
 *
 * This is the integer boundary, and it is a *coercion*, never a rejection:
 * dragging a card produces fractional pixels, so any surface that writes
 * `x` / `y` / `width` / `height` into the model must pass the value through
 * here first. `serializeCanvasDocument` rounds again on the way out, so a
 * surface that forgets still cannot produce an invalid file -- the assert
 * deliberately accepts any finite number so normal dragging can never throw.
 */
export function toCanvasCoordinate(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('Canvas geometry must be a finite number');
  }
  return Math.round(value);
}

/** Returns `node` with spec geometry rounded, or `node` itself if already integral. */
export function withCanvasGeometryRounded<T extends CanvasAnyNode>(node: T): T {
  const rounded: Record<string, unknown> = {};
  let changed = false;
  for (const key of CANVAS_GEOMETRY_KEYS) {
    const next = toCanvasCoordinate(node[key]);
    if (next !== node[key]) changed = true;
    rounded[key] = next;
  }
  return changed ? ({ ...node, ...rounded } as T) : node;
}

const CANVAS_GEOMETRY_KEYS = ['x', 'y', 'width', 'height'] as const;

// ---------------------------------------------------------------------------
// Canonical key order
// ---------------------------------------------------------------------------

/**
 * Known keys come first in the order below (JSON Canvas spec fields in spec
 * order, then `x-nimbalyst`); everything else is sorted alphabetically. Values
 * without an entry here are sorted alphabetically at every depth, which is
 * what makes the output a pure function of the document's content.
 */
interface CanvasKeyShape {
  order: readonly string[];
  children?: Readonly<Record<string, CanvasKeyShape>>;
  item?: CanvasKeyShape;
}

const VIEWPORT_SHAPE: CanvasKeyShape = { order: ['x', 'y', 'zoom'] };
const DESIGN_SYSTEM_SHAPE: CanvasKeyShape = {
  order: ['uri', 'styleGuide', 'theme'],
};
const BOARD_META_SHAPE: CanvasKeyShape = {
  order: ['name', 'description', 'viewport', 'designSystem'],
  children: { viewport: VIEWPORT_SHAPE, designSystem: DESIGN_SYSTEM_SHAPE },
};
const DOCUMENT_EXTENSION_SHAPE: CanvasKeyShape = {
  order: ['version', 'meta'],
  children: { meta: BOARD_META_SHAPE },
};
const REFERENCE_SHAPE: CanvasKeyShape = {
  order: [
    'kind',
    'nativeKind',
    'path',
    'uri',
    'revisionId',
    'sharedAs',
    'content',
  ],
  children: { sharedAs: { order: ['uri', 'revisionId'] } },
};
const NODE_EXTENSION_SHAPE: CanvasKeyShape = {
  order: ['reference', 'label', 'locked', 'group'],
  children: { reference: REFERENCE_SHAPE },
};
const EDGE_EXTENSION_SHAPE: CanvasKeyShape = {
  order: ['kind', 'flow'],
  children: { flow: { order: ['fromElementSelector', 'trigger'] } },
};
const NODE_SHAPE: CanvasKeyShape = {
  order: [
    'id',
    'type',
    'x',
    'y',
    'width',
    'height',
    'color',
    'text',
    'file',
    'subpath',
    'url',
    'label',
    'background',
    'backgroundStyle',
    NIMBALYST_CANVAS_NAMESPACE,
  ],
  children: { [NIMBALYST_CANVAS_NAMESPACE]: NODE_EXTENSION_SHAPE },
};
const EDGE_SHAPE: CanvasKeyShape = {
  order: [
    'id',
    'fromNode',
    'fromSide',
    'fromEnd',
    'toNode',
    'toSide',
    'toEnd',
    'color',
    'label',
    NIMBALYST_CANVAS_NAMESPACE,
  ],
  children: { [NIMBALYST_CANVAS_NAMESPACE]: EDGE_EXTENSION_SHAPE },
};
const DOCUMENT_SHAPE: CanvasKeyShape = {
  order: ['nodes', 'edges', NIMBALYST_CANVAS_NAMESPACE],
  children: {
    nodes: { order: [], item: NODE_SHAPE },
    edges: { order: [], item: EDGE_SHAPE },
    [NIMBALYST_CANVAS_NAMESPACE]: DOCUMENT_EXTENSION_SHAPE,
  },
};

function canonicalValue(value: unknown, shape?: CanvasKeyShape): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry, shape?.item));
  }
  if (!isRecord(value)) return value;

  const order = shape?.order ?? [];
  const known = order.filter((key) => hasOwn(value, key));
  const rest = Object.keys(value)
    .filter((key) => !order.includes(key))
    .sort();

  const result: Record<string, unknown> = {};
  for (const key of [...known, ...rest]) {
    result[key] = canonicalValue(value[key], shape?.children?.[key]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertCanvasDocument(value: unknown): asserts value is CanvasDocument {
  if (!isRecord(value)) {
    throw new TypeError('Canvas document must be a JSON object');
  }

  if (value.nodes !== undefined) {
    if (!Array.isArray(value.nodes)) {
      throw new TypeError('Canvas document nodes must be an array');
    }
    const ids = new Set<string>();
    for (const node of value.nodes) {
      assertCanvasNode(node);
      if (ids.has(node.id)) {
        throw new TypeError(`Canvas node id must be unique: ${node.id}`);
      }
      ids.add(node.id);
    }
  }

  if (value.edges !== undefined) {
    if (!Array.isArray(value.edges)) {
      throw new TypeError('Canvas document edges must be an array');
    }
    const ids = new Set<string>();
    for (const edge of value.edges) {
      assertCanvasEdge(edge);
      if (ids.has(edge.id)) {
        throw new TypeError(`Canvas edge id must be unique: ${edge.id}`);
      }
      ids.add(edge.id);
    }
  }

  const extension = value[NIMBALYST_CANVAS_NAMESPACE];
  if (extension !== undefined && !isRecord(extension)) {
    throw new TypeError(`${NIMBALYST_CANVAS_NAMESPACE} must be an object`);
  }
}

function assertCanvasNode(value: unknown): asserts value is CanvasAnyNode {
  if (!isRecord(value)) throw new TypeError('Canvas node must be an object');
  requireString(value, 'id', 'Canvas node');
  requireString(value, 'type', 'Canvas node');
  for (const key of CANVAS_GEOMETRY_KEYS) {
    // Finite, not integer: the surface writes fractional pixels while dragging
    // and `serializeCanvasDocument` rounds on the way out.
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new TypeError(`Canvas node ${key} must be a finite number`);
    }
  }

  switch (value.type) {
    /*
     * A native card's own payload may be empty, and only it.
     *
     * The surface creates a sticky or an image card the moment it is dropped
     * and the author fills it in afterwards, so `text: ''` and `url: ''` are
     * states a real board sits in. Refusing them made a board editable but not
     * serializable, which broke local `.canvas` save, every headless collab
     * read, and the console's source mode -- the escape hatch meant for
     * exactly the board that will not open. See NIM-5378.
     *
     * The field must still be present and a string: a `text` node with no
     * `text` at all is malformed, not half-authored. Everything else on the
     * node -- `id`, `type`, a file node's `file` -- stays strict, because an
     * empty value there names nothing.
     */
    case 'text':
      requirePossiblyEmptyString(value, 'text', 'Canvas text node');
      break;
    case 'file':
      requireString(value, 'file', 'Canvas file node');
      break;
    case 'link':
      requirePossiblyEmptyString(value, 'url', 'Canvas link node');
      break;
    default:
      // 'group' has no required payload, and an unrecognised type is carried
      // through opaquely rather than making the whole board unopenable.
      break;
  }
}

function assertCanvasEdge(value: unknown): asserts value is CanvasEdge {
  if (!isRecord(value)) throw new TypeError('Canvas edge must be an object');
  requireString(value, 'id', 'Canvas edge');
  requireString(value, 'fromNode', 'Canvas edge');
  requireString(value, 'toNode', 'Canvas edge');
  assertOptionalEnum(value, 'fromSide', ['top', 'right', 'bottom', 'left']);
  assertOptionalEnum(value, 'toSide', ['top', 'right', 'bottom', 'left']);
  assertOptionalEnum(value, 'fromEnd', ['none', 'arrow']);
  assertOptionalEnum(value, 'toEnd', ['none', 'arrow']);
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  owner: string
): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    throw new TypeError(`${owner} ${key} must be a non-empty string`);
  }
}

/** Present and a string, but allowed to be empty. See the native-card note above. */
function requirePossiblyEmptyString(
  value: Record<string, unknown>,
  key: string,
  owner: string
): void {
  if (typeof value[key] !== 'string') {
    throw new TypeError(`${owner} ${key} must be a string`);
  }
}

function assertOptionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[]
): void {
  const candidate = value[key];
  if (candidate !== undefined && !allowed.includes(candidate as string)) {
    throw new TypeError(`Canvas edge ${key} has an invalid value`);
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
