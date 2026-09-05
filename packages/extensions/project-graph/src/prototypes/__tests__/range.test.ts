// @vitest-environment node
import { expect, it } from "vitest";
import { prototypeRange, precedingRange } from "../range";

it("keeps calendar windows adjacent without dropping evenings, including across DST dates", () => {
  for (const date of [
    new Date(2026, 8, 4, 14),
    new Date(2026, 2, 10, 14),
    new Date(2026, 10, 3, 14),
  ]) {
    const now = date.getTime();
    for (const days of [7, 30, 90]) {
      const current = prototypeRange(now, days, 0);
      const previous = prototypeRange(now, days, days);
      const earlier = prototypeRange(now, days, days * 2);
      expect(current.endMs).toBe(now);
      expect(previous.endMs + 1).toBe(current.startMs);
      expect(earlier.endMs + 1).toBe(previous.startMs);
      expect(new Date(previous.endMs).getHours()).toBe(23);
      const comparison = precedingRange(current);
      expect(comparison.endMs + 1).toBe(current.startMs);
      expect(comparison.endMs - comparison.startMs).toBe(
        current.endMs - current.startMs
      );
    }
  }
});
