import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";

/**
 * Directory-owned, account-scoped identity. Never adopts the ambiguous hostname ID.
 * Compatibility contract: the seed format, computer-v1 domain, JSON field order,
 * decimal filesystem identifiers, and 32-hex truncation must remain unchanged.
 * App version, release channel, executable location, and hostname are NOT inputs.
 */
export function directoryDeviceId(
  userData: string,
  personalMemberId: PersonalMemberId
): string {
  if (!userData || !personalMemberId)
    throw new Error(
      "Computer identity requires a data directory and personal account"
    );
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const directory = realpathSync(userData);
  const file = join(directory, "computer-identity");
  let seed: string;
  try {
    seed = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Publish a complete, flushed file without replacing another launch's winner.
    const candidate = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(candidate, "wx", 0o600);
    try {
      writeFileSync(fd, randomUUID());
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      try {
        linkSync(candidate, file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    } finally {
      unlinkSync(candidate);
    }
    seed = readFileSync(file, "utf8");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      seed
    )
  ) {
    throw new Error(
      "Computer identity is unreadable; restore computer-identity from the data directory backup"
    );
  }
  // Copies get a new identity even when they contain the same seed. Symlinks
  // and same-filesystem directory renames preserve it. A cross-volume copy or
  // restore is a new installation; session ownership is never rewritten here.
  const { dev, ino } = statSync(directory, { bigint: true });
  return createHash("sha256")
    .update(
      JSON.stringify([
        "computer-v1",
        seed,
        String(dev),
        String(ino),
        personalMemberId,
      ])
    )
    .digest("hex")
    .slice(0, 32);
}
