import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "../src/config/balance";
import { ENCOUNTER_DEFINITIONS, getAnyDefinition } from "../src/domain/encounters/definitions";
import { flashSamples, runScripted, validateEncounter } from "../src/domain/encounters/validation";
import { isVisible, onScreen } from "../src/domain/fieldLayout";
import { add, fromAngle, scale } from "../src/domain/geometry";
import { createRng } from "../src/domain/rng";
import { buildEncounterSequence, generateValidated } from "../src/domain/session";
import { RoundSimulation, simConfigFrom, type LineHazard } from "../src/domain/simulation/RoundSimulation";
import type { ChampionId, GeneratedEncounter, RoundPhase, ScheduledEvent } from "../src/domain/types";
import { RoundSystem } from "../src/game/systems/RoundSystem";
import { makeEncounter } from "./helpers";

const sim = simConfigFrom(GAME_CONFIG);
const A = GAME_CONFIG.gankers.ashley;
const CHAMPIONS: ChampionId[] = ["default", "yonekura", "tamamo"];
const gen = (id: string, seed: string, budget = 2.5, champion: ChampionId = "default") =>
  generateValidated(getAnyDefinition(id), { roundIndex: 7, difficultyBudget: budget, champion, cfg: GAME_CONFIG }, createRng(seed));

const arrowEvent = (enc: GeneratedEncounter) => enc.events.find((e) => e.payload.type === "LINE_SHOT" && e.payload.style === "arrow")!;
const arrowHazard = (s: RoundSimulation) => s.hazards.find((h): h is LineHazard => h.kind === "LINE" && h.payload.style === "arrow")!;

