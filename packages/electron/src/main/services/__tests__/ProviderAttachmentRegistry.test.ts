import { describe, expect, it } from "vitest";
import { ProviderAttachmentRegistry } from "../ProviderAttachmentRegistry";

const identity = { accountId: "account", orgId: "org", documentId: "doc" };

describe("ProviderAttachmentRegistry", () => {
  it("keeps a new provider attached when a superseded entry detaches", () => {
    const registry = new ProviderAttachmentRegistry();
    registry.attach(7, identity, "old-entry");
    registry.attach(7, identity, "new-entry");

    registry.detach(7, identity, "old-entry");
    expect(registry.isAttached(identity)).toBe(true);

    registry.detach(7, identity, "new-entry");
    expect(registry.isAttached(identity)).toBe(false);
  });

  it("keeps claims in other windows when one renderer is destroyed", () => {
    const registry = new ProviderAttachmentRegistry();
    registry.attach(7, identity, "window-a");
    registry.attach(8, identity, "window-b");

    expect(registry.clearSender(7)).toEqual([identity]);
    expect(registry.isAttached(identity)).toBe(true);
    registry.clearSender(8);
    expect(registry.isAttached(identity)).toBe(false);
  });

  it("targets every sibling renderer holding the same document", () => {
    const registry = new ProviderAttachmentRegistry();
    registry.attach(7, identity, "window-a");
    registry.attach(8, identity, "window-b");
    registry.attach(9, { ...identity, documentId: "other" }, "other-doc");

    expect(registry.attachedSenderIds(identity, 7)).toEqual([8]);
    expect(registry.attachedSenderIds(identity)).toEqual([7, 8]);
  });
});
