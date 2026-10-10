import ElectronStore from "electron-store";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertPrivateFileWritable, hardenPrivateFile } from "./privateFile";
import {
  readLegacySettings,
  visitLegacyCredentials,
} from "../services/credentials/legacyProviderCredentials";
import { withCredentialLock } from "../services/credentials/credentialLock";

const EMPTY_READ_RETRIES = 3;
const preservedUnreadable = new Set<string>();

function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.keys(value).length === 0;
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isEmptyJsonObject(raw: string): boolean {
  if (raw.trim() === "") return true;
  try {
    return isEmptyObject(JSON.parse(raw));
  } catch {
    return false;
  }
}

/**
 * The file still fails to parse after retries, so conf will treat it as empty
 * and the next write replaces it. Copy it aside first so it can be restored.
 */
function preserveUnreadable(file: string): void {
  const raw = readRaw(file);
  const key = `${file}:${raw?.length}`;
  if (raw === null || isEmptyJsonObject(raw) || preservedUnreadable.has(key)) return;
  preservedUnreadable.add(key);
  const backup = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.error(
    `[PrivateSettingsStore] ${path.basename(file)} is unreadable (${raw.length} bytes); preserved at ${backup} before it is treated as empty`
  );
  fs.writeFileSync(backup, raw, { mode: 0o600 });
}

/** All app-owned settings use this boundary, including bootstrap readers. */
export default class PrivateSettingsStore<
  T extends Record<string, any> = Record<string, unknown>
> extends ElectronStore<T> {
  // conf re-reads and re-parses the file on every access and, with
  // `clearInvalidConfig`, turns any parse failure into `{}`. One bad read then
  // reports every setting at its default (Developer Mode flipping to Standard
  // Mode, NIM-3963), and a `set` during that read writes `{ key }` over the
  // whole file. An empty result is only trusted when the file is really empty.
  override get store(): T {
    let value = super.store;
    for (let attempt = 1; attempt <= EMPTY_READ_RETRIES && isEmptyObject(value); attempt++) {
      const raw = readRaw(this.path);
      if (raw === null || isEmptyJsonObject(raw)) return value;
      console.warn(
        `[PrivateSettingsStore] ${path.basename(this.path)} read as empty but holds ${raw.length} bytes; retrying (${attempt}/${EMPTY_READ_RETRIES})`
      );
      value = super.store;
    }
    if (isEmptyObject(value)) preserveUnreadable(this.path);
    return value;
  }
  override set store(value: T) {
    withCredentialLock(path.dirname(this.path), () => {
      super.store = value;
    });
  }
  constructor(options: ElectronStore.Options<T> = {}) {
    const cwd = options.cwd ?? app.getPath("userData");
    const name = options.name ?? "config";
    if (path.basename(name) !== name || name === "..")
      throw new Error("Invalid settings name");
    const file = path.join(cwd, `${name}.${options.fileExtension ?? "json"}`);
    hardenPrivateFile(file);
    const serialize =
      options.serialize ?? ((value: T) => JSON.stringify(value, null, "\t"));
    super({
      ...options,
      cwd,
      configFileMode: 0o600,
      serialize(value) {
        assertPrivateFileWritable(file);
        if (name === "ai-settings" || name === "workspace-settings") {
          const existing = readLegacySettings(cwd, name).credentials;
          // Only the verified vault migration may remove a pending legacy copy.
          // Metadata-only settings saves must not destroy it while storage is locked.
          for (const old of existing) {
            let target: Record<string, any> = value;
            for (const part of old.location.slice(0, -1))
              target = target[part] ??= {};
            const field = old.location[old.location.length - 1];
            if (target[field] === undefined) target[field] = old.value;
          }
          const incoming = visitLegacyCredentials(name, value);
          if (incoming.length) {
            if (
              incoming.some(
                (next) =>
                  !existing.some(
                    (old) =>
                      old.name === next.name &&
                      old.workspacePath === next.workspacePath &&
                      old.value === next.value
                  )
              )
            ) {
              throw new Error(
                "Provider credentials must be written through secure storage"
              );
            }
          }
        }
        return serialize(value);
      },
    });
  }
}

/** Repair dormant settings files too, before bootstrap opens any store. */
export function hardenExistingSettings(directory: string): void {
  for (const name of [
    "app-settings",
    "ai-settings",
    "workspace-settings",
    "nimbalyst-settings",
    "analytics-settings",
    "feature-usage",
    "feature-tracking",
    "logger-config",
    "terminal-store",
  ]) {
    hardenPrivateFile(path.join(directory, `${name}.json`));
  }
}
