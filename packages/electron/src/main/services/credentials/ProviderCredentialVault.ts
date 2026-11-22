import { withCredentialLock } from "./credentialLock";
import fs from "node:fs";
import path from "node:path";
import type {
  CredentialScope,
  ProviderCredentialSnapshot,
} from "../../../shared/providerCredentials";
import { SAVED_CREDENTIAL } from "../../../shared/providerCredentials";
import { hardenPrivateFile, writePrivateFile } from "../../utils/privateFile";
import {
  normalizeCredentialWorkspace,
  readLegacySettings,
} from "./legacyProviderCredentials";

export interface CredentialEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
interface CredentialRecord extends CredentialScope {
  name: string;
  value: string | null;
}
interface VaultData {
  version: 1;
  records: CredentialRecord[];
}
export class CredentialStorageError extends Error {
  constructor(
    public readonly state: Exclude<
      ProviderCredentialSnapshot["state"],
      "available"
    >
  ) {
    super(
      state === "unavailable"
        ? "Secure storage is unavailable. Unlock your keychain and retry; API-key authentication is paused."
        : state === "migration-pending"
        ? "Credential migration needs attention. API-key authentication is paused; retry or clear the affected key."
        : "Stored credentials could not be read. Unlock secure storage and retry; existing data has been preserved."
    );
  }
}

export class ProviderCredentialVault {
  private readonly file: string;
  private dirty = false;
  private cached?: { signature: string; data: VaultData };
  private validateDirectory(): void {
    try {
      const stat = fs.lstatSync(path.dirname(this.file));
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new CredentialStorageError("unreadable");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private signature(): string {
    this.validateDirectory();
    return [
      "ai-settings.json",
      "workspace-settings.json",
      "provider-credentials/vault.bin",
    ]
      .map((name) => {
        const file = path.join(this.directory, name);
        if (hardenPrivateFile(file) === undefined) return "missing";
        const stat = fs.statSync(file);
        return [
          stat.ino,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
          stat.mode,
        ].join(":");
      })
      .join("|");
  }
  private read(): VaultData {
    try {
      const signature = this.signature();
      if (!this.encryption.available())
        throw new CredentialStorageError("unavailable");
      if (this.cached?.signature === signature)
        return structuredClone(this.cached.data);
      return this.run(() => {
        const data = this.prepare();
        this.cached = {
          signature: this.signature(),
          data: structuredClone(data),
        };
        return data;
      });
    } catch (error) {
      throw error instanceof CredentialStorageError
        ? error
        : new CredentialStorageError("unreadable");
    }
  }
  private run<T>(operation: () => T): T {
    try {
      return withCredentialLock(this.directory, operation);
    } finally {
      if (this.dirty) {
        this.dirty = false;
        this.changed();
      }
    }
  }
  constructor(
    private readonly directory: string,
    private readonly encryption: CredentialEncryption,
    private readonly changed: () => void = () => {}
  ) {
    this.file = path.join(directory, "provider-credentials", "vault.bin");
  }

  private scope(scope: CredentialScope): CredentialScope {
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
      throw new Error("Invalid credential scope");
    if (scope.workspacePath === undefined) return {};
    if (
      typeof scope.workspacePath !== "string" ||
      !scope.workspacePath ||
      !path.isAbsolute(scope.workspacePath)
    )
      throw new Error("An absolute workspace path is required");
    return { workspacePath: normalizeCredentialWorkspace(scope.workspacePath) };
  }
  private validateName(name: string): void {
    if (
      typeof name !== "string" ||
      !name ||
      name === "lmstudio_url" ||
      name.length > 200 ||
      /[\x00-\x1f]/.test(name)
    )
      throw new Error("Invalid credential name");
  }
  private matches(
    record: CredentialRecord,
    name: string,
    scope: CredentialScope
  ): boolean {
    return record.name === name && record.workspacePath === scope.workspacePath;
  }
  private metadata(data: VaultData): ProviderCredentialSnapshot["credentials"] {
    return data.records
      .filter((r) => r.value !== null)
      .map(({ name, workspacePath }) => ({
        name,
        workspacePath,
        configured: true,
      }));
  }
  private envelope():
    | {
        version: 1;
        credentials: ProviderCredentialSnapshot["credentials"];
        ciphertext: string;
      }
    | undefined {
    this.validateDirectory();
    if (hardenPrivateFile(this.file) === undefined) return undefined;
    try {
      const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        envelope.version !== 1 ||
        typeof envelope.ciphertext !== "string" ||
        !Array.isArray(envelope.credentials)
      )
        throw new Error();
      for (const credential of envelope.credentials) {
        this.validateName(credential.name);
        this.scope(credential);
        if (credential.configured !== true) throw new Error();
      }
      return { version: 1, ciphertext: envelope.ciphertext,
        credentials: envelope.credentials.map(({name, workspacePath}: {name: string; workspacePath?: string}) => ({name, workspacePath, configured: true})) };
    } catch {
      throw new CredentialStorageError("unreadable");
    }
  }
  private configuredMetadata(): ProviderCredentialSnapshot["credentials"] {
    return [
      ...(this.envelope()?.credentials ?? []),
      ...["ai-settings", "workspace-settings"].flatMap((name) =>
        readLegacySettings(this.directory, name)
          .credentials.filter((r) => r.value)
          .map(({ name, workspacePath }) => ({
            name,
            workspacePath,
            configured: true as const,
          }))
      ),
    ];
  }
  private load(): VaultData {
    const envelope = this.envelope();
    if (!envelope) return { version: 1, records: [] };
    try {
      const data = JSON.parse(
        this.encryption.decrypt(Buffer.from(envelope.ciphertext, "base64"))
      );
      if (data?.version !== 1 || !Array.isArray(data.records))
        throw new Error();
      const seen = new Set<string>();
      for (const record of data.records) {
        if (
          !record ||
          typeof record.name !== "string" ||
          (record.value !== null && typeof record.value !== "string")
        )
          throw new Error();
        this.scope(record);
        this.validateName(record.name);
        const id = JSON.stringify([record.name, record.workspacePath]);
        if (seen.has(id)) throw new Error();
        seen.add(id);
      }
      if (
        JSON.stringify(this.metadata(data)) !==
        JSON.stringify(envelope.credentials)
      )
        throw new Error();
      return data;
    } catch {
      throw new CredentialStorageError("unreadable");
    }
  }
  private persist(data: VaultData): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new CredentialStorageError("unreadable");
    fs.chmodSync(dir, 0o700);
    try {
      const text = JSON.stringify(data);
      const envelope = JSON.stringify({
        version: 1,
        credentials: this.metadata(data),
        ciphertext: this.encryption.encrypt(text).toString("base64"),
      });
      writePrivateFile(this.file, envelope, (bytes) => {
        if (
          this.encryption.decrypt(
            Buffer.from(JSON.parse(bytes.toString()).ciphertext, "base64")
          ) !== text
        )
          throw new Error("Credential verification failed");
      });
      if (JSON.stringify(this.load()) !== text) throw new Error();
    } catch {
      throw new CredentialStorageError("unreadable");
    }
  }

