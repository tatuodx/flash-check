import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { getAnyDefinition } from "../src/domain/encounters/definitions";
import { runScripted } from "../src/domain/encounters/validation";
import { isVisible } from "../src/domain/fieldLayout";
import { distance } from "../src/domain/geometry";
import { createRng } from "../src/domain/rng";
import { buildEncounterSequence, generateValidated } from "../src/domain/session";
import { RoundSimulation, simConfigFrom } from "../src/domain/simulation/RoundSimulation";
import type { GeneratedEncounter, RoundPhase } from "../src/domain/types";
import { RoundSystem } from "../src/game/systems/RoundSystem";

const sim = simConfigFrom(GAME_CONFIG);
const K = GAME_CONFIG.gankers.kritz;
const gen = (id: string, seed: string, budget = 2) =>
  generateValidated(getAnyDefinition(id), { roundIndex: 4, difficultyBudget: budget, cfg: GAME_CONFIG }, createRng(seed));

/** 指定のルートが出るまでSeedを回す */
function genRoute(id: string, route: string): GeneratedEncounter {
  for (let i = 0; i < 200; i++) {
    const enc = gen(id, `${id}-${route}-${i}`);
    if (enc.variantId?.startsWith(route)) return enc;
  }
  throw new Error(`no ${route} variant`);
}

function gankerEvent(enc: GeneratedEncounter) {
  const ev = enc.events.find((e) => e.payload.type === "GANKER")!;
  if (ev.payload.type !== "GANKER") throw new Error();
  return { ev, p: ev.payload };
}

