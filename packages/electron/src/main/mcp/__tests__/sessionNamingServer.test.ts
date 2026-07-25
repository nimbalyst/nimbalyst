import { describe, expect, it } from "vitest";

import { buildSessionMetaToolSchemas } from "../sessionNamingServer";

describe("buildSessionMetaToolSchemas", () => {
  it("keeps the eager schema byte-stable across sessions and tag mutations", async () => {
    const before = await buildSessionMetaToolSchemas("session-before-tags");
    const after = await buildSessionMetaToolSchemas("session-after-tags");

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    const addDescription = before[0].inputSchema.properties.add.description;
    expect(addDescription).toBe(
      "Tags to add: lowercase hyphen-separated type of work (bug-fix, feature, refactor) and area/module (electron, runtime, ios). Reuse existing workspace tags when known."
    );
    expect(addDescription).not.toMatch(/\(\d+\)/);
  });
});
