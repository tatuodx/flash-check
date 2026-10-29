import type { GameConfig } from "../config/balance";
import { clamp, lerp } from "./geometry";
import type { SimOutcome } from "./simulation/RoundSimulation";
import type { GeneratedEncounter, PlayerAction, ResultLabel, RoundResult, TimingWindow } from "./types";

export type ScoringConfig = GameConfig["scoring"];

export interface ScoreInput {
  expectedAction: PlayerAction;
  playerAction: PlayerAction;
  survived: boolean;
  /** Flashを本命認識前 (Lock型はearly window前) に消費した */
  flashedBeforeThreat: boolean;
  /** 本命に対する最初の有効行動の反応時間 */
  reactionTimeMs?: number;
  /** Lock型でLock前に行動した */
  early: boolean;
  /** 本命Flashが本命認識後だった (被弾時のWRONG DIRECTION判定用) */
  flashedAfterThreat: boolean;
  timingWindow: TimingWindow;
  /** 本命Hazardに対する最小安全余裕 (Infinity = 未接触) */
  clearance: number;
  idealMargin: number;
}

export interface ScoreBreakdown {
  decisionScore: number;
  timingScore: number;
  executionScore: number;
  totalScore: number;
  label: ResultLabel;
  wastedFlash: boolean;
}

/** 反応時間 -> Timing点 (区間線形補間) */
export function timingScore(reactionMs: number, w: TimingWindow, cfg: ScoringConfig): number {
  const c = cfg.timingCurve;
  if (reactionMs <= w.excellentMs) return c.excellent;
  if (reactionMs <= w.goodMs) return lerp(c.excellent, c.good, (reactionMs - w.excellentMs) / (w.goodMs - w.excellentMs));
  if (reactionMs <= w.lateMs) return lerp(c.good, c.late, (reactionMs - w.goodMs) / (w.lateMs - w.goodMs));
  return c.beyondLate;
}

/** 安全余裕 -> Execution点。生存していれば最低1点 */
export function executionScore(clearance: number, idealMargin: number, cfg: ScoringConfig): number {
  if (clearance < 0) return 0;
  if (!Number.isFinite(clearance) || clearance >= idealMargin) return cfg.execution;
  return Math.max(1, Math.round((cfg.execution * clearance) / idealMargin));
}

function finish(
  decision: number,
  timing: number,
  execution: number,
  label: ResultLabel,
  wastedFlash: boolean,
  cfg: ScoringConfig,
): ScoreBreakdown {
  const d = Math.round(clamp(decision, 0, cfg.decision));
  const t = Math.round(clamp(timing, 0, cfg.timing));
  const e = Math.round(clamp(execution, 0, cfg.execution));
  return {
    decisionScore: d,
    timingScore: t,
    executionScore: e,
    totalScore: Math.min(cfg.maxPerRound, d + t + e),
    label,
    wastedFlash,
  };
}

export function scoreRound(input: ScoreInput, cfg: ScoringConfig): ScoreBreakdown {
  const { expectedAction, playerAction, survived } = input;
  const flashUsed = playerAction === "FLASH";
  const wastedFlash = flashUsed && (expectedAction !== "FLASH" || input.flashedBeforeThreat);

  // 1. 最終的に被弾したか
  if (!survived) {
    const wrongDir =
      input.flashedAfterThreat &&
      input.reactionTimeMs !== undefined &&
      input.reactionTimeMs <= input.timingWindow.lateMs;
    return finish(0, 0, 0, wrongDir ? "WRONG DIRECTION" : "HIT", wastedFlash, cfg);
  }

  // WAITが正解: Flash温存で満点、消費は部分点のみ
  if (expectedAction === "WAIT") {
    if (!flashUsed) return finish(cfg.decision, cfg.timing, cfg.execution, "GOOD HOLD", false, cfg);
    return finish(cfg.wrongButSurvivedDecision, 0, 0, "WASTED FLASH", true, cfg);
  }

  // 2-3. Flash消費 / 正解行動
  const correct = playerAction === expectedAction && !input.flashedBeforeThreat;
  const decision = correct ? cfg.decision : cfg.wrongButSurvivedDecision;

  // 4. タイミング
  let timing = 0;
  if (input.reactionTimeMs !== undefined) {
    timing = timingScore(input.reactionTimeMs, input.timingWindow, cfg);
    if (input.early) timing *= cfg.earlyTimingMultiplier;
  }

  // 5. 最終位置の安全余裕
  const execution = executionScore(input.clearance, input.idealMargin, cfg);

  let label: ResultLabel;
  if (wastedFlash) label = "WASTED FLASH";
  else if (!correct) label = "SURVIVED";
  else if (input.early) label = "EARLY";
  else if (input.reactionTimeMs === undefined) label = "SURVIVED";
  else if (input.reactionTimeMs <= input.timingWindow.excellentMs && execution >= cfg.perfectExecutionMin) label = "PERFECT";
  else if (input.reactionTimeMs <= input.timingWindow.goodMs) label = "GOOD";
  else label = "LATE";

  return finish(decision, timing, execution, label, wastedFlash, cfg);
}

