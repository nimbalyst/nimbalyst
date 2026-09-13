import * as fs from "fs";
import * as path from "path";
import type { DryRunManifest } from "./PGLiteToSQLiteMigrator";

export const DRY_RUN_MANIFEST_FILENAME = ".dry-run-manifest.json";

/** A manifest is published only once the successful target has closed. */
export function findDryRunArtifact(
  userData: string
): { dir: string; manifest: DryRunManifest } | null {
  if (!fs.existsSync(userData)) return null;
  const candidates = fs
    .readdirSync(userData)
    .filter((name) => name.startsWith("sqlite-db.dry-run-"))
    .flatMap((name) => {
      const dir = path.join(userData, name);
      try {
        const stat = fs.statSync(dir);
        return stat.isDirectory() ? [{ dir, mtime: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of candidates) {
    const manifestPath = path.join(dir, DRY_RUN_MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8")
      ) as DryRunManifest;
      if (
        typeof manifest.completedAt !== "string" ||
        !Array.isArray(manifest.perTable) ||
        !manifest.perTable.every(
          (table) =>
            typeof table.name === "string" &&
            Number.isFinite(table.rows) &&
            table.rows >= 0
        )
      )
        continue;
      return { dir, manifest };
    } catch {
      // Corrupt manifest; skip this dir and try the next one.
    }
  }
  return null;
}
