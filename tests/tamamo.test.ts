import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { TAMAMO_DEFINITIONS, getAnyDefinition } from "../src/domain/encounters/definitions";
import { runScripted, validateEncounter } from "../src/domain/encounters/validation";
import { distance } from "../src/domain/geometry";
import { createRng } from "../src/domain/rng";
import { generateValidated } from "../src/domain/session";
import { RoundSimulation, simConfigFrom } from "../src/domain/simulation/RoundSimulation";
import type { GeneratedEncounter, RoundPhase, ScheduledEvent } from "../src/domain/types";
import { RoundSystem } from "../src/game/systems/RoundSystem";
import { makeEncounter } from "./helpers";

const sim = simConfigFrom(GAME_CONFIG);
const TM = GAME_CONFIG.champions.tamamo;
const gen = (id: string, seed: string, budget = 2) =>
  generateValidated(getAnyDefinition(id), { roundIndex: 4, difficultyBudget: budget, champion: "tamamo", cfg: GAME_CONFIG }, createRng(seed));

const rEvents = (enc: GeneratedEncounter) => enc.events.filter((e) => e.payload.type === "TAMAMO_R");
const mainE = (enc: GeneratedEncounter) => enc.events.find((e) => e.isMainThreat)!;

/** Eの向き (玉藻 -> Player) に垂直な2方向 */
function sideways(enc: GeneratedEncounter): { x: number; y: number }[] {
  const s = new RoundSimulation(enc, sim);
  s.advanceTo(enc.threatStartMs + 1);
  const d = { x: s.player.pos.x - s.enemyPos().x, y: s.player.pos.y - s.enemyPos().y };
  const n = Math.hypot(d.x, d.y);
  return [1, -1].map((k) => ({ x: (-d.y / n) * k, y: (d.x / n) * k }));
}

