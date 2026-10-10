import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Also protects dev profiles, which deliberately bypass Electron's instance lock. */
export function withCredentialLock<T>(
  directory: string,
  operation: () => T
): T {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".provider-credentials.lock");
  const candidate = `${lock}.${randomUUID()}`;
  fs.writeFileSync(candidate, String(process.pid), { mode: 0o600, flag: "wx" });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(candidate, lock);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // The holder may release the lock between our link and these reads;
        // a vanished lock means it is free, so try the link again.
        const stat = statUnlessReleased(lock);
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("Unsafe credential lock");
        const pidText = readUnlessReleased(lock);
        if (pidText === null) continue;
        const pid = Number(pidText);
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error("Invalid credential lock");
        let stopped = false;
        try {
          process.kill(pid, 0);
        } catch (cause) {
          stopped = (cause as NodeJS.ErrnoException).code === "ESRCH";
        }
        if (!stopped)
          throw new Error(
            "Credential storage is busy in another process; retry"
          );
        const current = statUnlessReleased(lock);
        if (!current) continue;
        if (current.ino !== stat.ino || current.dev !== stat.dev)
          throw new Error("Credential lock changed; retry");
        fs.unlinkSync(lock);
      }
    }
    if (!acquired) throw new Error("Credential storage is busy; retry");
    return operation();
  } finally {
    if (acquired) fs.unlinkSync(lock);
    fs.unlinkSync(candidate);
  }
}

function isReleased(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function statUnlessReleased(lock: string): fs.Stats | null {
  try {
    return fs.lstatSync(lock);
  } catch (error) {
    if (isReleased(error)) return null;
    throw error;
  }
}

function readUnlessReleased(lock: string): string | null {
  try {
    return fs.readFileSync(lock, "utf8");
  } catch (error) {
    if (isReleased(error)) return null;
    throw error;
  }
}
