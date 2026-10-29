import { describe, expect, it } from "vitest";
import { createRng } from "../src/domain/rng";

describe("SeededRandom", () => {
  it("is deterministic for the same seed", () => {
    const a = createRng("abc");
    const b = createRng("abc");
    const xs = Array.from({ length: 50 }, () => a.next());
    const ys = Array.from({ length: 50 }, () => b.next());
    expect(xs).toEqual(ys);
  });

  it("differs between seeds", () => {
    expect(createRng("a").next()).not.toEqual(createRng("b").next());
  });

  it("range/int/pick stay within bounds", () => {
    const r = createRng("bounds");
    for (let i = 0; i < 1000; i++) {
      const v = r.range(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
      const n = r.int(1, 3);
      expect([1, 2, 3]).toContain(n);
      expect(["x", "y"]).toContain(r.pick(["x", "y"]));
    }
  });
});