describe("アッシュリー", () => {
  it("the arrow is fired from off screen at the player, and its range is never shown", () => {
    for (let i = 0; i < 8; i++) {
      const enc = gen("ASH-R", `o-${i}`);
      expect(enc.gankers).toEqual(["ashley"]);
      const ev = arrowEvent(enc);
      expect(ev.isMainThreat).toBe(true);
      const s = new RoundSimulation(enc, sim);
      s.advanceTo(ev.atMs + 1);
      const h = arrowHazard(s);
      // 放たれた位置は見えない (画面外か陰の中)
      expect(onScreen(h.origin) && isVisible(h.origin, s.player.pos)).toBe(false);
      expect(s.mainThreatVisible()).toBe(false);
      // 自分へ向かって飛ぶ
      s.advanceTo(enc.roundDurationMs);
      expect(s.hit).not.toBeNull();
    }
  });

  it("comes from many directions, and the time from entering the screen to the hit matches the problem", () => {
    const from = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const enc = gen("ASH-R", `d-${i}`, 1 + (i % 4) * 0.7);
      from.add(enc.variantId!);
      const idle = runScripted(enc, sim, []);
      const window = idle.hit!.atMs - enc.recognitionMs;
      expect(window).toBeGreaterThan(400);
      expect(window).toBeLessThan(600);
      const speed = (arrowEvent(enc).payload as { speed: number }).speed;
      expect(speed).toBeGreaterThanOrEqual(A.minSpeed);
      expect(speed).toBeLessThanOrEqual(A.maxSpeed);
    }
    // 右 (相手側) だけでなく左 (自分の後ろ) や斜めからも来る
    expect(from.size).toBeGreaterThanOrEqual(4);
    expect([...from].some((v) => v.includes("LEFT"))).toBe(true);
    expect([...from].some((v) => v.includes("RIGHT"))).toBe(true);
  });

  it("the arrow cannot be seen while it is in the shade", () => {
    // 真上から: 陰 (y < shadeTop) を通る間は見えず、陰を出たら見える
    const at = 2_000;
    const ev: ScheduledEvent = {
      atMs: at,
      type: "LINE_SHOT",
      isMainThreat: true,
      payload: {
        type: "LINE_SHOT",
        origin: { mode: "OFFSCREEN", angleRad: -Math.PI / 2, distance: 500 },
        aim: { mode: "ANCHOR", angleJitterRad: 0 },
        launchAtMs: at,
        width: A.arrowWidth,
        speed: 500,
        bodyLength: A.arrowLength,
        maxTravel: 1_900,
        enemyCast: false,
        style: "arrow",
      },
    };
    const enc = makeEncounter([ev], { threatStartMs: at, recognitionMs: at });
    const s = new RoundSimulation(enc, sim);
    const shadeTop = GAME_CONFIG.world.vision.shadeTop;
    // 矢の先が y = shadeTop に届く時刻 (Playerは y = 300)
    const enterAt = at + ((500 - (300 - shadeTop)) / 500) * 1000;
    s.advanceTo(enterAt - 30);
    expect(onScreen(add(s.player.pos, scale(fromAngle(-Math.PI / 2), 300 - shadeTop + 20)))).toBe(true);
    expect(s.mainThreatVisible()).toBe(false);
    s.advanceTo(enterAt + 30);
    expect(s.mainThreatVisible()).toBe(true);
  });

  it("MOVE: seen from far away, walking sideways after a human reaction dodges it", () => {
    for (let i = 0; i < 5; i++) {
      const enc = gen("ASH-R-FAR", `m-${i}`);
      expect(enc.expectedAction).toBe("MOVE");
      expect(runScripted(enc, sim, []).hit!.atMs - enc.recognitionMs).toBeGreaterThan(900);
      const s0 = new RoundSimulation(enc, sim);
      s0.advanceTo(arrowEvent(enc).atMs + 1);
      const dir = arrowHazard(s0).dir;
      const ok = [1, -1].some((k) => {
        const target = { x: enc.playerSpawn.x - dir.y * 200 * k, y: enc.playerSpawn.y + dir.x * 200 * k };
        return runScripted(enc, sim, [{ atMs: enc.recognitionMs + 350, kind: "MOVE", target }]).hit === null;
      });
      expect(ok).toBe(true);
    }
  });

  it("all アッシュリー problems validate against every lane opponent", () => {
    for (const def of ENCOUNTER_DEFINITIONS.filter((d) => d.gankers?.includes("ashley"))) {
      for (const champion of CHAMPIONS) {
        const enc = gen(def.id, `v-${def.id}-${champion}`, def.difficulty === 3 ? 3 : 2, champion);
        expect(validateEncounter(enc, GAME_CONFIG).ok, `${def.id} ${champion}`).toBe(true);
      }
    }
  });

  it("LANE: the arrow and the lane opponent's skill are both real threats", () => {
    for (const champion of CHAMPIONS) {
      const enc = gen("ASH-R-LANE", `l-${champion}`, 3, champion);
      expect(enc.events.filter((e) => e.isMainThreat).length, champion).toBe(2);
      expect(enc.kind).toBe("DIRECTIONAL_TRAP");
    }
  });

  it("KRZ: クリッツブランク and アッシュリー gank together", () => {
    const enc = gen("ASH-R-KRZ", "k-1", 3);
    expect(enc.gankers).toEqual(["kritz", "ashley"]);
    const mains = enc.events.filter((e) => e.isMainThreat);
    expect(mains.some((e) => e.payload.type === "LINE_SHOT" && e.payload.style === "hook")).toBe(true);
    expect(mains.some((e) => e.payload.type === "LINE_SHOT" && e.payload.style === "arrow")).toBe(true);
  });

  it("FOLLOW: a Flash that dodges the arrow is caught by the follow-up unless you also walk", () => {
    for (const champion of CHAMPIONS) {
      const enc = gen("ASH-R-FOLLOW", `f-${champion}`, 3, champion);
      expect(enc.followUpMs).toBeGreaterThan(enc.recognitionMs);
      let dodged = 0;
      let walkedOut = false;
      for (const f of flashSamples(enc, GAME_CONFIG)) {
        if (f.kind !== "FLASH") continue;
        const s = runScripted(enc, sim, [f]);
        if (s.hit && s.hit.atMs < enc.followUpMs!) continue;
        dodged++;
        // Flashだけでは追撃に当たる (追撃はFlash後の位置を狙う)
        expect(s.hit, champion).not.toBeNull();
        if (!walkedOut) {
          for (let i = 0; i < 24 && !walkedOut; i++) {
            const target = add(f.cursor, scale(fromAngle((i / 24) * Math.PI * 2), 400));
            walkedOut = runScripted(enc, sim, [f, { atMs: enc.followUpMs! + 350, kind: "MOVE", target }]).hit === null;
          }
        }
      }
      expect(dodged).toBeGreaterThan(0);
      expect(walkedOut, champion).toBe(true);
    }
  });

  it("a hit freezes the player in place and holds the resolution for it", () => {
    const enc = gen("ASH-R", "z-1");
    const s = runScripted(enc, sim, []);
    const d = s.hitDisplacement()!;
    expect(d.kind).toBe("freeze");
    expect(d.to).toEqual(d.from);
    expect(d.durationMs).toBe(A.freezeMs);

    const phases: { p: RoundPhase; at: number }[] = [];
    let now = 1_000;
    const rs = new RoundSystem("z", [enc], GAME_CONFIG, { onPhaseChange: (p) => phases.push({ p, at: now }) });
    rs.start(now);
    while (rs.phase !== "COMPLETE" && now < 60_000) {
      now += 5;
      rs.update(now);
    }
    const res = phases.find((x) => x.p === "RESOLUTION")!;
    const result = phases.find((x) => x.p === "RESULT")!;
    expect(result.at - res.at).toBeGreaterThanOrEqual(GAME_CONFIG.phases.resolutionMs + A.freezeMs - 10);
  });

  it("is deterministic regardless of the input frame step", () => {
    const enc = gen("ASH-R-LANE", "det-1", 3, "tamamo");
    const a = runScripted(enc, sim, []);
    const b = new RoundSimulation(enc, sim);
    for (let t = 0; t <= enc.roundDurationMs; t += 7.3) b.advanceTo(t);
    b.advanceTo(enc.roundDurationMs);
    expect(b.hit?.atMs).toBeCloseTo(a.hit!.atMs, 0);
  });

  it("sessions sometimes include アッシュリー rounds", () => {
    const all = Array.from({ length: 30 }, (_, i) => buildEncounterSequence(`ash-${i}`)).flat();
    const ash = all.filter((e) => e.definitionId.startsWith("ASH-"));
    expect(ash.length).toBeGreaterThan(0);
    for (const e of ash) expect(e.gankers).toContain("ashley");
  });
});
