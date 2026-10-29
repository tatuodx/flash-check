import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { getDefinition } from "../src/domain/encounters/definitions";
import { distance, normalize, sub } from "../src/domain/geometry";
import { createRng } from "../src/domain/rng";
import { generateValidated } from "../src/domain/session";
import { RoundSimulation, simConfigFrom, type LineHazard } from "../src/domain/simulation/RoundSimulation";
import { circle, fastLine, makeEncounter } from "./helpers";

const sim = simConfigFrom(GAME_CONFIG);
const [MIN, MAX] = GAME_CONFIG.enemy.ai.keepRange;
const lane = GAME_CONFIG.world.lane;

describe("enemy champion AI", () => {
  it("wanders but keeps within the distance range in front of the player, inside the lane", () => {
    const enc = makeEncounter([], { roundDurationMs: 20_000 });
    const s = new RoundSimulation(enc, sim);
    const positions = new Set<string>();
    for (let t = 2_000; t <= 20_000; t += 100) {
      s.advanceTo(t);
      const e = s.enemyPos();
      const d = distance(e, s.player.pos);
      expect(d).toBeGreaterThanOrEqual(MIN - 40);
      expect(d).toBeLessThanOrEqual(MAX + 40);
      expect(e.x).toBeGreaterThan(s.player.pos.x);
      expect(e.y).toBeGreaterThanOrEqual(lane.top);
      expect(e.y).toBeLessThanOrEqual(lane.bottom);
      positions.add(`${Math.round(e.x / 20)},${Math.round(e.y / 20)}`);
    }
    expect(positions.size).toBeGreaterThan(5); // 実際に動き回っている
  });

  it("follows when the player walks away, and backs off when the player approaches", () => {
    const enc = makeEncounter([], { roundDurationMs: 20_000 });
    const away = new RoundSimulation(enc, sim);
    away.move(1_000, { x: 40, y: 300 });
    away.advanceTo(6_000);
    const d1 = distance(away.enemyPos(), away.player.pos);
    expect(d1).toBeLessThanOrEqual(MAX + 40);

    const toward = new RoundSimulation(enc, sim);
    toward.move(1_000, { x: 560, y: 300 });
    toward.advanceTo(6_000);
    expect(distance(toward.enemyPos(), toward.player.pos)).toBeGreaterThanOrEqual(MIN - 40);
  });

  it("is deterministic for the same seed and inputs", () => {
    const enc = makeEncounter([], { roundDurationMs: 10_000 });
    const run = () => {
      const s = new RoundSimulation(enc, sim);
      s.move(1_500, { x: 200, y: 250 });
      s.advanceTo(9_000);
      return s.enemyPos();
    };
    expect(run()).toEqual(run());
  });

  it("stands still from just before the main threat so the cast origin does not move", () => {
    const enc = makeEncounter([fastLine(5_000)], { threatStartMs: 5_000, recognitionMs: 5_000, roundDurationMs: 8_000 });
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(5_000 - GAME_CONFIG.enemy.ai.holdBeforeThreatMs);
    const held = { ...s.enemyPos() };
    s.advanceTo(5_000);
    expect(s.enemyPos()).toEqual(held);
    const line = s.hazards[0] as LineHazard;
    expect(line.origin).toEqual(held);
    expect(s.enemyMoving).toBe(false);
  });

  it("holds during a fake cast", () => {
    const enc = makeEncounter(
      [{ atMs: 3_000, type: "FAKE_CAST", isMainThreat: false, payload: { type: "FAKE_CAST", durationMs: 600 } }],
      { expectedAction: "WAIT", roundDurationMs: 8_000 },
    );
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(3_000 - GAME_CONFIG.enemy.ai.holdBeforeFakeMs);
    const held = { ...s.enemyPos() };
    s.advanceTo(3_550);
    expect(s.enemyPos()).toEqual(held);
  });

  it("ENC-017 keeps its crossing angle wherever the enemy stands", () => {
    const def = getDefinition("ENC-017");
    for (let i = 0; i < 6; i++) {
      const enc = generateValidated(def, { roundIndex: 8, difficultyBudget: 2.8, cfg: GAME_CONFIG }, createRng(`cross-${i}`));
      const s = new RoundSimulation(enc, sim);
      s.move(1_000, { x: 200 + i * 40, y: 220 + i * 15 }); // Playerの位置 = 敵の位置を毎回変える
      s.advanceTo(enc.threatStartMs + 1);
      const [a, b] = s.hazards as LineHazard[];
      const cos = Math.abs(a.dir.x * b.dir.x + a.dir.y * b.dir.y);
      const deg = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
      expect(deg).toBeGreaterThan(50);
      expect(normalize(sub(s.anchor!, a.origin)).x).toBeCloseTo(a.dir.x, 5);
    }
  });
});

describe("circle helper sanity", () => {
  it("still hits an idle player with a moving enemy around", () => {
    const enc = makeEncounter([circle(3_000, 90, 1_000)], { expectedAction: "MOVE", roundDurationMs: 6_000 });
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(6_000);
    expect(s.hit).not.toBeNull();
  });
});

describe("telegraph window at the closest enemy distance", () => {
  const cfg = GAME_CONFIG;
  const dMin = cfg.enemy.ai.keepRange[0] - 30;
  const pr = cfg.player.radius;
  for (const id of ["ENC-001", "ENC-002", "ENC-015"]) {
    it(`${id}: the enemy line leaves enough time even from ${dMin} away`, () => {
      const def = getDefinition(id);
      for (let i = 0; i < 10; i++) {
        const enc = generateValidated(def, { roundIndex: 4, difficultyBudget: 1.7, cfg }, createRng(`win-${id}-${i}`));
        const ev = enc.events.find((e) => e.isMainThreat)!;
        if (ev.payload.type !== "LINE_SHOT") throw new Error("expected line");
        const p = ev.payload;
        const windowMs = p.launchAtMs - ev.atMs + ((dMin - p.width / 2 - pr) / p.speed) * 1000;
        const need =
          def.expectedAction === "MOVE"
            ? cfg.validation.moveSolvableReactionMs + ((p.width / 2 + pr) / cfg.player.moveSpeed) * 1000
            : cfg.enemy.ai.minFlashWindowMs;
        expect(windowMs).toBeGreaterThanOrEqual(need - 1);
      }
    });
  }
});
