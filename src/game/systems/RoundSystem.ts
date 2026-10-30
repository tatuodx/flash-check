import type { GameConfig } from "../../config/balance";
import { aggregateResults } from "../../domain/aggregate";
import { csScore, evaluateRound } from "../../domain/scoring";
import { RoundSimulation, simConfigFrom, type AttackRecord, type SimConfig } from "../../domain/simulation/RoundSimulation";
import type { FlashRecord, GameResult, GeneratedEncounter, RoundPhase, RoundResult, Vec2 } from "../../domain/types";

export interface RoundSystemListener {
  onPhaseChange?(phase: RoundPhase, roundIndex: number): void;
  onRoundResult?(result: RoundResult): void;
  onComplete?(result: GameResult): void;
}

const TRANSITIONS: Record<RoundPhase, readonly RoundPhase[]> = {
  INTRO: ["NEUTRAL"],
  NEUTRAL: ["THREAT", "RESOLUTION"],
  THREAT: ["RESOLUTION"],
  RESOLUTION: ["RESULT"],
  RESULT: ["INTRO", "COMPLETE"],
  COMPLETE: [],
};

/**
 * 10ラウンドの進行を管理する明示的な状態機械。
 * 時刻は performance.now() 相当のmonotonic clock (ms) を外部から受け取る。
 * 状態遷移 (transition) 以外の経路で次ラウンドへは進まない。
 */
export class RoundSystem {
  phase: RoundPhase = "INTRO";
  roundIndex = 0;
  sim: RoundSimulation;
  readonly results: RoundResult[] = [];
  lastResult: RoundResult | null = null;
  gameResult: GameResult | null = null;

  private readonly simCfg: SimConfig;
  private phaseStartedAt = 0;
  private roundStartAt = 0;
  private started = false;

  constructor(
    readonly seed: string,
    readonly encounters: readonly GeneratedEncounter[],
    readonly cfg: GameConfig,
    private readonly listener: RoundSystemListener = {},
  ) {
    if (encounters.length === 0) throw new Error("No encounters");
    this.simCfg = simConfigFrom(cfg);
    this.sim = new RoundSimulation(encounters[0], this.simCfg);
  }

  get encounter(): GeneratedEncounter {
    return this.encounters[this.roundIndex];
  }

  get acceptsInput(): boolean {
    return this.phase === "NEUTRAL" || this.phase === "THREAT";
  }

  start(now: number): void {
    if (this.started) throw new Error("RoundSystem already started");
    this.started = true;
    this.phaseStartedAt = now;
    this.listener.onPhaseChange?.("INTRO", 0);
  }

  roundTime(now: number): number {
    return Math.max(0, now - this.roundStartAt);
  }

  update(now: number): void {
    if (!this.started) return;
    const elapsed = now - this.phaseStartedAt;
    const p = this.cfg.phases;
    switch (this.phase) {
      case "INTRO":
        if (elapsed >= p.introMs) {
          this.roundStartAt = this.phaseStartedAt + p.introMs;
          this.transition("NEUTRAL", this.roundStartAt);
          this.update(now);
        }
        break;
      case "NEUTRAL":
      case "THREAT":
        this.sim.advanceTo(this.roundTime(now));
        if (this.phase === "NEUTRAL" && this.sim.t >= this.encounter.recognitionMs) {
          this.transition("THREAT", this.roundStartAt + this.encounter.recognitionMs);
        }
        if (this.sim.finished) this.resolve(this.roundStartAt + this.sim.t);
        break;
      case "RESOLUTION": {
        // クリッツブランクのQ (引き寄せ) / アリのE (魅了) で被弾したときは、その演出の分だけ長く止める
        const hold = p.resolutionMs + (this.sim.hitDisplacement()?.durationMs ?? 0);
        if (elapsed >= hold) this.transition("RESULT", this.phaseStartedAt + hold);
        break;
      }
      case "RESULT":
        if (elapsed >= p.resultMs) {
          const at = this.phaseStartedAt + p.resultMs;
          if (this.roundIndex + 1 >= this.encounters.length) {
            this.gameResult = aggregateResults(this.seed, this.results, this.cfg.scoring.maxPerRound);
            this.transition("COMPLETE", at);
            this.listener.onComplete?.(this.gameResult);
          } else {
            this.roundIndex++;
            this.sim = new RoundSimulation(this.encounter, this.simCfg);
            this.lastResult = null;
            this.transition("INTRO", at);
          }
        }
        break;
      case "COMPLETE":
        break;
    }
  }

  move(now: number, target: Vec2): void {
    if (this.acceptsInput) this.sim.move(this.roundTime(now), target);
  }

  flash(now: number, cursor: Vec2): FlashRecord | null {
    return this.acceptsInput ? this.sim.tryFlash(this.roundTime(now), cursor) : null;
  }

  /** 右クリック: 範囲内の敵ミニオンなら攻撃、それ以外は移動 */
  rightClick(now: number, pos: Vec2): AttackRecord | null {
    return this.acceptsInput ? this.sim.rightClick(this.roundTime(now), pos) : null;
  }

  /** 本命の採点 + CSボーナス (確定済みラウンド + 進行中ラウンドのCS) */
  get totalScore(): number {
    const done = this.results.reduce((s, r) => s + r.totalScore + r.csScore, 0);
    const live = this.lastResult === null && this.phase !== "COMPLETE" ? this.liveCsScore : 0;
    return done + live;
  }

  /** 進行中ラウンドのCSボーナス */
  get liveCsScore(): number {
    const o = this.sim.outcome();
    return csScore(o.csCount, o.csCannon, this.cfg.scoring);
  }

  private resolve(at: number): void {
    const result = evaluateRound(this.encounter, this.sim.outcome(), this.cfg.scoring);
    this.results.push(result);
    this.lastResult = result;
    this.transition("RESOLUTION", at);
    this.listener.onRoundResult?.(result);
  }

  private transition(to: RoundPhase, at: number): void {
    if (!TRANSITIONS[this.phase].includes(to)) {
      throw new Error(`Invalid round transition ${this.phase} -> ${to}`);
    }
    this.phase = to;
    this.phaseStartedAt = at;
    this.listener.onPhaseChange?.(to, this.roundIndex);
  }
}
