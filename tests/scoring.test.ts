import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { aggregateResults } from "../src/domain/aggregate";
import { executionScore, scoreRound, timingScore, type ScoreInput } from "../src/domain/scoring";
import type { RoundResult } from "../src/domain/types";

const cfg = GAME_CONFIG.scoring;
const w = { excellentMs: 300, goodMs: 450, lateMs: 650 };
const base: ScoreInput = {
  expectedAction: "FLASH",
  playerAction: "FLASH",
  survived: true,
  flashedBeforeThreat: false,
  flashedAfterThreat: true,
  reactionTimeMs: 250,
  early: false,
  timingWindow: w,
  clearance: 40,
  idealMargin: 18,
};

describe("timing curve", () => {
  it("interpolates piecewise linearly", () => {
    expect(timingScore(100, w, cfg)).toBe(400);
    expect(timingScore(300, w, cfg)).toBe(400);
    expect(timingScore(375, w, cfg)).toBeCloseTo(350);
    expect(timingScore(450, w, cfg)).toBeCloseTo(300);
    expect(timingScore(550, w, cfg)).toBeCloseTo(225);
    expect(timingScore(650, w, cfg)).toBeCloseTo(150);
    expect(timingScore(900, w, cfg)).toBe(50);
  });
});

describe("execution", () => {
  it("is continuous in the safety margin", () => {
    expect(executionScore(18, 18, cfg)).toBe(200);
    expect(executionScore(9, 18, cfg)).toBe(100);
    expect(executionScore(0, 18, cfg)).toBe(1);
    expect(executionScore(-1, 18, cfg)).toBe(0);
    expect(executionScore(Infinity, 18, cfg)).toBe(200);
  });
});

describe("scoreRound", () => {
  it("perfect flash = 1000", () => {
    const s = scoreRound(base, cfg);
    expect(s.totalScore).toBe(1000);
    expect(s.label).toBe("PERFECT");
  });

  it("hit = 0", () => {
    const s = scoreRound({ ...base, survived: false, playerAction: "WAIT", flashedAfterThreat: false, reactionTimeMs: undefined }, cfg);
    expect(s.totalScore).toBe(0);
    expect(s.label).toBe("HIT");
  });

  it("flash into danger = WRONG DIRECTION", () => {
    const s = scoreRound({ ...base, survived: false }, cfg);
    expect(s.totalScore).toBe(0);
    expect(s.label).toBe("WRONG DIRECTION");
  });

  it("WAIT expected, no flash = GOOD HOLD 1000", () => {
    const s = scoreRound({ ...base, expectedAction: "WAIT", playerAction: "WAIT", flashedAfterThreat: false, reactionTimeMs: undefined }, cfg);
    expect(s.totalScore).toBe(1000);
    expect(s.label).toBe("GOOD HOLD");
  });

  it("WAIT expected, flash = WASTED FLASH with partial decision only", () => {
    const s = scoreRound({ ...base, expectedAction: "WAIT", reactionTimeMs: undefined }, cfg);
    expect(s).toMatchObject({ label: "WASTED FLASH", wastedFlash: true, totalScore: cfg.wrongButSurvivedDecision });
  });

  it("MOVE expected but flashed & survived: decision 100, timing/execution normal", () => {
    const s = scoreRound({ ...base, expectedAction: "MOVE" }, cfg);
    expect(s.decisionScore).toBe(100);
    expect(s.timingScore).toBe(400);
    expect(s.executionScore).toBe(200);
    expect(s.label).toBe("WASTED FLASH");
  });

  it("FLASH expected but flash wasted before threat, then walked out", () => {
    const s = scoreRound({ ...base, flashedBeforeThreat: true, flashedAfterThreat: false }, cfg);
    expect(s.decisionScore).toBe(100);
    expect(s.wastedFlash).toBe(true);
  });

  it("early (before lock) halves timing", () => {
    const s = scoreRound({ ...base, early: true, reactionTimeMs: 0 }, cfg);
    expect(s.timingScore).toBe(200);
    expect(s.label).toBe("EARLY");
  });

  it("never exceeds 1000", () => {
    for (const exp of ["FLASH", "MOVE", "WAIT"] as const) {
      for (const act of ["FLASH", "MOVE", "WAIT"] as const) {
        const s = scoreRound({ ...base, expectedAction: exp, playerAction: act, reactionTimeMs: 0, clearance: 999 }, cfg);
        expect(s.totalScore).toBeLessThanOrEqual(1000);
      }
    }
  });
});

describe("aggregateResults", () => {
  const r = (over: Partial<RoundResult>): RoundResult => ({
    roundIndex: 0,
    encounterId: "E",
    encounterName: "E",
    champion: "default",
    survived: true,
    expectedAction: "FLASH",
    playerAction: "FLASH",
    early: false,
    wastedFlash: false,
    decisionScore: 400,
    timingScore: 400,
    executionScore: 200,
    totalScore: 1000,
    label: "PERFECT",
    csCount: 0,
    csCannon: 0,
    csScore: 0,
    ...over,
  });

  it("computes totals and reaction stats only over rounds with reaction", () => {
    const g = aggregateResults(
      "s",
      [
        r({ reactionTimeMs: 300 }),
        r({ reactionTimeMs: 200, label: "GOOD", totalScore: 800 }),
        r({ label: "GOOD HOLD", expectedAction: "WAIT", playerAction: "WAIT" }),
        r({ survived: false, label: "HIT", totalScore: 0, wastedFlash: true, csCount: 2, csCannon: 1, csScore: 70 }),
      ],
      1000,
    );
    expect(g.mainScore).toBe(2800);
    expect(g.csScore).toBe(70);
    expect(g.totalScore).toBe(2870);
    expect(g.maxScore).toBe(4000);
    expect(g.averageReactionMs).toBe(250);
    expect(g.bestReactionMs).toBe(200);
    expect(g.perfectCount).toBe(2);
    expect(g.hitCount).toBe(1);
    expect(g.wastedFlashCount).toBe(1);
    expect(g.csCount).toBe(2);
  });
});
