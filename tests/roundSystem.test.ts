import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { classifyAction } from "../src/domain/scoring";
import { buildEncounterSequence } from "../src/domain/session";
import type { RoundPhase } from "../src/domain/types";
import { RoundSystem } from "../src/game/systems/RoundSystem";
import { circle, makeEncounter } from "./helpers";
import { RoundSimulation, simConfigFrom } from "../src/domain/simulation/RoundSimulation";

function runToEnd(rs: RoundSystem, start: number, onFrame?: (now: number) => void): number {
  let now = start;
  for (let i = 0; i < 200_000 && rs.phase !== "COMPLETE"; i++) {
    now += 16.7;
    onFrame?.(now);
    rs.update(now);
  }
  return now;
}

describe("RoundSystem", () => {
  it("plays 10 rounds to completion and aggregates results", () => {
    const seq = buildEncounterSequence("int-1");
    const phases: RoundPhase[] = [];
    let completed = 0;
    const rs = new RoundSystem("int-1", seq, GAME_CONFIG, {
      onPhaseChange: (p) => phases.push(p),
      onComplete: () => completed++,
    });
    rs.start(1_000);
    runToEnd(rs, 1_000);
    expect(rs.phase).toBe("COMPLETE");
    expect(completed).toBe(1);
    expect(rs.results).toHaveLength(10);
    expect(rs.gameResult?.rounds).toHaveLength(10);
    expect(rs.gameResult!.totalScore).toBeLessThanOrEqual(10_000);
    // 何もしないプレイヤー: WAIT問題だけ満点、他は被弾
    for (const r of rs.results) {
      if (r.expectedAction === "WAIT") expect(r.label).toBe("GOOD HOLD");
      else expect(r.label).toBe("HIT");
    }
    expect(phases.filter((p) => p === "INTRO")).toHaveLength(10);
    expect(phases.filter((p) => p === "RESULT")).toHaveLength(10);
  });

  it("rejects input outside NEUTRAL/THREAT", () => {
    const rs = new RoundSystem("x", buildEncounterSequence("x"), GAME_CONFIG);
    rs.start(0);
    expect(rs.phase).toBe("INTRO");
    expect(rs.flash(10, { x: 0, y: 0 })).toBeNull();
    rs.update(GAME_CONFIG.phases.introMs + 1);
    expect(rs.phase).toBe("NEUTRAL");
    expect(rs.flash(GAME_CONFIG.phases.introMs + 2, { x: 0, y: 0 })).not.toBeNull();
  });

  it("cannot be started twice", () => {
    const rs = new RoundSystem("x", buildEncounterSequence("x"), GAME_CONFIG);
    rs.start(0);
    expect(() => rs.start(1)).toThrow();
  });

  it("a hit ends the round immediately with HIT", () => {
    const enc = makeEncounter([circle(2_000, 100, 600)], { expectedAction: "MOVE", roundDurationMs: 8_000 });
    const rs = new RoundSystem("h", [enc], GAME_CONFIG);
    rs.start(0);
    const intro = GAME_CONFIG.phases.introMs;
    rs.update(intro);
    rs.update(intro + 2_700);
    expect(rs.phase).toBe("RESOLUTION");
    expect(rs.lastResult?.label).toBe("HIT");
    expect(rs.sim.t).toBeLessThan(8_000);
  });
});

describe("classifyAction", () => {
  const sim = simConfigFrom(GAME_CONFIG);
  it("does not count NEUTRAL movement as the answer", () => {
    const enc = makeEncounter([circle(3_000, 90, 1_100)], { expectedAction: "MOVE", recognitionMs: 3_000 });
    const s = new RoundSimulation(enc, sim);
    s.move(500, { x: 320, y: 300 });
    s.advanceTo(5_000);
    const c = classifyAction(enc, s.outcome());
    expect(c.playerAction).toBe("WAIT");
    expect(c.reactionTimeMs).toBeUndefined();
  });

  it("measures reaction from recognition to the first valid action", () => {
    const enc = makeEncounter([circle(3_000, 90, 1_100)], { expectedAction: "MOVE", recognitionMs: 3_000 });
    const s = new RoundSimulation(enc, sim);
    s.move(3_280, { x: 300, y: 0 });
    s.advanceTo(5_000);
    const c = classifyAction(enc, s.outcome());
    expect(c.playerAction).toBe("MOVE");
    expect(c.reactionTimeMs).toBe(280);
  });

  it("uses the rendered recognition time when available", () => {
    const enc = makeEncounter([circle(3_000, 90, 1_100)], { expectedAction: "MOVE", recognitionMs: 3_000 });
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(3_010);
    s.markRecognitionVisible(3_010);
    s.move(3_310, { x: 300, y: 0 });
    s.advanceTo(5_000);
    expect(classifyAction(enc, s.outcome()).reactionTimeMs).toBe(300);
  });

  it("lock-type: action before lock is early", () => {
    const enc = makeEncounter([circle(3_000, 90, 1_100)], { recognitionMs: 3_600, earlyWindowStartMs: 3_000 });
    const s = new RoundSimulation(enc, sim);
    s.tryFlash(3_300, { x: 300, y: 0 });
    s.advanceTo(5_000);
    const c = classifyAction(enc, s.outcome());
    expect(c.early).toBe(true);
    expect(c.flashedBeforeThreat).toBe(false);
  });
});
