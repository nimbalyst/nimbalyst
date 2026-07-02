/**
 * File-tailing helpers for the log-reading MCP tools.
 *
 * Kept dependency-free (only `fs`) so they can be unit-tested without the
 * heavy top-level app imports that `extensionDevServer.ts` pulls in.
 */

import * as fs from "fs";

/**
 * Efficiently read the last N lines from a file.
 * Reads from the end of the file in chunks to avoid loading entire file into memory.
 */
export function tailFile(filePath: string, maxLines: number): string[] {
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  if (fileSize === 0) {
    return [];
  }

  // For small files, just read the whole thing
  if (fileSize < 1024 * 1024) {
    // 1MB
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    return lines.slice(-maxLines);
  }

  // For larger files, read from the end in chunks
  const chunkSize = Math.min(1024 * 1024, fileSize); // 1MB or file size
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(chunkSize);

  try {
    const position = Math.max(0, fileSize - chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, position);

    const content = buffer.toString("utf-8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Scan an ENTIRE file line-by-line, keeping the last `maxMatches` lines that
 * satisfy `predicate`. Reads forward in 1MB chunks so arbitrarily large logs
 * don't blow memory, and stores matches in a fixed-size ring buffer so a
 * pathological predicate (e.g. matching every line) stays bounded.
 *
 * This exists because a plain tail-then-filter only searches the last handful
 * of lines: any matching line older than the tail window is silently dropped,
 * so filtered results diverged from what `grep` over the whole file finds.
 * Use this whenever a filter/search term is supplied. Returns matches in file
 * order (oldest first).
 */
export function grepTailFile(
  filePath: string,
  predicate: (line: string) => boolean,
  maxMatches: number
): string[] {
  const stats = fs.statSync(filePath);
  if (stats.size === 0 || maxMatches <= 0) {
    return [];
  }

  const ring: string[] = new Array(maxMatches);
  let matchCount = 0;
  const consider = (line: string): void => {
    if (line.length === 0 || !predicate(line)) {
      return;
    }
    ring[matchCount % maxMatches] = line;
    matchCount++;
  };

  const chunkSize = 1024 * 1024; // 1MB
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(chunkSize);
  let leftover = "";
  let position = 0;

  try {
    while (position < stats.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, position);
      if (bytesRead <= 0) {
        break;
      }
      position += bytesRead;
      const text = leftover + buffer.toString("utf-8", 0, bytesRead);
      const parts = text.split("\n");
      // Last element may be a partial line spanning into the next chunk.
      leftover = parts.pop() ?? "";
      for (const line of parts) {
        consider(line);
      }
    }
    if (leftover.length > 0) {
      consider(leftover);
    }
  } finally {
    fs.closeSync(fd);
  }

  if (matchCount === 0) {
    return [];
  }
  if (matchCount <= maxMatches) {
    return ring.slice(0, matchCount);
  }
  // Ring wrapped: oldest surviving match is at matchCount % maxMatches.
  const result: string[] = [];
  for (let i = 0; i < maxMatches; i++) {
    result.push(ring[(matchCount + i) % maxMatches]);
  }
  return result;
}
