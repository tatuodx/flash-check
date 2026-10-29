import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { capsuleClearance, circleClearance } from "../src/domain/geometry";
import { RoundSimulation, simConfigFrom } from "../src/domain/simulation/RoundSimulation";
import { runScripted } from "../src/domain/encounters/validation";
import { circle, fastLine, makeEncounter } from "./helpers";

const sim = simConfigFrom(GAME_CONFIG);

describe("safe / danger determination", () => {
  it("capsule clearance is negative only when overlapping", () => {
    expect(capsuleClearance({ x: 0, y: 30 }, 18, { x: -100, y: 0 }, { x: 100, y: 0 }, 10)).toBeCloseTo(2);
    expect(capsuleClearance({ x: 0, y: 20 }, 18, { x: -100, y: 0 }, { x: 100, y: 0 }, 10)).toBeLessThan(0);
  });

  it("circle clearance requires the whole player hitbox outside", () => {
    expect(circleClearance({ x: 110, y: 0 }, 18, { x: 0, y: 0 }, 90)).toBeCloseTo(2);
    expect(circleClearance({ x: 100, y: 0 }, 18, { x: 0, y: 0 }, 90)).toBeLessThan(0);
  });
});

describe("RoundSimulation", () => {
  const enc = makeEncounter([fastLine()]);

  it("hits an idle player", () => {
    const s = runScripted(enc, sim, []);
    expect(s.hit).not.toBeNull();
  });

  it("perpendicular Flash dodges the line", () => {
    const s = runScripted(enc, sim, [{ atMs: 2_200, kind: "FLASH", cursor: { x: 300, y: 100 } }]);
    expect(s.hit).toBeNull();
    expect(s.mainThreatsResolved()).toBe(true);
  });

  it("Flash along the projectile direction stays in the corridor and is hit", () => {
    const s = runScripted(enc, sim, [{ atMs: 2_200, kind: "FLASH", cursor: { x: 0, y: 300 } }]);
    expect(s.hit).not.toBeNull();
  });

  it("Flash after the collision is too late", () => {
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(2_800);
    expect(s.hit).not.toBeNull();
    expect(s.tryFlash(2_800, { x: 300, y: 100 })).toBeNull();
  });

  it("only one Flash per round", () => {
    const s = new RoundSimulation(makeEncounter([]), sim);
    expect(s.tryFlash(100, { x: 400, y: 300 })).not.toBeNull();
    expect(s.tryFlash(200, { x: 200, y: 300 })).toBeNull();
  });

  it("right click moves towards the target at moveSpeed", () => {
    const s = new RoundSimulation(makeEncounter([]), sim);
    s.move(0, { x: 600, y: 300 });
    s.advanceTo(1_000);
    expect(s.player.pos.x).toBeCloseTo(300 + GAME_CONFIG.player.moveSpeed, 0);
  });

  it("walking out of a delayed circle survives, flashing radially too", () => {
    const enc2 = makeEncounter([circle(2_000, 90, 1_100)], { expectedAction: "MOVE" });
    expect(runScripted(enc2, sim, []).hit).not.toBeNull();
    expect(runScripted(enc2, sim, [{ atMs: 2_300, kind: "MOVE", target: { x: 300, y: 0 } }]).hit).toBeNull();
    expect(runScripted(enc2, sim, [{ atMs: 2_300, kind: "FLASH", cursor: { x: 300, y: 0 } }]).hit).toBeNull();
  });

  it("is frame-rate independent (same result regardless of advance granularity)", () => {
    const a = new RoundSimulation(enc, sim);
    const b = new RoundSimulation(enc, sim);
    for (let t = 0; t <= 5_000; t += 7) a.advanceTo(t);
    for (let t = 0; t <= 5_000; t += 33) b.advanceTo(t);
    a.advanceTo(5_000);
    b.advanceTo(5_000);
    expect(a.hit?.atMs).toBeCloseTo(b.hit?.atMs ?? -1, -1);
  });
});

describe("vision (陰・ブッシュ)", () => {
  it("shade is never visible, lane is visible", async () => {
    const { isVisible, BRUSHES, brushAt } = await import("../src/domain/fieldLayout");
    const lane = { x: 300, y: 300 };
    expect(isVisible({ x: 300, y: 300 }, lane)).toBe(true);
    expect(isVisible({ x: 300, y: 40 }, lane)).toBe(false);
    expect(isVisible({ x: 300, y: 40 }, { x: 300, y: 40 })).toBe(false);
    // ブッシュ内は外から見えないが、同じブッシュに入れば見える
    const b = BRUSHES[0];
    const inside = { x: b.x, y: b.y };
    expect(brushAt(inside)?.id).toBe(b.id);
    expect(isVisible(inside, lane)).toBe(false);
    expect(isVisible(inside, { x: b.x + 10, y: b.y })).toBe(true);
  });

  it("recognition starts when the threat enters vision", () => {
    // Playerが陰の中にいると、足元の円 (縁まで陰の中) は見えない -> 認識時刻が付かない
    const enc = makeEncounter([circle(2_000, 90, 1_100)], { expectedAction: "MOVE", playerSpawn: { x: 300, y: 20 } });
    const hidden = runScripted(enc, sim, []);
    expect(hidden.threatVisibleMs).toBeNull();
    // レーン上なら予定時刻ちょうどに見える
    const seen = runScripted(makeEncounter([circle(2_000, 90, 1_100)], { expectedAction: "MOVE" }), sim, []);
    expect(seen.threatVisibleMs).toBe(2_000);
  });

  it("render-reported time cannot precede vision", () => {
    const enc = makeEncounter([circle(2_000, 90, 1_100)], { expectedAction: "MOVE", playerSpawn: { x: 300, y: 20 } });
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(2_100);
    s.markRecognitionVisible(2_100);
    expect(s.recognitionVisibleMs).toBeNull();
  });
});
