import { readFileSync } from "fs";

/** Read errors must propagate to the save handler's classified failure result, never authorize a write. */
export function verifyFileSave(
  filePath: string,
  expectedContent: string | undefined
) {
  if (expectedContent === undefined) return null; // Explicit manual overwrite / legacy caller.
  try {
    const diskContent = readFileSync(filePath, "utf8");
    return diskContent === expectedContent
      ? null
      : {
          success: false as const,
          conflict: true as const,
          filePath,
          diskContent,
        };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { success: false as const, deleted: true as const, filePath };
    throw error;
  }
}
