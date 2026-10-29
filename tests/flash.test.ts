import { describe, expect, it } from "vitest";
import { computeFlash } from "../src/domain/flash";

const bounds = { minX: 18, minY: 18, maxX: 982, maxY: 582 };

describe("computeFlash", () => {
  it("clamps to max distance in cursor direction", () => {
    const r = computeFlash({ x: 300, y: 300 }, { x: 900, y: 300 }, 180, bounds, 0);
    expect(r.after.x).toBeCloseTo(480);
    expect(r.after.y).toBeCloseTo(300);
    expect(r.distance).toBeCloseTo(180);
    expect(r.direction.x).toBeCloseTo(1);
  });

  it("uses cursor distance when shorter than max", () => {
    const r = computeFlash({ x: 300, y: 300 }, { x: 300, y: 200 }, 180, bounds, 0);
    expect(r.after).toEqual({ x: 300, y: 200 });
    expect(r.distance).toBeCloseTo(100);
  });

  it("never exceeds max distance diagonally", () => {
    const r = computeFlash({ x: 500, y: 300 }, { x: 900, y: 0 }, 180, bounds, 0);
    expect(r.distance).toBeLessThanOrEqual(180 + 1e-9);
  });

  it("clamps to the play area", () => {
    const r = computeFlash({ x: 40, y: 300 }, { x: -500, y: 300 }, 180, bounds, 0);
    expect(r.after.x).toBe(18);
  });

  it("records before / cursor / timestamp", () => {
    const r = computeFlash({ x: 1, y: 2 }, { x: 3, y: 4 }, 180, bounds, 1234);
    expect(r.timestampMs).toBe(1234);
    expect(r.before).toEqual({ x: 1, y: 2 });
    expect(r.cursor).toEqual({ x: 3, y: 4 });
  });
});