  /** The credential lock covers migration and writes across all userData instances. */
  private prepare(): VaultData {
    let sources: ReturnType<typeof readLegacySettings>[];
    try {
      sources = ["ai-settings", "workspace-settings"].map((name) =>
        readLegacySettings(this.directory, name)
      );
    } catch {
      throw new CredentialStorageError("unreadable");
    }
    if (!this.encryption.available())
      throw new CredentialStorageError("unavailable");
    const data = this.load();
    const legacy = sources.flatMap((source) => source.credentials);
    if (legacy.length) {
      for (const record of legacy) {
        this.validateName(record.name);
        const value = record.value || null;
        const existing = data.records.find((item) =>
          this.matches(item, record.name, record)
        );
        if (existing && existing.value !== value)
          throw new CredentialStorageError("migration-pending");
        if (!existing)
          data.records.push({
            name: record.name,
            workspacePath: record.workspacePath,
            value,
          });
      }
      this.persist(data);
      try {
        for (const source of sources) {
          if (!source.credentials.length) continue;
          const name = path.basename(source.file, ".json");
          const latest = readLegacySettings(this.directory, name);
          for (const record of latest.credentials) {
            if (
              source.credentials.some(
                (original) =>
                  this.matches(record, original.name, original) &&
                  original.value === record.value
              )
            )
              record.remove();
          }
          writePrivateFile(
            source.file,
            JSON.stringify(latest.data, null, "\t")
          );
          if (readLegacySettings(this.directory, name).credentials.length)
            throw new Error("Legacy credentials changed during migration");
        }
      } catch {
        throw new CredentialStorageError("migration-pending");
      }
      this.dirty = true;
    }
    return data;
  }

