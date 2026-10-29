import type { GameResult, RoundResult } from "./types";

const PERFECT_LABELS = new Set(["PERFECT", "GOOD HOLD"]);

export function aggregateResults(seed: string, rounds: readonly RoundResult[], maxPerRound: number): GameResult {
  const reactions = rounds.map((r) => r.reactionTimeMs).filter((v): v is number => v !== undefined);
  const mainScore = rounds.reduce((s, r) => s + r.totalScore, 0);
  const csScore = rounds.reduce((s, r) => s + r.csScore, 0);
  return {
    seed,
    totalScore: mainScore + csScore,
    mainScore,
    csScore,
    maxScore: rounds.length * maxPerRound,
    averageReactionMs: reactions.length ? Math.round(reactions.reduce((a, b) => a + b, 0) / reactions.length) : undefined,
    bestReactionMs: reactions.length ? Math.min(...reactions) : undefined,
    perfectCount: rounds.filter((r) => PERFECT_LABELS.has(r.label)).length,
    hitCount: rounds.filter((r) => !r.survived).length,
    wastedFlashCount: rounds.filter((r) => r.wastedFlash).length,
    csCount: rounds.reduce((s, r) => s + r.csCount, 0),
    rounds: rounds.slice(),
  };
}

/** 表示演出用Combo (倍率なし): 正しい判断で生存したラウンドの連続数 */
export function currentCombo(rounds: readonly RoundResult[], fullDecision: number): number {
  let n = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (!rounds[i].survived || rounds[i].decisionScore < fullDecision) break;
    n++;
  }
  return n;
}