export interface ActionClassification {
  playerAction: PlayerAction;
  reactionTimeMs?: number;
  early: boolean;
  flashedBeforeThreat: boolean;
  flashedAfterThreat: boolean;
}

/**
 * 02/09仕様の行動分類:
 * - FLASH: Fキーを使用
 * - MOVE: 本命認識後に右クリックで移動先を更新し、Flashを使わない
 * - WAIT: それ以外 (Neutral中の移動は回答扱いしない)
 */
export function classifyAction(enc: GeneratedEncounter, outcome: SimOutcome): ActionClassification {
  const recognition = outcome.recognitionMs;
  const windowStart = enc.earlyWindowStartMs ?? recognition;
  const cutoff = outcome.hitAtMs ?? Infinity;
  const flash = outcome.flash;
  const flashedBeforeThreat = flash !== null && flash.timestampMs < windowStart;
  const flashedAfterThreat = flash !== null && !flashedBeforeThreat;

  const actionTimes: number[] = [];
  if (flashedAfterThreat) actionTimes.push(flash.timestampMs);
  const threatMoves = outcome.moves.filter((m) => m.timestampMs >= windowStart && m.timestampMs <= cutoff);
  if (threatMoves.length > 0) actionTimes.push(threatMoves[0].timestampMs);

  const playerAction: PlayerAction = flash ? "FLASH" : threatMoves.length > 0 ? "MOVE" : "WAIT";

  if (enc.expectedAction === "WAIT" || actionTimes.length === 0) {
    return { playerAction, early: false, flashedBeforeThreat, flashedAfterThreat };
  }
  const first = Math.min(...actionTimes);
  return {
    playerAction,
    reactionTimeMs: Math.max(0, Math.round(first - recognition)),
    early: first < recognition,
    flashedBeforeThreat,
    flashedAfterThreat,
  };
}

/** CSボーナス (1ラウンド1000点とは別枠) */
export function csScore(csCount: number, csCannon: number, cfg: ScoringConfig): number {
  return (csCount - csCannon) * cfg.cs.melee + csCannon * cfg.cs.cannon;
}

export function evaluateRound(enc: GeneratedEncounter, outcome: SimOutcome, cfg: ScoringConfig): RoundResult {
  const cls = classifyAction(enc, outcome);
  const score = scoreRound(
    {
      expectedAction: enc.expectedAction,
      playerAction: cls.playerAction,
      survived: !outcome.hit,
      flashedBeforeThreat: cls.flashedBeforeThreat,
      flashedAfterThreat: cls.flashedAfterThreat,
      reactionTimeMs: cls.reactionTimeMs,
      early: cls.early,
      timingWindow: enc.timingWindow,
      clearance: outcome.minClearance,
      idealMargin: enc.idealMargin,
    },
    cfg,
  );
  return {
    roundIndex: enc.roundIndex,
    encounterId: enc.definitionId,
    encounterName: enc.name,
    variantId: enc.variantId,
    champion: enc.champion,
    ganker: enc.ganker,
    survived: !outcome.hit,
    expectedAction: enc.expectedAction,
    playerAction: cls.playerAction,
    reactionTimeMs: cls.reactionTimeMs,
    early: cls.early,
    wastedFlash: score.wastedFlash,
    decisionScore: score.decisionScore,
    timingScore: score.timingScore,
    executionScore: score.executionScore,
    totalScore: score.totalScore,
    label: score.label,
    flash: outcome.flash ?? undefined,
    csCount: outcome.csCount,
    csCannon: outcome.csCannon,
    csScore: csScore(outcome.csCount, outcome.csCannon, cfg),
  };
}
