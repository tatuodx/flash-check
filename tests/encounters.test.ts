import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { buildDeck, deckViolations } from "../src/domain/encounters/deck";
import { ENCOUNTER_DEFINITIONS } from "../src/domain/encounters/definitions";
import { flashSamples, moveSamples, runScripted, validateEncounter, type ScriptedAction } from "../src/domain/encounters/validation";
import { add, fromAngle, scale } from "../src/domain/geometry";
import { createRng } from "../src/domain/rng";
import { evaluateRound } from "../src/domain/scoring";
import { buildChampionDeck, buildEncounterSequence, generateValidated } from "../src/domain/session";
import { simConfigFrom } from "../src/domain/simulation/RoundSimulation";

const sim = simConfigFrom(GAME_CONFIG);
const SEEDS = 8;

function budgetsFor(tier: number): number[] {
  return GAME_CONFIG.difficultyBudget.filter((_, i) => GAME_CONFIG.roundTiers[i].includes(tier));
}

describe.each(ENCOUNTER_DEFINITIONS.map((d) => [d.id, d] as const))("%s", (_id, def) => {
  const budgets = budgetsFor(def.difficulty);

  it("generates valid, reproducible encounters within 5-20s", () => {
    for (let s = 0; s < SEEDS; s++) {
      const budget = budgets[s % budgets.length];
      const ctx = { roundIndex: s % 10, difficultyBudget: budget, cfg: GAME_CONFIG };
      const a = generateValidated(def, ctx, createRng(`t-${def.id}-${s}`));
      const b = generateValidated(def, ctx, createRng(`t-${def.id}-${s}`));
      expect(a).toEqual(b);
      expect(validateEncounter(a, GAME_CONFIG).ok).toBe(true);
      expect(a.roundDurationMs).toBeGreaterThanOrEqual(5_000);
      expect(a.roundDurationMs).toBeLessThanOrEqual(20_000);
      expect(a.recognitionMs).toBeLessThan(a.roundDurationMs);
    }
  });

  it("expected action scores well; wrong action does not", () => {
    for (let s = 0; s < SEEDS; s++) {
      const ctx = { roundIndex: 0, difficultyBudget: budgets[0], cfg: GAME_CONFIG };
      const enc = generateValidated(def, ctx, createRng(`s-${def.id}-${s}`));
      const idle = evaluateRound(enc, runScripted(enc, sim, []).outcome(), GAME_CONFIG.scoring);

      if (def.expectedAction === "WAIT") {
        expect(idle.label).toBe("GOOD HOLD");
        expect(idle.totalScore).toBe(1000);
        // 予兆に反応してFlash -> WASTED FLASH
        const fake = enc.events.find((e) => !e.isMainThreat && e.atMs >= enc.threatStartMs)!;
        const wasted = runScripted(enc, sim, [{ atMs: fake.atMs + 150, kind: "FLASH", cursor: { x: 0, y: 0 } }]);
        const r = evaluateRound(enc, wasted.outcome(), GAME_CONFIG.scoring);
        expect(r.label).toBe("WASTED FLASH");
        expect(r.wastedFlash).toBe(true);
        continue;
      }

      expect(idle.survived).toBe(false);
      expect(idle.totalScore).toBe(0);

      const candidates: ScriptedAction[][] = (def.expectedAction === "FLASH" ? flashSamples(enc, GAME_CONFIG) : moveSamples(enc, GAME_CONFIG, 250)).map((a) => [a]);
      if (enc.followUpMs !== undefined) {
        // 本命をFlashで避けた後に追撃が来る問題: Flash → 追撃を見てから歩く
        for (const [f] of candidates.slice(0, 36)) {
          if (f.kind !== "FLASH") continue;
          for (let i = 0; i < 12; i++) {
            const target = add(f.cursor, scale(fromAngle((i / 12) * Math.PI * 2), 400));
            candidates.push([f, { atMs: enc.followUpMs + 350, kind: "MOVE", target }]);
          }
        }
      }
      const results = candidates.map((a) => evaluateRound(enc, runScripted(enc, sim, a).outcome(), GAME_CONFIG.scoring));
      const best = results.reduce((m, r) => (r.totalScore > m.totalScore ? r : m));
      expect(best.survived).toBe(true);
      expect(best.playerAction).toBe(def.expectedAction);
      expect(best.decisionScore).toBe(400);
      expect(best.totalScore).toBeGreaterThan(700);
      // Flash方向によって成功/失敗が変化する
      if (def.expectedAction === "FLASH") expect(results.some((r) => !r.survived)).toBe(true);
    }
  });
});

describe("deck", () => {
  it("satisfies category guarantees for many seeds", () => {
    for (let s = 0; s < 300; s++) {
      const deck = buildDeck(ENCOUNTER_DEFINITIONS, createRng(`deck-${s}`), GAME_CONFIG);
      expect(deck).toHaveLength(10);
      expect(deckViolations(deck, GAME_CONFIG)).toEqual([]);
    }
  });

  it("is reproducible from the seed", () => {
    const ids = (seed: string) => buildDeck(ENCOUNTER_DEFINITIONS, createRng(seed), GAME_CONFIG).map((d) => d.id);
    expect(ids("X")).toEqual(ids("X"));
    const variety = new Set(Array.from({ length: 20 }, (_, i) => ids(`v${i}`).join(",")));
    expect(variety.size).toBeGreaterThan(10);
  });
});

describe("session sequence", () => {
  it("same seed -> identical encounter sequence (timeline, coordinates, angles, speeds)", () => {
    const a = buildEncounterSequence("DAILY-2026-10-21");
    const b = buildEncounterSequence("DAILY-2026-10-21");
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
  });

  it("different seeds -> different sequences", () => {
    expect(buildEncounterSequence("A")).not.toEqual(buildEncounterSequence("B"));
  });

  it("each game has 2-4 gank rounds, and every count appears", () => {
    const [lo, hi] = GAME_CONFIG.deck.gankRounds;
    const seen = new Set<number>();
    for (let s = 0; s < 60; s++) {
      const n = buildChampionDeck(`gank-${s}`, GAME_CONFIG).filter((r) => r.def.gankers !== undefined).length;
      expect(n).toBeGreaterThanOrEqual(lo);
      expect(n).toBeLessThanOrEqual(hi);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([2, 3, 4]);
  });

  it("does not repeat side-gank edge on consecutive side-gank rounds", () => {
    for (let s = 0; s < 60; s++) {
      const seq = buildEncounterSequence(`edge-${s}`);
      for (let i = 1; i < seq.length; i++) {
        // 上下の陰から来るクリッツブランクのガンク同士 (アッシュリーの矢だけの問題は上下の向きを持たない)
        if (seq[i].gankers?.includes("kritz") && seq[i - 1].gankers?.includes("kritz")) {
          expect(seq[i].sideEdge).not.toBe(seq[i - 1].sideEdge);
        }
      }
    }
  });
});
