/**
 * The extension's own JSON files in its data dir: the usage ledger and the
 * runtime cache.
 *
 * Saves are serialized per file and the data is serialized when the save is
 * requested, so overlapping saves land in request order and the last one
 * wins. Each write goes to its own temp file and is renamed into place, so a
 * crash leaves the old file or the new one, never a torn or interleaved one.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CrewRuntimeCache } from './crewRuntime';
import type { LedgerData } from './crewLedger';

function jsonFile(file: string) {
  let queue: Promise<void> = Promise.resolve();
  return {
    /** The parsed file, null when missing, `undefined` when present but not JSON. */
    async read(): Promise<unknown> {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    },
    save(data: unknown): Promise<void> {
      const text = JSON.stringify(data);
      const write = async () => {
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, text, 'utf8');
          await rename(tmp, file);
        } catch (error) {
          await rm(tmp, { force: true }).catch(() => undefined);
          throw error;
        }
      };
      const result = queue.then(write);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

export function ledgerFile(dataDir: string) {
  const file = path.join(dataDir, 'usage-ledger.json');
  const json = jsonFile(file);
  return {
    async load(): Promise<unknown | null> {
      const value = await json.read();
      // A parse failure is reported to the runtime as an unrecognized shape, not thrown.
      return value === undefined ? { unparseable: true } : value;
    },
    save: (data: LedgerData) => json.save(data),
    /** Never deletes: the damaged ledger is kept beside the new one. */
    async setAside(): Promise<string | null> {
      const target = path.join(dataDir, `usage-ledger.unreadable-${Date.now()}.json`);
      try {
        await rename(file, target);
        return target;
      } catch {
        return null;
      }
    },
  };
}

export function fileCache(dataDir: string) {
  const json = jsonFile(path.join(dataDir, 'runtime-cache.json'));
  return {
    async load(): Promise<CrewRuntimeCache | null> {
      // The cache is rebuildable; an unreadable one is treated as absent.
      const value = await json.read().catch(() => null);
      return value && typeof value === 'object' ? (value as CrewRuntimeCache) : null;
    },
    save: (cache: CrewRuntimeCache) => json.save(cache),
  };
}
