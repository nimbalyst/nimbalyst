import Store from "electron-store";
import { providerSessionAliases } from "../PGLiteSessionStore";

/**
 * Provider logs (Claude Code transcripts, Codex rollouts) outlive the local
 * session row. When the user deletes a session, its provider id is recorded
 * here so the external-session follower does not import the same log again
 * as a new session (GitHub #1825). The user's provider files are never touched.
 */
interface DeletedExternalSessionsSchema {
  /** `${canonicalProvider}\u001f${externalId}`, oldest first. */
  keys: string[];
}

const MAX_ENTRIES = 5000;

export interface DeletedExternalSessionsStorage {
  get(): string[];
  set(keys: string[]): void;
}

let storage: DeletedExternalSessionsStorage | null = null;
let cache: Set<string> | null = null;

function getStorage(): DeletedExternalSessionsStorage {
  if (!storage) {
    const store = new Store<DeletedExternalSessionsSchema>({
      name: "external-session-deletions",
      clearInvalidConfig: true,
      defaults: { keys: [] },
    });
    storage = {
      get: () => {
        const keys = store.get("keys");
        return Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
      },
      set: (keys) => store.set("keys", keys),
    };
  }
  return storage;
}

function keyOf(providerId: string, externalId: string): string {
  return `${providerSessionAliases(providerId)[0]}\u001f${externalId}`;
}

function loaded(): Set<string> {
  if (!cache) cache = new Set(getStorage().get());
  return cache;
}

export function recordDeletedExternalSession(providerId: string, externalId: string): void {
  if (!providerId || !externalId) return;
  const keys = loaded();
  const key = keyOf(providerId, externalId);
  keys.delete(key);
  keys.add(key);
  while (keys.size > MAX_ENTRIES) keys.delete(keys.values().next().value!);
  getStorage().set([...keys]);
}

export function isDeletedExternalSession(providerId: string, externalId: string): boolean {
  return loaded().has(keyOf(providerId, externalId));
}

/** Tests only. */
export function setDeletedExternalSessionsStorageForTests(next: DeletedExternalSessionsStorage | null): void {
  storage = next;
  cache = null;
}