describe("玉藻", () => {
  it("E is a hidden-range charm cast by 玉藻 herself", () => {
    const enc = gen("TMM-RE", "t-1");
    const e = mainE(enc);
    expect(e.payload.type === "LINE_SHOT" && e.payload.style === "charm" && e.payload.origin.mode === "ENEMY").toBe(true);
    expect(enc.champion).toBe("tamamo");
  });

  it("uses R between 0 and 3 times per problem, within each definition's range", () => {
    const seen = new Set<number>();
    for (const def of TAMAMO_DEFINITIONS) {
      for (let i = 0; i < 12; i++) {
        const enc = gen(def.id, `r-${def.id}-${i}`, 1 + (i % 4) * 0.7);
        const n = rEvents(enc).length;
        seen.add(n);
        expect(n).toBeLessThanOrEqual(TM.rCharges);
        const range = def.parameters.rCount as [number, number] | undefined;
        if (range) {
          expect(n).toBeGreaterThanOrEqual(range[0]);
          expect(n).toBeLessThanOrEqual(range[1]);
        }
        // Rはすべて本命 (E) より前
        for (const r of rEvents(enc)) expect(r.atMs).toBeLessThan(mainE(enc).atMs);
      }
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it("R is a harmless dash capped at the max length, and never more than 3 per round", () => {
    const at = (ms: number, toDistance: number): ScheduledEvent => ({
      atMs: ms,
      type: "TAMAMO_R",
      isMainThreat: false,
      payload: { type: "TAMAMO_R", toDistance, bearingRad: 0.3 },
    });
    const enc = makeEncounter([at(1_000, 120), at(2_000, 400), at(3_000, 150), at(4_000, 300)], {
      champion: "tamamo",
      expectedAction: "WAIT",
      roundDurationMs: 5_000,
      enemySpawns: [{ x: 560, y: 300 }],
    });
    const s = new RoundSimulation(enc, sim);
    const landings: number[] = [];
    for (const t of [1_000, 2_000, 3_000, 4_000]) {
      s.advanceTo(t - 1);
      const before = { ...s.enemyPos() };
      s.advanceTo(t + 400);
      landings.push(distance(before, s.enemyPos()));
    }
    for (const l of landings.slice(0, 3)) {
      expect(l).toBeGreaterThan(20);
      expect(l).toBeLessThanOrEqual(TM.rMaxLength + 1e-6);
    }
    // 4回目は使えない
    expect(landings[3]).toBeLessThan(1);
    expect(s.tamamoRUsed).toBe(3);
    expect(s.tamamoRLeft).toBe(0);
    s.advanceTo(enc.roundDurationMs);
    expect(s.hit).toBeNull();
  });

  it("R lands at the planned distance before E, so E is cast from that distance", () => {
    for (const [id, key, lo, hi] of [
      ["TMM-RE", "inDistance", 180, 240],
      ["TMM-RBACK", "backDistance", 280, 340],
      ["TMM-RBACK-F", "inDistance", 180, 230],
    ] as const) {
      for (let i = 0; i < 6; i++) {
        const enc = gen(id, `d-${id}-${i}`);
        const s = new RoundSimulation(enc, sim);
        s.advanceTo(enc.threatStartMs + 1);
        const d = distance(s.enemyPos(), s.player.pos);
        expect(d, `${id} ${key}`).toBeGreaterThan(lo);
        expect(d, `${id} ${key}`).toBeLessThan(hi);
      }
    }
  });

  it("FLASH problems: E arrives at least 0.38s after the cast starts, and a sideways Flash dodges it", () => {
    for (const id of ["TMM-RE", "TMM-RRE", "TMM-RBACK-F"]) {
      for (let i = 0; i < 5; i++) {
        const enc = gen(id, `f-${id}-${i}`);
        const idle = runScripted(enc, sim, []);
        expect(idle.hit).not.toBeNull();
        expect(idle.hit!.atMs - enc.recognitionMs).toBeGreaterThanOrEqual(GAME_CONFIG.enemy.ai.minFlashWindowMs);
        const ok = sideways(enc).some((d) => {
          const cursor = { x: enc.playerSpawn.x + d.x * 180, y: enc.playerSpawn.y + d.y * 180 };
          return runScripted(enc, sim, [{ atMs: enc.recognitionMs + 250, kind: "FLASH", cursor }]).hit === null;
        });
        expect(ok, id).toBe(true);
      }
    }
  });

  it("MOVE problems: walking sideways after a human reaction dodges E", () => {
    for (const id of ["TMM-E-FAR", "TMM-RBACK"]) {
      for (let i = 0; i < 5; i++) {
        const enc = gen(id, `m-${id}-${i}`);
        const ok = sideways(enc).some((d) => {
          const target = { x: enc.playerSpawn.x + d.x * 200, y: enc.playerSpawn.y + d.y * 200 };
          return runScripted(enc, sim, [{ atMs: enc.recognitionMs + 350, kind: "MOVE", target }]).hit === null;
        });
        expect(ok, id).toBe(true);
      }
    }
  });

  it("all 玉藻 problems validate at every difficulty", () => {
    for (const def of TAMAMO_DEFINITIONS) {
      for (const budget of [1, 2, 3.2]) {
        const enc = gen(def.id, `v-${def.id}-${budget}`, budget);
        expect(validateEncounter(enc, GAME_CONFIG).ok, def.id).toBe(true);
      }
    }
  });

  it("a charm hit walks the player toward 玉藻 and holds the resolution for it", () => {
    const enc = gen("TMM-RE", "c-1");
    const s = runScripted(enc, sim, []);
    const d = s.hitDisplacement()!;
    expect(d.kind).toBe("charm");
    expect(d.durationMs).toBe(TM.charmMs);
    expect(distance(d.to, s.enemyPos())).toBeLessThan(distance(d.from, s.enemyPos()));
    expect(distance(d.from, d.to)).toBeLessThanOrEqual((TM.charmSpeed * TM.charmMs) / 1000 + 1e-6);

    const phases: { p: RoundPhase; at: number }[] = [];
    let now = 1_000;
    const rs = new RoundSystem("c", [enc], GAME_CONFIG, { onPhaseChange: (p) => phases.push({ p, at: now }) });
    rs.start(now);
    while (rs.phase !== "COMPLETE" && now < 60_000) {
      now += 5;
      rs.update(now);
    }
    const res = phases.find((x) => x.p === "RESOLUTION")!;
    const result = phases.find((x) => x.p === "RESULT")!;
    expect(result.at - res.at).toBeGreaterThanOrEqual(GAME_CONFIG.phases.resolutionMs + TM.charmMs - 10);
  });

  it("is deterministic regardless of the input frame step", () => {
    const enc = gen("TMM-RBACK-F", "det-1");
    const a = new RoundSimulation(enc, sim);
    const b = new RoundSimulation(enc, sim);
    for (let t = 0; t <= enc.threatStartMs; t += 16.7) a.advanceTo(t);
    for (let t = 0; t <= enc.threatStartMs; t += 7.3) b.advanceTo(t);
    a.advanceTo(enc.threatStartMs);
    b.advanceTo(enc.threatStartMs);
    expect(distance(a.enemyPos(), b.enemyPos())).toBeLessThan(0.5);
  });
});
