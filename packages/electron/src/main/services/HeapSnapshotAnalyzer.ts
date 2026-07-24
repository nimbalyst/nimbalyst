import { createReadStream, promises as fs } from "fs";
import * as path from "path";

const DEFAULT_TOP_LIMIT = 50;
const STRING_PREVIEW_LENGTH = 160;
const CONSTRUCTOR_NAME_LENGTH = 240;
const MAX_HEADER_BYTES = 5 * 1024 * 1024;

interface HeapSnapshotMeta {
  node_fields: string[];
  node_types: unknown[];
}

interface HeapSnapshotHeader {
  snapshot?: {
    meta?: HeapSnapshotMeta;
    node_count?: number;
    edge_count?: number;
  };
}

interface AggregateAccumulator {
  nodeType: string;
  nameIndex?: number;
  count: number;
  shallowSizeBytes: number;
}

interface LargestNodeAccumulator {
  nodeId: number;
  nodeType: string;
  nameIndex: number;
  shallowSizeBytes: number;
}

export interface HeapSnapshotAggregate {
  name: string;
  nodeType: string;
  count: number;
  shallowSizeBytes: number;
}

export interface HeapSnapshotLargestNode {
  nodeId: number;
  nodeType: string;
  namePreview: string;
  shallowSizeBytes: number;
}

export interface HeapSnapshotAnalysis {
  path: string;
  fileSizeBytes: number;
  totalHeapSizeBytes: number;
  nodeCount: number;
  edgeCount: number;
  topByShallowSize: HeapSnapshotAggregate[];
  largestStrings: HeapSnapshotLargestNode[];
  largestArrays: HeapSnapshotLargestNode[];
}

class TopNodes {
  private readonly items: LargestNodeAccumulator[] = [];

  constructor(private readonly limit: number) {}

  add(item: LargestNodeAccumulator): void {
    if (this.items.length < this.limit) {
      this.items.push(item);
      return;
    }

    let smallestIndex = 0;
    for (let index = 1; index < this.items.length; index += 1) {
      if (
        this.items[index].shallowSizeBytes <
        this.items[smallestIndex].shallowSizeBytes
      ) {
        smallestIndex = index;
      }
    }

    if (item.shallowSizeBytes > this.items[smallestIndex].shallowSizeBytes) {
      this.items[smallestIndex] = item;
    }
  }

  sorted(): LargestNodeAccumulator[] {
    return [...this.items].sort(
      (left, right) => right.shallowSizeBytes - left.shallowSizeBytes
    );
  }
}

/**
 * Small cursor over a UTF-8 stream. It retains only the unread stream chunk,
 * plus an explicitly collected token such as the tiny snapshot header.
 */
class StreamingCursor {
  private readonly stream: ReturnType<typeof createReadStream>;
  private readonly iterator: AsyncIterator<string>;
  private buffer = "";
  private position = 0;
  private ended = false;

