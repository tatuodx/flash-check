import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { getDefinition } from "../src/domain/encounters/definitions";
import { buildMinions } from "../src/domain/encounters/generators";
import { createRng } from "../src/domain/rng";
import { evaluateRound } from "../src/domain/scoring";
import { generateValidated } from "../src/domain/session";
import { RoundSimulation, simConfigFrom } from "../src/domain/simulation/RoundSimulation";
import type { MinionSpec } from "../src/domain/types";
import { makeEncounter } from "./helpers";

const sim = simConfigFrom(GAME_CONFIG);
const A = GAME_CONFIG.attack;

function spec(id: number, team: "ally" | "enemy", over: Partial<MinionSpec> = {}): MinionSpec {
  return { id, team, kind: "melee", pos: { x: team === "ally" ? 450 : 550, y: 300 }, maxHp: 100, startHp: 100, drainPerSec: 20, ...over };
}

describe("buildMinions", () => {
  it("creates 2 melee + 1 cannon per team, deterministic from the seed", () => {
    const a = buildMinions(createRng("m"), GAME_CONFIG, 10_000);
    expect(a).toEqual(buildMinions(createRng("m"), GAME_CONFIG, 10_000));
    for (const team of ["ally", "enemy"] as const) {
      const mine = a.filter((m) => m.team === team);
      expect(mine.map((m) => m.kind).sort()).toEqual(["cannon", "melee", "melee"]);
    }
    for (const m of a) {
      expect(m.startHp).toBeGreaterThanOrEqual(m.maxHp * GAME_CONFIG.minions.startHpRatio[0] - 1);
      expect(m.startHp).toBeLessThanOrEqual(m.maxHp);
      expect(m.drainPerSec).toBeGreaterThan(0);
    }
  });

  it("HP varies between seeds", () => {
    const hp = (seed: string) => buildMinions(createRng(seed), GAME_CONFIG, 10_000).map((m) => m.startHp);
    expect(hp("x")).not.toEqual(hp("y"));
  });

  it("ENC-015 lines up an enemy minion's death with the main threat", () => {
    const def = getDefinition("ENC-015");
    for (let s = 0; s < 5; s++) {
      const enc = generateValidated(def, { roundIndex: 3, difficultyBudget: 1.5, cfg: GAME_CONFIG }, createRng(`lure-${s}`));
      // 何もしなければ倒れる予定時刻 (相対)。本命Telegraphの300〜900ms後に1体いること
      const rel = enc.minions
        .filter((m) => m.team === "enemy" && m.kind === "melee")
        .map((m) => (m.startHp / m.drainPerSec) * 1000 - enc.threatStartMs);
      expect(rel.some((d) => d >= 299 && d <= 901)).toBe(true);
    }
  });
});

describe("minion combat", () => {
  it("HP drains over time and the minion dies without counting as CS", () => {
    const enc = makeEncounter([], { minions: [spec(1, "ally"), spec(2, "enemy")] });
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(2_500);
    expect(s.minions[1].hp).toBeCloseTo(50, 0);
    s.advanceTo(5_000);
    expect(s.minions[1].alive).toBe(false);
    expect(s.minions[1].diedAtMs).toBeCloseTo(5_000, -1);
    expect(s.outcome().csCount).toBe(0);
  });

  it("draining stops once the opposing side is wiped out", () => {
    const enc = makeEncounter([], {
      minions: [spec(1, "ally", { drainPerSec: 50 }), spec(2, "enemy", { drainPerSec: 10 })],
    });
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(4_000);
    expect(s.minions[0].alive).toBe(false);
    expect(s.minions[1].hp).toBeCloseTo(80, 0); // 2秒で味方が全滅 -> 以降減らない
  });

  it("last hit with a left-click attack scores CS; range and cooldown are enforced", () => {
    const enemy = spec(2, "enemy", { pos: { x: 300 + A.range, y: 300 }, startHp: 55, drainPerSec: 1 });
    const enc = makeEncounter([], { minions: [spec(1, "ally"), enemy] });
    const s = new RoundSimulation(enc, sim);
    // 射程は「Player中心 -> ミニオン外周」で判定 (ここでは外周まで range - radius)
    expect(s.attack(100, enemy.pos)?.result).toBe("hit");
    expect(s.attack(300, enemy.pos)?.result).toBe("cooldown");
    expect(s.attack(1_000, { x: 0, y: 0 })?.result).toBe("no_target");
    expect(s.attack(1_000, enemy.pos)?.result).toBe("kill");
    const o = s.outcome();
    expect(o.csCount).toBe(1);
    const r = evaluateRound({ ...enc, expectedAction: "WAIT" }, o, GAME_CONFIG.scoring);
    expect(r.csScore).toBe(GAME_CONFIG.scoring.cs.melee);
    expect(r.totalScore).toBeLessThanOrEqual(1_000);
  });

  it("out of range and ally minions cannot be attacked", () => {
    const far = spec(2, "enemy", { pos: { x: 300 + A.range + 40, y: 300 } });
    const ally = spec(1, "ally", { pos: { x: 330, y: 300 } });
    const s = new RoundSimulation(makeEncounter([], { minions: [ally, far] }), sim);
    expect(s.attack(100, far.pos)?.result).toBe("out_of_range");
    expect(s.attack(100, ally.pos)?.result).toBe("no_target");
  });

  it("cannon last hit is worth the cannon bonus", () => {
    const cannon = spec(2, "enemy", { kind: "cannon", maxHp: 180, startHp: 20, drainPerSec: 1, pos: { x: 400, y: 300 } });
    const s = new RoundSimulation(makeEncounter([], { minions: [spec(1, "ally"), cannon] }), sim);
    expect(s.attack(100, cannon.pos)?.result).toBe("kill");
    const r = evaluateRound(s.encounter, s.outcome(), GAME_CONFIG.scoring);
    expect(r.csCannon).toBe(1);
    expect(r.csScore).toBe(GAME_CONFIG.scoring.cs.cannon);
  });

  it("right-click: attacks an enemy minion in range (and stops), otherwise moves to the point", () => {
    const near = spec(2, "enemy", { pos: { x: 420, y: 300 }, startHp: 90, drainPerSec: 1 });
    const far = spec(3, "enemy", { pos: { x: 300 + A.range + 60, y: 300 } });
    const s = new RoundSimulation(makeEncounter([], { minions: [spec(1, "ally"), near, far] }), sim);
    s.move(0, { x: 200, y: 300 });
    s.advanceTo(50);
    // 範囲内のミニオン -> 攻撃して立ち止まる (移動扱いにはならない)
    expect(s.rightClick(100, near.pos)?.result).toBe("hit");
    expect(s.player.target).toBeNull();
    const moves = s.moves.length;
    // 範囲外のミニオン -> その地点へ移動
    expect(s.rightClick(1_000, far.pos)).toBeNull();
    expect(s.player.target).toEqual(far.pos);
    // 地面 -> 移動
    expect(s.rightClick(1_100, { x: 250, y: 200 })).toBeNull();
    expect(s.player.target).toEqual({ x: 250, y: 200 });
    expect(s.moves.length).toBe(moves + 2);
  });

  it("right-click on an in-range minion during cooldown does not move the player", () => {
    const near = spec(2, "enemy", { pos: { x: 420, y: 300 }, startHp: 90, drainPerSec: 1 });
    const s = new RoundSimulation(makeEncounter([], { minions: [spec(1, "ally"), near] }), sim);
    s.rightClick(100, near.pos);
    expect(s.rightClick(200, near.pos)?.result).toBe("cooldown");
    expect(s.moves).toHaveLength(0);
  });
});