describe("クリッツブランク", () => {
  it("Q encounters are gank rounds with the ganker recorded", () => {
    const enc = gen("KRZ-Q", "k-1");
    expect(enc.kind).toBe("SIDE_GANK");
    expect(enc.ganker).toBe("kritz");
    const hook = enc.events.find((e) => e.isMainThreat)!;
    expect(hook.payload.type === "LINE_SHOT" && hook.payload.style === "hook" && hook.payload.origin.mode === "GANKER").toBe(true);
  });

  it("APPROACH: hidden in the shade, comes into vision with W, stops and hooks; a hit is pulled in", () => {
    const enc = genRoute("KRZ-Q", "APPROACH");
    const { ev } = gankerEvent(enc);
    const s = new RoundSimulation(enc, sim);
    s.advanceTo(ev.atMs + 1);
    expect(s.ganker).not.toBeNull();
    expect(isVisible(s.ganker!.pos, s.player.pos)).toBe(false);
    expect(s.gankerHasted()).toBe(true);
    let seenWhileHasted = false;
    for (let t = ev.atMs; t < enc.threatStartMs; t += 20) {
      s.advanceTo(t);
      if (isVisible(s.ganker!.pos, s.player.pos) && s.gankerHasted() && s.ganker!.moving) seenWhileHasted = true;
    }
    expect(seenWhileHasted).toBe(true);
    s.advanceTo(enc.threatStartMs + 1);
    // 止まって詠唱を始めた姿が見えている = 認識
    expect(isVisible(s.ganker!.pos, s.player.pos)).toBe(true);
    expect(s.threatVisibleMs).toBe(enc.recognitionMs);
    s.advanceTo(enc.roundDurationMs);
    expect(s.hit).not.toBeNull();
    const pull = s.hookPull()!;
    expect(pull).not.toBeNull();
    expect(distance(pull.to, s.ganker!.pos)).toBeCloseTo(K.radius + GAME_CONFIG.player.radius + 4, 3);
  });

  it("AMBUSH: never leaves the shade; recognition is when the chain comes out of the shade", () => {
    const enc = genRoute("KRZ-Q", "AMBUSH");
    const s = new RoundSimulation(enc, sim);
    const hookAt = enc.threatStartMs;
    s.advanceTo(hookAt + 1);
    expect(isVisible(s.ganker!.pos, s.player.pos)).toBe(false);
    // 詠唱中は何も見えない
    s.advanceTo(enc.recognitionMs - 1);
    expect(s.mainThreatVisible()).toBe(false);
    s.advanceTo(enc.roundDurationMs);
    expect(s.threatVisibleMs! - enc.recognitionMs).toBeLessThanOrEqual(50);
    expect(s.threatVisibleMs!).toBeGreaterThanOrEqual(enc.recognitionMs);
    expect(isVisible(s.ganker!.pos, s.player.pos)).toBe(false);
    expect(s.hit).not.toBeNull();
  });

  it("AMBUSH Q can be flashed sideways after a human reaction", () => {
    const enc = genRoute("KRZ-Q", "AMBUSH");
    const hook = enc.events.find((e) => e.isMainThreat)!;
    // 鎖の向き (Player -> 隠れている位置) に垂直へFlash
    const s0 = new RoundSimulation(enc, sim);
    s0.advanceTo(hook.atMs + 1);
    const g = s0.ganker!.pos;
    const d = { x: enc.playerSpawn.x - g.x, y: enc.playerSpawn.y - g.y };
    const n = Math.hypot(d.x, d.y);
    const perp = { x: -d.y / n, y: d.x / n };
    const ok = [1, -1].some((sgn) => {
      const cursor = { x: enc.playerSpawn.x + perp.x * 180 * sgn, y: enc.playerSpawn.y + perp.y * 180 * sgn };
      const s = runScripted(enc, sim, [{ atMs: enc.recognitionMs + 250, kind: "FLASH", cursor }]);
      return s.hit === null;
    });
    expect(ok).toBe(true);
  });

  it("far Q (MOVE) can be walked out of", () => {
    const enc = gen("KRZ-Q-FAR", "far-1");
    expect(enc.expectedAction).toBe("MOVE");
    const s0 = new RoundSimulation(enc, sim);
    s0.advanceTo(enc.threatStartMs + 1);
    const g = s0.ganker!.pos;
    expect(distance(g, s0.player.pos)).toBeGreaterThan(330);
    const d = { x: enc.playerSpawn.x - g.x, y: enc.playerSpawn.y - g.y };
    const n = Math.hypot(d.x, d.y);
    const ok = [1, -1].some((sgn) => {
      const target = { x: enc.playerSpawn.x - (d.y / n) * 200 * sgn, y: enc.playerSpawn.y + (d.x / n) * 200 * sgn };
      return runScripted(enc, sim, [{ atMs: enc.recognitionMs + 350, kind: "MOVE", target }]).hit === null;
    });
    expect(ok).toBe(true);
  });

  it("W fake (RETREAT): comes into vision, stops, then walks back into the shade without a hook", () => {
    const enc = genRoute("KRZ-W", "RETREAT");
    expect(enc.expectedAction).toBe("WAIT");
    const { ev, p } = gankerEvent(enc);
    const s = new RoundSimulation(enc, sim);
    let seen = false;
    for (let t = ev.atMs; t < ev.atMs + p.leaveAfterMs!; t += 20) {
      s.advanceTo(t);
      if (isVisible(s.ganker!.pos, s.player.pos)) seen = true;
    }
    expect(seen).toBe(true);
    s.advanceTo(enc.roundDurationMs);
    expect(s.hazards).toHaveLength(0);
    expect(s.hit).toBeNull();
    expect(distance(s.ganker!.pos, s.ganker!.spawn)).toBeLessThan(1);
    expect(isVisible(s.ganker!.pos, s.player.pos)).toBe(false);
  });

  it("W fake (PASS): crosses the lane into the opposite shade, staying away from the player", () => {
    const enc = genRoute("KRZ-W", "PASS");
    const s = new RoundSimulation(enc, sim);
    const { ev } = gankerEvent(enc);
    s.advanceTo(ev.atMs + 1);
    const startY = s.ganker!.pos.y;
    let closest = Infinity;
    for (let t = ev.atMs; t < enc.roundDurationMs; t += 20) {
      s.advanceTo(t);
      closest = Math.min(closest, distance(s.ganker!.pos, s.player.pos));
    }
    s.advanceTo(enc.roundDurationMs);
    expect(Math.sign(s.ganker!.pos.y - 300)).toBe(-Math.sign(startY - 300));
    expect(isVisible(s.ganker!.pos, s.player.pos)).toBe(false);
    expect(closest).toBeGreaterThan(300);
    expect(s.hit).toBeNull();
  });

  it("is deterministic regardless of the input frame step", () => {
    const enc = genRoute("KRZ-Q", "APPROACH");
    const a = new RoundSimulation(enc, sim);
    const b = new RoundSimulation(enc, sim);
    for (let t = 0; t <= enc.threatStartMs; t += 16.7) a.advanceTo(t);
    for (let t = 0; t <= enc.threatStartMs; t += 7.3) b.advanceTo(t);
    a.advanceTo(enc.threatStartMs);
    b.advanceTo(enc.threatStartMs);
    expect(distance(a.ganker!.pos, b.ganker!.pos)).toBeLessThan(0.5);
  });

  it("sessions sometimes include クリッツブランク rounds", () => {
    const all = Array.from({ length: 30 }, (_, i) => buildEncounterSequence(`krz-${i}`)).flat();
    const krz = all.filter((e) => e.definitionId.startsWith("KRZ-"));
    expect(krz.length).toBeGreaterThan(0);
    for (const e of krz) expect(e.ganker).toBe("kritz");
    for (const e of all) if (!e.definitionId.startsWith("KRZ-")) expect(e.ganker).toBeUndefined();
  });

  it("a hook hit holds the resolution longer for the pull", () => {
    const enc = genRoute("KRZ-Q", "APPROACH");
    const phases: { p: RoundPhase; at: number }[] = [];
    let now = 1_000;
    const rs = new RoundSystem("k", [enc], GAME_CONFIG, { onPhaseChange: (p) => phases.push({ p, at: now }) });
    rs.start(now);
    while (rs.phase !== "COMPLETE" && now < 60_000) {
      now += 5;
      rs.update(now);
    }
    const res = phases.find((x) => x.p === "RESOLUTION")!;
    const result = phases.find((x) => x.p === "RESULT")!;
    expect(result.at - res.at).toBeGreaterThanOrEqual(GAME_CONFIG.phases.resolutionMs + K.pullMs - 10);
  });
});