  snapshot(): ProviderCredentialSnapshot {
    try {
      return {
        state: "available",
        credentials: this.read()
          .records.filter((r) => r.value !== null)
          .map(({ name, workspacePath }) => ({
            name,
            workspacePath,
            configured: true,
          })),
      };
    } catch (error) {
      const failure =
        error instanceof CredentialStorageError
          ? error
          : new CredentialStorageError("unreadable");
      // Metadata remains reachable for clearing pending legacy entries.
      let credentials: ProviderCredentialSnapshot["credentials"] = [];
      try {
        credentials = this.configuredMetadata();
      } catch {
        /* Never read unsafe files to manufacture a status. */
      }
      return { state: failure.state, message: failure.message, credentials };
    }
  }
  get(name: string, scope: CredentialScope = {}): string | undefined {
    this.validateName(name);
    const normalized = this.scope(scope);
    try {
      return (
        this.read().records.find((r) => this.matches(r, name, normalized))
          ?.value ?? undefined
      );
    } catch (error) {
      // Non-secret inventory keeps OAuth usable while configured key auth fails closed.
      if (
        error instanceof CredentialStorageError &&
        error.state === "unavailable" &&
        !this.configuredMetadata().some(
          (r) => r.name === name && r.workspacePath === normalized.workspacePath
        )
      )
        return undefined;
      throw error;
    }
  }
  /** Missing means no desktop opinion; empty means a durable deletion to sync. */
  mobileOpenAIKey(): string | undefined {
    try {
      const record = this.read().records.find(
        (r) => r.name === "openai" && !r.workspacePath
      );
      return record ? record.value ?? "" : undefined;
    } catch (error) {
      if (error instanceof CredentialStorageError) {
        // A failed safeStorage read can leave an OpenSSL error queued that
        // aborted later WebCrypto AES on this Node version (#1979); logged so
        // a report shows whether this path ran.
        console.warn(`[ProviderCredentialVault] mobileOpenAIKey skipped: credential storage ${error.state}`);
        return undefined;
      }
      throw error;
    }
  }
  /** Discovery may keep OAuth/local providers usable while saved-key auth is paused. */
  availableKeys(scope: CredentialScope = {}): Record<string, string> {
    try {
      const normalized = this.scope(scope);
      return Object.fromEntries(
        this.read()
          .records.filter(
            (r) =>
              r.workspacePath === normalized.workspacePath && r.value !== null
          )
          .map((r) => [r.name, r.value as string])
      );
    } catch (error) {
      if (error instanceof CredentialStorageError) return {};
      throw error;
    }
  }
  set(name: string, value: string, scope: CredentialScope = {}): void {
    this.validateName(name);
    this.run(() => {
      if (
        !name ||
        name === "lmstudio_url" ||
        name.length > 200 ||
        typeof value !== "string" ||
        value === SAVED_CREDENTIAL
      )
        throw new Error("Invalid provider credential");
      const normalized = this.scope(scope);
      const data = this.prepare();
      const record = data.records.find((r) =>
        this.matches(r, name, normalized)
      );
      if (record) record.value = value || null;
      else data.records.push({ name, ...normalized, value: value || null });
      this.persist(data);
      this.dirty = true;
    });
  }
  /** Project rename keeps credentials with the project, without recreating plaintext. */
  moveWorkspace(oldPath: string, newPath: string): void {
    const oldScope = this.scope({workspacePath: oldPath});
    const newScope = this.scope({workspacePath: newPath});
    if (oldScope.workspacePath === newScope.workspacePath) return;
    if (!this.configuredMetadata().some(r => r.workspacePath === oldScope.workspacePath)) return;
    this.run(() => {
      const data = this.prepare();
      const moving = data.records.filter(r => r.workspacePath === oldScope.workspacePath);
      for (const record of moving) {
        const destination = data.records.find(r => this.matches(r, record.name, newScope));
        if (destination && destination.value !== record.value) throw new CredentialStorageError('migration-pending');
      }
      data.records = data.records.filter(r => r.workspacePath !== oldScope.workspacePath);
      for (const record of moving) {
        if (!data.records.some(r => this.matches(r, record.name, newScope))) data.records.push({...record, ...newScope});
      }
      this.persist(data);
      this.dirty = true;
    });
  }
  delete(name: string, scope: CredentialScope = {}): void {
    this.validateName(name);
    this.run(() => {
      const normalized = this.scope(scope);
      // Explicit deletion can resolve a legacy conflict, but must never erase an unreadable vault.
      const sources = ["ai-settings", "workspace-settings"].map((key) =>
        readLegacySettings(this.directory, key)
      );
      if (!this.encryption.available())
        throw new CredentialStorageError("unavailable");
      const data = this.load();
      const record = data.records.find((r) =>
        this.matches(r, name, normalized)
      );
      if (record) record.value = null;
      else data.records.push({ name, ...normalized, value: null });
      this.persist(data);
      for (const source of sources) {
        const matches = source.credentials.filter((r) =>
          this.matches(r, name, normalized)
        );
        if (!matches.length) continue;
        matches.forEach((r) => r.remove());
        writePrivateFile(source.file, JSON.stringify(source.data, null, "\t"));
      }
      this.dirty = true;
    });
  }
}
