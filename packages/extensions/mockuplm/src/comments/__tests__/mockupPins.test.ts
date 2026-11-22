// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createLabelSnapshot,
  resolveAndHealMockupPin,
  resolveMockupPin,
} from "../resolveMockupPin";
import {
  MockupPinRepository,
  numberUnresolvedPins,
} from "../mockupPinRepository";
import type { MockupPin } from "../../collab/seed";
import {
  bindMockupPinStore,
  canWriteMockupPins,
  guardMockupPinWrites,
} from "../mockupPinStore";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function pin(overrides: Partial<MockupPin> = {}): MockupPin {
  return {
    id: "pin-1",
    selector: "#save",
    labelSnapshot: "button:Save changes",
    offset: { xPct: 0.5, yPct: 0.5 },
    viewport: { width: 1440, label: "Desktop" },
    createdAt: 100,
    createdBy: "user-1",
    ...overrides,
  };
}

describe("mockup pin resolution", () => {
  it("attaches an exact selector that identifies one element", () => {
    const document = parse('<button id="save">Save changes</button>');

    const result = resolveMockupPin(document, pin());

    expect(result.status).toBe("attached");
    expect(result.target).toBe(document.querySelector("#save"));
    expect(result.selectorUpdate).toBeNull();
  });

  it("fails closed when both the selector and exact label are ambiguous", () => {
    const document = parse(
      [
        '<button class="action">Save changes</button>',
        '<button class="action">Save changes</button>',
      ].join("")
    );

    const result = resolveMockupPin(document, pin({ selector: ".action" }));

    expect(result.status).toBe("detached");
    expect(result.target).toBeNull();
    expect(result.selectorUpdate).toBeNull();
  });

  it("heals a broken selector by one exact label match", () => {
    const document = parse(
      '<main><button id="replacement">Save changes</button></main>'
    );

    const result = resolveMockupPin(document, pin({ selector: "#removed" }));

    expect(result.status).toBe("healed");
    expect(result.target).toBe(document.querySelector("#replacement"));
    expect(result.selectorUpdate).toBe("#replacement");
  });

  it("writes a healed selector back only for a unique exact label", () => {
    const yDoc = new Y.Doc();
    const repository = new MockupPinRepository(yDoc);
    repository.create(pin({ id: "unique", selector: "#removed" }));
    repository.create(pin({ id: "ambiguous", selector: "#removed" }));

    const uniqueDocument = parse(
      '<button class="primary">Save changes</button>'
    );
    const ambiguousDocument = parse(
      ["<button>Save changes</button>", "<button>Save changes</button>"].join(
        ""
      )
    );

    const uniquePin = repository.snapshot().find(({ id }) => id === "unique")!;
    const ambiguousPin = repository
      .snapshot()
      .find(({ id }) => id === "ambiguous")!;
    expect(
      resolveAndHealMockupPin(uniqueDocument, uniquePin, repository).status
    ).toBe("healed");
    expect(
      resolveAndHealMockupPin(ambiguousDocument, ambiguousPin, repository)
        .status
    ).toBe("detached");
    expect(
      repository.snapshot().map(({ id, selector }) => ({ id, selector }))
    ).toEqual([
      { id: "ambiguous", selector: "#removed" },
      { id: "unique", selector: ".primary" },
    ]);
    repository.destroy();
    yDoc.destroy();
  });

  it("writes nothing to mockupPins for a user who may not write the body (commenter)", () => {
    const yDoc = new Y.Doc();
    const repository = new MockupPinRepository(yDoc);
    repository.create(pin({ id: "p1", selector: "#removed" }));
    const service = { getCapabilities: () => ({ read: true, comment: false, editBody: false }) };
    const store = guardMockupPinWrites(bindMockupPinStore(repository), () => canWriteMockupPins(service));
    const updates = vi.fn();
    yDoc.on("update", updates);

    // Render-time selector healing still resolves, but persists nothing.
    const healed = resolveAndHealMockupPin(
      parse('<button class="primary">Save changes</button>'),
      repository.snapshot()[0]!,
      store
    );
    expect(healed.status).toBe("healed");
    // Passive collection and a direct create are skipped too.
    expect(store.delete("p1")).toBe(false);
    store.create(pin({ id: "p2" }));
    expect(updates).not.toHaveBeenCalled();
    expect(store.snapshot().map(({ id, selector }) => ({ id, selector })))
      .toEqual([{ id: "p1", selector: "#removed" }]);

    // An editor's store, and one outside a room, still write.
    expect(canWriteMockupPins({ getCapabilities: () => ({ read: true, comment: true }) })).toBe(true);
    expect(canWriteMockupPins(null)).toBe(true);
    repository.destroy();
    yDoc.destroy();
  });

  it("detaches when neither selector nor label identifies a target", () => {
    const document = parse("<p>Something else</p>");

    expect(
      resolveMockupPin(document, pin({ selector: "#removed" })).status
    ).toBe("detached");
  });

  it("attaches a null-selector pin against the document box without healing it", () => {
    const document = parse("<button>Save changes</button>");

    const result = resolveMockupPin(document, pin({ selector: null }));

    expect(result.status).toBe("attached");
    expect(result.referenceBox).toBe("document");
    expect(result.target).toBeNull();
    expect(result.selectorUpdate).toBeNull();
  });

  it("reports an existing but non-rendered target as hidden, not detached", () => {
    const document = parse(
      '<section hidden><button id="save">Save changes</button></section>'
    );

    const result = resolveMockupPin(document, pin());

    expect(result.status).toBe("hidden");
    expect(result.target).toBe(document.querySelector("#save"));
  });

  it("normalizes tag and visible text into the placement/healing label", () => {
    const document = parse(
      "<button>  Save\n <strong>changes</strong> </button>"
    );

    expect(createLabelSnapshot(document.querySelector("button")!)).toBe(
      "button:Save changes"
    );
  });
});