  constructor(filePath: string) {
    this.stream = createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 256 * 1024,
    });
    this.iterator = this.stream[
      Symbol.asyncIterator
    ]() as AsyncIterator<string>;
  }

  close(): void {
    this.stream.destroy();
  }

  private async fill(): Promise<boolean> {
    if (this.position > 0) {
      this.buffer = this.buffer.slice(this.position);
      this.position = 0;
    }
    if (this.ended) return this.buffer.length > 0;

    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return this.buffer.length > 0;
    }
    this.buffer += next.value;
    return true;
  }

  async readUntil(
    literal: string,
    collect = false,
    maxCollectedBytes = Number.POSITIVE_INFINITY
  ): Promise<string> {
    let collected = "";

    while (true) {
      const foundAt = this.buffer.indexOf(literal, this.position);
      if (foundAt >= 0) {
        if (collect) collected += this.buffer.slice(this.position, foundAt);
        this.position = foundAt + literal.length;
        return collected;
      }

      const retain = Math.min(
        literal.length - 1,
        this.buffer.length - this.position
      );
      const consumeEnd = this.buffer.length - retain;
      if (collect && consumeEnd > this.position) {
        collected += this.buffer.slice(this.position, consumeEnd);
        if (Buffer.byteLength(collected, "utf8") > maxCollectedBytes) {
          throw new Error(
            `Heap snapshot header exceeds ${maxCollectedBytes} bytes`
          );
        }
      }
      this.position = consumeEnd;

      if (!(await this.fill())) {
        throw new Error(`Invalid heap snapshot: missing ${literal}`);
      }
    }
  }

  async readNonWhitespace(): Promise<string> {
    while (true) {
      while (this.position < this.buffer.length) {
        const char = this.buffer[this.position];
        this.position += 1;
        if (!/\s/.test(char)) return char;
      }
      if (!(await this.fill())) {
        throw new Error("Invalid heap snapshot: unexpected end of file");
      }
    }
  }

  async readNumericArray(
    onValue: (value: number, index: number) => void
  ): Promise<number> {
    let carry = "";
    let valueIndex = 0;

    while (true) {
      if (this.position >= this.buffer.length && !(await this.fill())) {
        throw new Error("Invalid heap snapshot: unterminated nodes array");
      }

      const closingBracket = this.buffer.indexOf("]", this.position);
      const segmentEnd =
        closingBracket >= 0 ? closingBracket : this.buffer.length;
      const combined = carry + this.buffer.slice(this.position, segmentEnd);

      if (closingBracket >= 0) {
        const tail = combined.trim();
        if (tail.length > 0) {
          for (const token of tail.split(",")) {
            const value = Number(token.trim());
            if (!Number.isFinite(value))
              throw new Error(`Invalid node value: ${token}`);
            onValue(value, valueIndex);
            valueIndex += 1;
          }
        }
        this.position = closingBracket + 1;
        return valueIndex;
      }

      const lastComma = combined.lastIndexOf(",");
      if (lastComma >= 0) {
        const complete = combined.slice(0, lastComma);
        for (const token of complete.split(",")) {
          const trimmed = token.trim();
          if (trimmed.length === 0) continue;
          const value = Number(trimmed);
          if (!Number.isFinite(value))
            throw new Error(`Invalid node value: ${token}`);
          onValue(value, valueIndex);
          valueIndex += 1;
        }
        carry = combined.slice(lastComma + 1);
      } else {
        carry = combined;
      }
      this.position = segmentEnd;
    }
  }

  async readStringArrayEntry(
    maxPreviewLength: number,
    openingQuoteAlreadyConsumed = false
  ): Promise<{ preview: string; truncated: boolean }> {
    if (!openingQuoteAlreadyConsumed) {
      const openingQuote = await this.readNonWhitespace();
      if (openingQuote !== '"') {
        throw new Error(
          `Invalid heap snapshot string table: expected quote, found ${openingQuote}`
        );
      }
    }

    let preview = "";
    let decodedLength = 0;
    let escaped = false;
    let unicodeDigits = "";

    while (true) {
      if (this.position >= this.buffer.length && !(await this.fill())) {
        throw new Error(
          "Invalid heap snapshot: unterminated string table entry"
        );
      }

      while (this.position < this.buffer.length) {
        const char = this.buffer[this.position];
        this.position += 1;

        if (unicodeDigits.length > 0) {
          if (!/[0-9a-fA-F]/.test(char))
            throw new Error(`Invalid unicode escape digit: ${char}`);
          unicodeDigits += char;
          if (unicodeDigits.length === 4) {
            const decoded = String.fromCharCode(
              Number.parseInt(unicodeDigits, 16)
            );
            if (preview.length < maxPreviewLength) preview += decoded;
            decodedLength += 1;
            unicodeDigits = "";
          }
          continue;
        }

        if (escaped) {
          escaped = false;
          if (char === "u") {
            unicodeDigits = "";
            // A sentinel distinguishes an active unicode escape from no escape.
            unicodeDigits += await this.readUnicodeDigit();
            continue;
          }
          const decoded = (
            {
              '"': '"',
              "\\": "\\",
              "/": "/",
              b: "\b",
              f: "\f",
              n: "\n",
              r: "\r",
              t: "\t",
            } as Record<string, string>
          )[char];
          if (decoded === undefined)
            throw new Error(`Invalid JSON escape: \\${char}`);
          if (preview.length < maxPreviewLength) preview += decoded;
          decodedLength += 1;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          return {
            preview: preview.slice(0, maxPreviewLength),
            truncated: decodedLength > maxPreviewLength,
          };
        }
        if (preview.length < maxPreviewLength) preview += char;
        decodedLength += 1;
      }
    }
  }

  private async readUnicodeDigit(): Promise<string> {
    while (this.position >= this.buffer.length) {
      if (!(await this.fill()))
        throw new Error("Invalid heap snapshot: incomplete unicode escape");
    }
    const digit = this.buffer[this.position];
    this.position += 1;
    if (!/[0-9a-fA-F]/.test(digit))
      throw new Error(`Invalid unicode escape digit: ${digit}`);
    return digit;
  }
}

