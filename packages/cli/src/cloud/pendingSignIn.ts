/**
 * The device code a `teamSignIn` call showed the user, kept next to the
 * credentials so a later call in a NEW `nim mcp` process can finish it. Hosts
 * that start each agent turn fresh relaunch the MCP server, and the follow-up
 * call that completes a sign-in then lands in a process that never saw the
 * code. Without this, every call started a new code and no approval could
 * complete.
 *
 * Best effort: an unreadable file means "nothing pending", and the worst case
 * is a new code. Written 0600 like the credentials, because a device code can
 * be exchanged for tokens once approved.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PendingDeviceLogin } from './auth.js';
import { credentialsPath } from './credentials.js';

function pendingPath(): string {
  return path.join(path.dirname(credentialsPath()), 'pending-sign-in.json');
}

function readAll(): Record<string, PendingDeviceLogin> {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    return parsed && typeof parsed.servers === 'object' && parsed.servers ? parsed.servers : {};
  } catch {
    return {};
  }
}

function writeAll(servers: Record<string, PendingDeviceLogin>): void {
  const file = pendingPath();
  if (Object.keys(servers).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ servers }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The pending sign-in for `server`, unless it has expired. */
export function loadPendingSignIn(server: string): PendingDeviceLogin | undefined {
  const pending = readAll()[server];
  if (!pending || typeof pending.deviceCode !== 'string' || typeof pending.deadline !== 'number') return undefined;
  return pending.deadline > Date.now() ? pending : undefined;
}

export function savePendingSignIn(server: string, pending: PendingDeviceLogin): void {
  try {
    writeAll({ ...readAll(), [server]: pending });
  } catch {
    // Not fatal: this process still finishes the code itself.
  }
}

export function clearPendingSignIn(server: string): void {
  try {
    const servers = readAll();
    if (!(server in servers)) return;
    delete servers[server];
    writeAll(servers);
  } catch {
    // Not fatal: an expired entry is ignored on read.
  }
}
