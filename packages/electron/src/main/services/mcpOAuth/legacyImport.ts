/**
 * Read-only lookup of credentials an earlier Nimbalyst left in mcp-remote's
 * `~/.mcp-auth` store. Nothing here writes, moves or deletes those files; they
 * stay as the recoverable artifact and keep working for other apps that use
 * mcp-remote.
 *
 * Layouts: 0.16.x uses `mcp-remote-v1/`, 0.1.x used `mcp-remote-<version>/`,
 * and the oldest releases wrote to the root. Files are `<hash>_tokens.json`
 * and `<hash>_client_info.json`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MCPRemoteConfigDescriptor } from '../MCPRemoteOAuth';
import { fingerprintSecret, getMcpRemoteServerHashes } from './serverIdentity';

export interface LegacyTokens {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  /** Epoch ms, when known. */
  expires_at?: number;
  issuer?: string;
}

export interface LegacyClient {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: string;
  redirect_uris: string[];
  issuer?: string;
}

export interface LegacyCandidate {
  tokens: LegacyTokens;
  client?: LegacyClient;
  /** SHA-256 of the refresh token (or the access token when there is none). */
  fingerprint: string;
}

export async function findLegacyCredentials(
  descriptor: Pick<MCPRemoteConfigDescriptor, 'serverUrl' | 'authorizeResource' | 'headers'>,
  authDir: string,
): Promise<LegacyCandidate[]> {
  const hashes = getMcpRemoteServerHashes(descriptor);
  const dirs = await listStoreDirs(authDir);
  const candidates: LegacyCandidate[] = [];
  for (const dir of dirs) {
    for (const hash of hashes) {
      const tokens = await readTokens(path.join(dir, `${hash}_tokens.json`));
      if (!tokens) {
        continue;
      }
      const secret = tokens.refresh_token ?? tokens.access_token;
      if (!secret) {
        continue;
      }
      const client = await readClient(path.join(dir, `${hash}_client_info.json`));
      candidates.push({ tokens, client: client ?? undefined, fingerprint: fingerprintSecret(secret) });
    }
  }
  return candidates;
}

/** Fingerprints of every legacy record for this server, for a revoke tombstone. */
export async function legacyFingerprints(
  descriptor: Pick<MCPRemoteConfigDescriptor, 'serverUrl' | 'authorizeResource' | 'headers'>,
  authDir: string,
): Promise<string[]> {
  return (await findLegacyCredentials(descriptor, authDir)).map((candidate) => candidate.fingerprint);
}

async function listStoreDirs(authDir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(authDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const v1 = entries.some((entry) => entry.isDirectory() && entry.name === 'mcp-remote-v1')
    ? [path.join(authDir, 'mcp-remote-v1')]
    : [];
  const versioned = entries
    .filter((entry) => entry.isDirectory() && /^mcp-remote-\d+\.\d+\.\d+/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersionDirsDescending)
    .map((name) => path.join(authDir, name));
  return [...v1, ...versioned, authDir];
}

function compareVersionDirsDescending(a: string, b: string): number {
  const parse = (name: string) => name.replace(/^mcp-remote-/, '').split(/[.-]/).map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readTokens(file: string): Promise<LegacyTokens | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
    mtimeMs = (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const access = str(parsed.access_token) ?? str(parsed.accessToken);
  const refresh = str(parsed.refresh_token) ?? str(parsed.refreshToken);
  if (!access && !refresh) {
    return null;
  }
  let expiresAt = typeof parsed.expires_at === 'number' ? parsed.expires_at : undefined;
  if (expiresAt === undefined && typeof parsed.expires_in === 'number') {
    expiresAt = mtimeMs + parsed.expires_in * 1000;
  }
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: str(parsed.token_type),
    scope: str(parsed.scope),
    expires_at: expiresAt,
    issuer: str(parsed.issuer),
  };
}

async function readClient(file: string): Promise<LegacyClient | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!parsed || typeof parsed.client_id !== 'string' || parsed.client_id.length === 0) {
      return null;
    }
    return {
      client_id: parsed.client_id,
      client_secret: str(parsed.client_secret),
      client_secret_expires_at: typeof parsed.client_secret_expires_at === 'number' ? parsed.client_secret_expires_at : undefined,
      token_endpoint_auth_method: str(parsed.token_endpoint_auth_method),
      redirect_uris: Array.isArray(parsed.redirect_uris)
        ? parsed.redirect_uris.filter((uri: unknown): uri is string => typeof uri === 'string')
        : [],
      issuer: str(parsed.issuer),
    };
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