describe("MockupPinRepository", () => {
  it("creates, updates, deletes, subscribes, and returns stable immutable snapshots", () => {
    const yDoc = new Y.Doc();
    const repository = new MockupPinRepository(yDoc);
    const listener = vi.fn();
    const unsubscribe = repository.subscribe(listener);

    repository.create(pin());
    const first = repository.snapshot();
    expect(repository.snapshot()).toBe(first);
    expect(first).toEqual([pin()]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0].offset)).toBe(true);
    expect(Object.isFrozen(first[0].viewport)).toBe(true);

    expect(repository.updateSelector("pin-1", ".primary")).toBe(true);
    expect(repository.snapshot()[0].selector).toBe(".primary");
    expect(repository.delete("pin-1")).toBe(true);
    expect(repository.snapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    repository.create(pin());
    expect(listener).toHaveBeenCalledTimes(3);
    repository.destroy();
    yDoc.destroy();
  });
});

describe("pin numbering", () => {
  it("agrees across insertion orders and renumbers after delete or resolve", () => {
    const pins = [
      pin({ id: "charlie", createdAt: 20 }),
      pin({ id: "bravo", createdAt: 10 }),
      pin({ id: "alpha", createdAt: 10 }),
    ];
    const clientA = new Set(pins);
    const clientB = new Set([...pins].reverse().map((value) => ({ ...value })));

    expect(Object.fromEntries(numberUnresolvedPins(clientA))).toEqual({
      alpha: 1,
      bravo: 2,
      charlie: 3,
    });
    expect(Object.fromEntries(numberUnresolvedPins(clientB))).toEqual({
      alpha: 1,
      bravo: 2,
      charlie: 3,
    });
    expect(
      Object.fromEntries(
        numberUnresolvedPins(pins.filter(({ id }) => id !== "alpha"))
      )
    ).toEqual({ bravo: 1, charlie: 2 });
    expect(
      Object.fromEntries(numberUnresolvedPins(pins, new Set(["alpha"])))
    ).toEqual({ bravo: 1, charlie: 2 });
  });
});
