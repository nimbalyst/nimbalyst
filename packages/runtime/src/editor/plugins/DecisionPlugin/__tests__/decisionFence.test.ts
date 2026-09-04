// @vitest-environment node
/**
 * The fence is the record, so the property that matters is not "a decision we
 * wrote parses back" -- it is that a fence written by a *future* version, or by
 * hand, survives being loaded and saved by this one.
 */

import { describe, expect, it } from "vitest";
import { parseDecisionFence, serializeDecisionFence } from "../decisionFence";

const SEALED_FENCE = `id: dcn-7f3a2c
ask: Which navigation model for the web console?
type: singleSelect
options:
  - id: gutter
    label: Icon gutter that expands to words
    artifact: mockups/web-console-nav-gutter.mockup.html
  - id: topbar
    label: Top bar with a project switcher
    artifact: mockups/web-console-nav-topbar.mockup.html
resolved: gutter
resolvedAt: "2026-09-04T14:22:00Z"
resolvedBy: greg
votes:
  - greg: gutter
  - karl: gutter ("the words are the whole point on a narrow window")
  - sam: topbar`;

describe("decision fence", () => {
  it("preserves keys it does not model, and is idempotent across a re-serialize", () => {
    // A key from a hypothetical later version. Dropping it would silently
    // destroy data in a file whose entire purpose is being durable.
    const withFutureKeys = `${SEALED_FENCE}
supersedes: dcn-001122
weighting:
  architect: 2`;

    const first = parseDecisionFence(withFutureKeys);
    expect(first).not.toBeNull();

    const written = serializeDecisionFence(first!);
    expect(written).toContain("supersedes: dcn-001122");
    expect(written).toContain("architect: 2");

    // Re-parsing and re-writing must produce byte-identical output, or every
    // save of an untouched document emits a spurious diff.
    const second = parseDecisionFence(written);
    expect(second).not.toBeNull();
    expect(serializeDecisionFence(second!)).toBe(written);
  });

  it("preserves future per-entry fields and an unknown ask type", () => {
    const future = `id: dcn-future
ask: Pick a vector
type: sevenAxisSlider
options:
  - id: a
    label: Alpha
    futureWeight: 2`;
    const source = parseDecisionFence(future)!;
    expect(source.unrecognizedType).toBe("sevenAxisSlider");
    const written = serializeDecisionFence(source);
    expect(written).toContain("type: sevenAxisSlider");
    expect(written).toContain("futureWeight: 2");
  });

  it("accepts YAML timestamps without requiring quotes", () => {
    const source = parseDecisionFence(
      SEALED_FENCE.replace('"2026-09-04T14:22:00Z"', "2026-09-04T14:22:00Z")
    )!;
    expect(source.sealed?.resolvedAt).toBe("2026-09-04T14:22:00.000Z");
  });

  it("reads the sealed record, including a vote note", () => {
    const source = parseDecisionFence(SEALED_FENCE)!;

    expect(source.id).toBe("dcn-7f3a2c");
    expect(source.type).toBe("singleSelect");
    expect(source.entries.map((entry) => entry.id)).toEqual([
      "gutter",
      "topbar",
    ]);
    expect(source.entries[0].artifact).toBe(
      "mockups/web-console-nav-gutter.mockup.html"
    );
    expect(source.sealed).toMatchObject({
      resolved: "gutter",
      resolvedBy: "greg",
    });
    expect(source.sealed?.votes).toEqual([
      { voter: "greg", value: "gutter" },
      {
        voter: "karl",
        value: 'gutter ("the words are the whole point on a narrow window")',
      },
      { voter: "sam", value: "topbar" },
    ]);
  });

  it("accepts the forgiving hand-authored forms", () => {
    const source = parseDecisionFence(`id: dcn-aa11bb
ask: What order do we build the console in?
type: reorder
items:
  - trackers
  - documents
asked: greg, karl, sam`)!;

    // A bare string entry is its own id and label.
    expect(source.entries).toEqual([
      { id: "trackers", label: "trackers" },
      { id: "documents", label: "documents" },
    ]);
    // `asked:` as an inline comma list, not only as a YAML sequence.
    expect(source.asked).toEqual(["greg", "karl", "sam"]);
  });

  it("keeps the entry key the author used", () => {
    // A fence hand-written with `items:` must not silently become `options:`
    // on first save -- that is a diff the author did not make.
    const written = serializeDecisionFence(
      parseDecisionFence("id: dcn-1\nask: Q\ntype: reorder\nitems:\n  - a\n")!
    );
    expect(written).toContain("items:");
    expect(written).not.toContain("options:");
  });

  it("only writes visibility when it differs from the type default", () => {
    // `multiSelect` defaults to hidden-until-answered, `singleSelect` to open,
    // so the common fence stays short and the key means "the author overrode".
    const hidden = serializeDecisionFence(
      parseDecisionFence("id: dcn-1\nask: Q\ntype: multiSelect\n")!
    );
    expect(hidden).not.toContain("visibility:");

    const overridden = serializeDecisionFence(
      parseDecisionFence(
        "id: dcn-1\nask: Q\ntype: multiSelect\nvisibility: open\n"
      )!
    );
    expect(overridden).toContain("visibility: open");
  });

  it("renders a fence it cannot fully understand rather than discarding it", () => {
    // An unrecognized ask type still parses. A block that renders as a broken
    // decision is recoverable; one that silently becomes a code block takes the
    // sealed record with it.
    const source = parseDecisionFence(
      "id: dcn-1\nask: Q\ntype: sevenAxisSlider\n"
    );
    expect(source).not.toBeNull();
    expect(source!.ask).toBe("Q");

    // Only a body that is not a mapping at all is a non-decision.
    expect(parseDecisionFence("- just\n- a list\n")).toBeNull();
    expect(parseDecisionFence("%%% not yaml : : :\n")).toBeNull();
  });
});