function addAggregate(
  aggregates: Map<string, AggregateAccumulator>,
  nodeType: string,
  nameIndex: number,
  shallowSizeBytes: number
): void {
  const groupByConstructor = nodeType === "object" || nodeType === "native";
  const key = groupByConstructor
    ? `${nodeType}:${nameIndex}`
    : `type:${nodeType}`;
  const current = aggregates.get(key);
  if (current) {
    current.count += 1;
    current.shallowSizeBytes += shallowSizeBytes;
    return;
  }
  aggregates.set(key, {
    nodeType,
    nameIndex: groupByConstructor ? nameIndex : undefined,
    count: 1,
    shallowSizeBytes,
  });
}

interface ResolvedName {
  preview: string;
  truncated: boolean;
}

function formatPreview(value: ResolvedName, maxLength: number): string {
  const preview = value.preview.slice(0, maxLength);
  return value.truncated || value.preview.length > maxLength
    ? `${preview}...`
    : preview;
}

/**
 * Analyze a V8 .heapsnapshot in a single streaming pass. Node records are
 * aggregated as they arrive, edges are skipped, and only names needed by the
 * aggregate/top-node report are retained from the trailing string table.
 */
export async function analyzeHeapSnapshot(
  filePath: string,
  topLimit = DEFAULT_TOP_LIMIT
): Promise<HeapSnapshotAnalysis> {
  if (!path.isAbsolute(filePath))
    throw new Error("Heap snapshot path must be absolute");
  if (path.extname(filePath).toLowerCase() !== ".heapsnapshot") {
    throw new Error("Heap snapshot path must end in .heapsnapshot");
  }
  if (!Number.isInteger(topLimit) || topLimit < 1 || topLimit > 500) {
    throw new Error("topLimit must be an integer between 1 and 500");
  }

  const stat = await fs.stat(filePath);
  if (!stat.isFile())
    throw new Error("Heap snapshot path must refer to a file");

  const cursor = new StreamingCursor(filePath);
  try {
    const beforeNodes = await cursor.readUntil(
      '"nodes"',
      true,
      MAX_HEADER_BYTES
    );
    const header = JSON.parse(
      `${beforeNodes}"nodes":[]}`
    ) as HeapSnapshotHeader;
    const snapshot = header.snapshot;
    const meta = snapshot?.meta;
    if (!snapshot || !meta)
      throw new Error("Invalid heap snapshot: missing snapshot metadata");

    const separator = await cursor.readNonWhitespace();
    if (separator !== ":")
      throw new Error("Invalid heap snapshot: expected colon before nodes");
    const openingBracket = await cursor.readNonWhitespace();
    if (openingBracket !== "[")
      throw new Error("Invalid heap snapshot: expected nodes array");

    const nodeFields = meta.node_fields;
    const typeField = nodeFields.indexOf("type");
    const nameField = nodeFields.indexOf("name");
    const idField = nodeFields.indexOf("id");
    const selfSizeField = nodeFields.indexOf("self_size");
    if (typeField < 0 || nameField < 0 || idField < 0 || selfSizeField < 0) {
      throw new Error(
        "Invalid heap snapshot: required node fields are missing"
      );
    }
    const nodeTypes = meta.node_types[typeField];
    if (
      !Array.isArray(nodeTypes) ||
      !nodeTypes.every((value) => typeof value === "string")
    ) {
      throw new Error("Invalid heap snapshot: node type table is missing");
    }

    const fieldCount = nodeFields.length;
    const aggregates = new Map<string, AggregateAccumulator>();
    const largestStrings = new TopNodes(topLimit);
    const largestArrays = new TopNodes(topLimit);
    let currentType = 0;
    let currentName = 0;
    let currentId = 0;
    let currentSelfSize = 0;
    let totalHeapSizeBytes = 0;

    const parsedValueCount = await cursor.readNumericArray(
      (value, valueIndex) => {
        const fieldIndex = valueIndex % fieldCount;
        if (fieldIndex === typeField) currentType = value;
        if (fieldIndex === nameField) currentName = value;
        if (fieldIndex === idField) currentId = value;
        if (fieldIndex === selfSizeField) currentSelfSize = value;

        if (fieldIndex === fieldCount - 1) {
          const nodeType = nodeTypes[currentType] as string | undefined;
          if (!nodeType)
            throw new Error(
              `Invalid heap snapshot node type index: ${currentType}`
            );
          totalHeapSizeBytes += currentSelfSize;
          addAggregate(aggregates, nodeType, currentName, currentSelfSize);

          const candidate = {
            nodeId: currentId,
            nodeType,
            nameIndex: currentName,
            shallowSizeBytes: currentSelfSize,
          };
          if (
            nodeType === "string" ||
            nodeType === "concatenated string" ||
            nodeType === "sliced string"
          ) {
            largestStrings.add(candidate);
          } else if (nodeType === "array") {
            largestArrays.add(candidate);
          }
        }
      }
    );

    if (parsedValueCount % fieldCount !== 0) {
      throw new Error("Invalid heap snapshot: incomplete node record");
    }
    const nodeCount = parsedValueCount / fieldCount;
    if (
      typeof snapshot.node_count === "number" &&
      snapshot.node_count !== nodeCount
    ) {
      throw new Error(
        `Heap snapshot node count mismatch: metadata=${snapshot.node_count}, parsed=${nodeCount}`
      );
    }

    await cursor.readUntil('"strings"');
    const stringsSeparator = await cursor.readNonWhitespace();
    if (stringsSeparator !== ":")
      throw new Error("Invalid heap snapshot: expected colon before strings");
    const stringsBracket = await cursor.readNonWhitespace();
    if (stringsBracket !== "[")
      throw new Error("Invalid heap snapshot: expected strings array");

    const sortedStrings = largestStrings.sorted();
    const sortedArrays = largestArrays.sorted();
    const neededNames = new Set<number>();
    for (const aggregate of aggregates.values()) {
      if (aggregate.nameIndex !== undefined)
        neededNames.add(aggregate.nameIndex);
    }
    for (const node of [...sortedStrings, ...sortedArrays])
      neededNames.add(node.nameIndex);

    const resolvedNames = new Map<number, ResolvedName>();
    let stringIndex = 0;
    let next = await cursor.readNonWhitespace();
    if (next !== "]") {
      while (true) {
        if (next !== '"')
          throw new Error(
            `Invalid heap snapshot string table at index ${stringIndex}`
          );
        const maxLength = neededNames.has(stringIndex)
          ? Math.max(STRING_PREVIEW_LENGTH, CONSTRUCTOR_NAME_LENGTH)
          : 0;
        const stringValue = await cursor.readStringArrayEntry(maxLength, true);
        if (neededNames.has(stringIndex)) {
          resolvedNames.set(stringIndex, stringValue);
        }
        stringIndex += 1;
        next = await cursor.readNonWhitespace();
        if (next === "]") break;
        if (next !== ",")
          throw new Error(
            `Invalid heap snapshot string table delimiter: ${next}`
          );
        next = await cursor.readNonWhitespace();
      }
    }

    const topByShallowSize = [...aggregates.values()]
      .map(
        (aggregate): HeapSnapshotAggregate => ({
          name:
            aggregate.nameIndex === undefined
              ? aggregate.nodeType
              : resolvedNames.has(aggregate.nameIndex)
              ? formatPreview(
                  resolvedNames.get(aggregate.nameIndex)!,
                  CONSTRUCTOR_NAME_LENGTH
                )
              : `<string #${aggregate.nameIndex}>`,
          nodeType: aggregate.nodeType,
          count: aggregate.count,
          shallowSizeBytes: aggregate.shallowSizeBytes,
        })
      )
      .sort((left, right) => right.shallowSizeBytes - left.shallowSizeBytes)
      .slice(0, topLimit);

    const resolveLargest = (
      nodes: LargestNodeAccumulator[]
    ): HeapSnapshotLargestNode[] =>
      nodes.map((node) => {
        const resolved = resolvedNames.get(node.nameIndex);
        return {
          nodeId: node.nodeId,
          nodeType: node.nodeType,
          namePreview: resolved
            ? formatPreview(resolved, STRING_PREVIEW_LENGTH)
            : `<string #${node.nameIndex}>`,
          shallowSizeBytes: node.shallowSizeBytes,
        };
      });

    return {
      path: filePath,
      fileSizeBytes: stat.size,
      totalHeapSizeBytes,
      nodeCount,
      edgeCount: snapshot.edge_count ?? 0,
      topByShallowSize,
      largestStrings: resolveLargest(sortedStrings),
      largestArrays: resolveLargest(sortedArrays),
    };
  } finally {
    cursor.close();
  }
}
