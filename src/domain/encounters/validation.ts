import type { GameConfig } from "../../config/balance";
import { add, fromAngle, scale } from "../geometry";
import { RoundSimulation, simConfigFrom, type SimConfig } from "../simulation/RoundSimulation";
import type { GeneratedEncounter, Vec2 } from "../types";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** 致命的ではないが望ましくない生成 (例: Flash想定問題が歩きで避けられる) */
  warnings: string[];
}

export type ScriptedAction =
  | { atMs: number; kind: "FLASH"; cursor: Vec2 }
  | { atMs: number; kind: "MOVE"; target: Vec2 };

const HAZARD_TYPES = new Set(["LINE_SHOT", "CIRCLE", "DASH", "SWEEP"]);

/** 入力スクリプトでラウンドを最後まで実行する (Validation / テスト用) */
export function runScripted(enc: GeneratedEncounter, sim: SimConfig, actions: readonly ScriptedAction[]): RoundSimulation {
  const s = new RoundSimulation(enc, sim);
  for (const a of [...actions].sort((x, y) => x.atMs - y.atMs)) {
    if (a.kind === "FLASH") s.tryFlash(a.atMs, a.cursor);
    else s.move(a.atMs, a.target);
  }
  s.advanceTo(enc.roundDurationMs);
  return s;
}

function survivedCleanly(s: RoundSimulation): boolean {
  return s.hit === null && s.mainThreatsResolved();
}

export function flashSamples(enc: GeneratedEncounter, cfg: GameConfig): ScriptedAction[] {
  const at = enc.recognitionMs + cfg.validation.assumedReactionMs;
  const out: ScriptedAction[] = [];
  const n = cfg.validation.flashSampleAngles;
  for (let i = 0; i < n; i++) {
    const dir = fromAngle((i / n) * Math.PI * 2);
    for (const f of cfg.validation.flashSampleDistances) {
      out.push({ atMs: at, kind: "FLASH", cursor: add(enc.playerSpawn, scale(dir, cfg.flash.maxDistance * f)) });
    }
  }
  return out;
}

export function moveSamples(enc: GeneratedEncounter, cfg: GameConfig, reactionMs: number): ScriptedAction[] {
  const at = enc.recognitionMs + reactionMs;
  const n = cfg.validation.moveSampleAngles;
  return Array.from({ length: n }, (_, i) => ({
    atMs: at,
    kind: "MOVE" as const,
    target: add(enc.playerSpawn, scale(fromAngle((i / n) * Math.PI * 2), 400)),
  }));
}

/**
 * 本命をFlashで避けた後に追撃が来る問題: 「本命を避けられるFlash → 追撃の予兆を見てから歩く」で
 * 最後まで当たらない組み合わせがあるか (追撃は歩きの反応時間で避けられること)
 */
function flashThenWalk(enc: GeneratedEncounter, cfg: GameConfig, sim: SimConfig): boolean {
  const followUp = enc.followUpMs!;
  const walkAt = followUp + cfg.validation.moveSolvableReactionMs;
  let tried = 0;
  for (const f of flashSamples(enc, cfg)) {
    if (f.kind !== "FLASH") continue;
    const s = runScripted(enc, sim, [f]);
    if (survivedCleanly(s)) return true;
    // 本命 (追撃より前) に当たるFlashは除外
    if (s.hit && s.hit.atMs < followUp) continue;
    if (++tried > 8) break;
    const n = cfg.validation.moveSampleAngles;
    for (let i = 0; i < n; i++) {
      const target = add(f.cursor, scale(fromAngle((i / n) * Math.PI * 2), 400));
      if (survivedCleanly(runScripted(enc, sim, [f, { atMs: walkAt, kind: "MOVE", target }]))) return true;
    }
  }
  return false;
}

export function validateEncounter(enc: GeneratedEncounter, cfg: GameConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sim = simConfigFrom(cfg);
  const D = enc.roundDurationMs;

  if (D < cfg.roundDurationMs.min || D > cfg.roundDurationMs.max) errors.push(`duration ${D} out of range`);
  if (enc.threatStartMs < cfg.minThreatStartMs) errors.push("threat starts too early");
  if (enc.recognitionMs >= D) errors.push("recognition after round end");
  for (const ev of enc.events) if (ev.atMs >= D) errors.push(`event ${ev.type} after round end`);

  const hazards = enc.events.filter((e) => HAZARD_TYPES.has(e.type));
  if (enc.expectedAction === "WAIT") {
    if (hazards.length > 0) errors.push("WAIT encounter must not create hitboxes");
  } else if (!hazards.some((e) => e.isMainThreat)) {
    errors.push("missing main threat");
  }

  // Distractorと本命が意図せず重ならない
  for (const ev of enc.events) {
    if (ev.isMainThreat) continue;
    if (enc.expectedAction !== "WAIT" && Math.abs(ev.atMs - enc.recognitionMs) < 250) {
      errors.push(`distractor ${ev.type} overlaps main threat`);
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  if (enc.expectedAction === "WAIT") {
    if (!survivedCleanly(runScripted(enc, sim, []))) errors.push("WAIT round is not survivable idle");
    return { ok: errors.length === 0, errors, warnings };
  }

  // 何もしなければ被弾すること (回答の意味がある問題)
  const idle = runScripted(enc, sim, []);
  if (idle.hit === null) errors.push("threat misses an idle player");
  // 視界外から来る攻撃でも、予定の認識時刻にはPlayerの視界内に予兆が見えていること
  if (idle.threatVisibleMs === null || idle.threatVisibleMs - enc.recognitionMs > 50) {
    errors.push("main threat is not visible at recognition");
  }

  const survives = (a: ScriptedAction) => survivedCleanly(runScripted(enc, sim, [a]));
  if (enc.expectedAction === "FLASH") {
    const solved = enc.followUpMs === undefined ? flashSamples(enc, cfg).some(survives) : flashThenWalk(enc, cfg, sim);
    if (!solved) errors.push("no safe Flash destination");
    if (moveSamples(enc, cfg, cfg.validation.walkableCheckReactionMs).some(survives)) warnings.push("walkable");
  } else if (enc.expectedAction === "MOVE") {
    if (!moveSamples(enc, cfg, cfg.validation.moveSolvableReactionMs).some(survives)) errors.push("no safe walking route");
  }
  return { ok: errors.length === 0, errors, warnings };
}
