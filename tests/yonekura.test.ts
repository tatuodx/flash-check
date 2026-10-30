import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import {
  YONEKURA_DEFINITIONS,
  getAnyDefinition,
} from "../src/domain/encounters/definitions";
import { flashSamples, runScripted } from "../src/domain/encounters/validation";
import { distance } from "../src/domain/geometry";
import { createRng } from "../src/domain/rng";
import { evaluateRound } from "../src/domain/scoring";
import { buildChampionDeck, buildEncounterSequence, generateValidated } from "../src/domain/session";
import { RoundSimulation, simConfigFrom, type DashHazard } from "../src/domain/simulation/RoundSimulation";

const sim = simConfigFrom(GAME_CONFIG);
const Y = GAME_CONFIG.champions.yonekura;
const gen = (id: string, seed: string, budget = 2) =>
  generateValidated(getAnyDefinition(id), { roundIndex: 5, difficultyBudget: budget, champion: "yonekura", cfg: GAME_CONFIG }, createRng(seed));

describe("champion assignment", () => {
  it("picks 標準 / 米倉 / アリ at about the configured chances, and 米倉 / アリ only present their own problems", () => {
    const count = { default: 0, yonekura: 0, tamamo: 0 };
    let n = 0;
    for (let s = 0; s < 100; s++) {
      const deck = buildChampionDeck(`seed-${s}`, GAME_CONFIG);
      expect(deck).toEqual(buildChampionDeck(`seed-${s}`, GAME_CONFIG));
      for (const { def, champion } of deck) {
        count[champion]++;
        n++;
        // 米倉/アリは標準の技 (ENC-*) を撃たない。ガンク (クリッツブランク / アッシュリー) だけはレーンの相手に関係なく出る
        if (champion === "yonekura") expect(def.id.startsWith("YNK-") || def.gankers !== undefined, def.id).toBe(true);
        if (champion === "tamamo") expect(def.id.startsWith("TMM-") || def.gankers !== undefined, def.id).toBe(true);
        if (champion === "default") expect(def.id.startsWith("YNK-") || def.id.startsWith("TMM-")).toBe(false);
      }
    }
    const { yonekura, tamamo } = GAME_CONFIG.champions.chances;
    const expected = { default: 1 - yonekura - tamamo, yonekura, tamamo };
    for (const k of ["default", "yonekura", "tamamo"] as const) {
      expect(Math.abs(count[k] / n - expected[k]), k).toBeLessThan(0.07);
    }
  });

  it("sessions mix both champions and stay reproducible", () => {
    const seq = buildEncounterSequence("mix-1");
    expect(seq).toEqual(buildEncounterSequence("mix-1"));
    const all = Array.from({ length: 10 }, (_, i) => buildEncounterSequence(`mix-${i}`)).flat();
    expect(all.some((e) => e.champion === "yonekura")).toBe(true);
    expect(all.some((e) => e.champion === "default")).toBe(true);
    expect(all.some((e) => e.champion === "tamamo")).toBe(true);
    for (const e of all) if (e.definitionId.startsWith("YNK-")) expect(e.champion).toBe("yonekura");
    for (const e of all) if (e.definitionId.startsWith("TMM-")) expect(e.champion).toBe("tamamo");
  });
});

describe("米倉 skills", () => {
  it("E: the spirit steps forward, then snaps back to the body; E alone never hits", () => {
    const enc = gen("YNK-E", "e-1", 1);
    const ev = enc.events.find((e) => e.payload.type === "YONE_E")!;
    if (ev.payload.type !== "YONE_E") throw new Error();
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(ev.atMs - 1);
    const body = { ...s.enemyPos() };
    s.advanceTo(ev.atMs + Y.eOutMs + 10);
    expect(distance(s.enemyPos(), body)).toBeGreaterThan(50);
    expect(distance(s.enemyPos(), s.player.pos)).toBeGreaterThanOrEqual(Y.eKeepFromPlayer - 1);
    s.advanceTo(ev.payload.returnAtMs + ev.payload.returnMs + 5);
    expect(distance(s.enemyPos(), body)).toBeLessThan(1);
    s.advanceTo(enc.roundDurationMs);
    expect(s.hit).toBeNull();
    expect(evaluateRound(enc, s.outcome(), GAME_CONFIG.scoring).label).toBe("GOOD HOLD");
  });

  it("Q3 dashes a fixed distance from where it is cast", () => {
    const enc = gen("YNK-Q3", "q3-1", 1);
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(enc.recognitionMs + 1);
    const dash = s.hazards.find((h): h is DashHazard => h.kind === "DASH")!;
    expect(dash.total).toBeCloseTo(Y.q3Length, 0);
    // Q1/Q2の演出が先に入っている (出題ではないので本命フラグなし)
    const qs = enc.events.filter((e) => e.payload.type === "YONE_Q_VISUAL");
    expect(qs).toHaveLength(2);
    expect(qs.every((e) => !e.isMainThreat && e.atMs < enc.recognitionMs)).toBe(true);
  });

  it("R alone: 米倉 stays at the end point", () => {
    const enc = gen("YNK-R", "r-1", 2);
    const s = new RoundSimulation(enc, sim);
    s.tryFlash(enc.recognitionMs + 250, { x: s.player.pos.x, y: s.player.pos.y - 300 });
    s.advanceTo(enc.roundDurationMs);
    const dash = s.hazards.find((h): h is DashHazard => h.kind === "DASH")!;
    // 固定距離 (画面端に掛かる場合はそこで止まる)
    expect(dash.total).toBeLessThanOrEqual(Y.rLength + 0.01);
    expect(dash.total).toBeGreaterThan(Y.rLength * 0.6);
    expect(distance(s.enemyPos(), dash.to)).toBeLessThan(1);
  });

  it("E→R: after the slash 米倉 returns to the body", () => {
    const enc = gen("YNK-ER", "er-1", 3.2);
    const e = enc.events.find((x) => x.payload.type === "YONE_E")!;
    if (e.payload.type !== "YONE_E") throw new Error();
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(e.atMs - 1);
    const body = { ...s.enemyPos() };
    s.tryFlash(enc.recognitionMs + 250, { x: s.player.pos.x, y: s.player.pos.y - 300 });
    s.advanceTo(Math.min(enc.roundDurationMs, e.payload.returnAtMs + e.payload.returnMs + 5));
    expect(distance(s.enemyPos(), body)).toBeLessThan(1);
  });

  for (const def of YONEKURA_DEFINITIONS.filter((d) => d.expectedAction === "FLASH")) {
    it(`${def.id}: idle is hit, a well-aimed Flash survives with full decision`, () => {
      for (let i = 0; i < 5; i++) {
        const enc = gen(def.id, `${def.id}-${i}`, def.difficulty === 1 ? 1.1 : def.difficulty === 2 ? 2 : 2.8);
        expect(runScripted(enc, sim, []).hit).not.toBeNull();
        const best = flashSamples(enc, GAME_CONFIG)
          .map((a) => evaluateRound(enc, runScripted(enc, sim, [a]).outcome(), GAME_CONFIG.scoring))
          .reduce((m, r) => (r.totalScore > m.totalScore ? r : m));
        expect(best.survived).toBe(true);
        expect(best.decisionScore).toBe(400);
      }
    });
  }

  it("Q3 has no visible range: recognition needs 米倉 himself to be in vision", () => {
    const enc = gen("YNK-Q3", "q3-vis", 1);
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(enc.roundDurationMs);
    expect(s.threatVisibleMs).toBe(enc.recognitionMs); // レーン上の米倉が見えているので詠唱開始時
  });
});
