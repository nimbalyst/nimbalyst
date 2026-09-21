import * as Y from "yjs";
import { diffChars } from "diff";
import { getYCsv } from "./seed";

/**
 * Keep the character identities that the grid actually read. Applying a diff
 * directly to a newer document would delete remote insertions as if they were
 * local deletions. A private Yjs branch lets the normal CRDT merge preserve them.
 * It lives only for one serialization drain; it is never persisted or synced.
 */
export class CsvPublication {
  private readonly branch = new Y.Doc();
  private readonly text: Y.Text;

  constructor(doc: Y.Doc, writerId: number) {
    Y.applyUpdate(this.branch, Y.encodeStateAsUpdate(doc));
    // Reuse one writer identity for this binding, not one per polling tick.
    // The copied live state includes the clocks from all earlier drains.
    this.branch.clientID = writerId;
    this.text = getYCsv(this.branch);
  }

  get content(): string {
    return this.text.toString();
  }

  publish(content: string, target: Y.Doc, origin: unknown): void {
    const prev = this.content;
    if (content === prev) return;
    const before = Y.encodeStateVector(this.branch);
    let prefix = 0;
    while (
      prefix < Math.min(prev.length, content.length) &&
      prev[prefix] === content[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < Math.min(prev.length, content.length) - prefix &&
      prev[prev.length - 1 - suffix] === content[content.length - 1 - suffix]
    )
      suffix++;
    const changes = diffChars(
      prev.slice(prefix, prev.length - suffix),
      content.slice(prefix, content.length - suffix)
    );
    this.branch.transact(() => {
      let cursor = prefix;
      let removed = 0;
      let inserted = "";
      const flush = () => {
        // Insert before removing to stay before descendants of deleted
        // characters, including a concurrent append at the end of a row.
        if (inserted) this.text.insert(cursor, inserted);
        if (removed) this.text.delete(cursor + inserted.length, removed);
        cursor += inserted.length;
        removed = 0;
        inserted = "";
      };
      for (const change of changes) {
        if (change.removed) removed += change.value.length;
        else if (change.added) inserted += change.value;
        else {
          flush();
          cursor += change.value.length;
        }
      }
      flush();
    });
    Y.applyUpdate(target, Y.encodeStateAsUpdate(this.branch, before), origin);
  }

  destroy(): void {
    this.branch.destroy();
  }
}
