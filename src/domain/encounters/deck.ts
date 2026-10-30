import type { GameConfig } from "../../config/balance";
import type { SeededRandom } from "../rng";
import type { EncounterDefinition } from "../types";

export function deckViolations(deck: readonly EncounterDefinition[], cfg: GameConfig): string[] {
  const d = cfg.deck;
  const v: string[] = [];
  const count = (f: (e: EncounterDefinition) => boolean) => deck.filter(f).length;
  if (count((e) => e.expectedAction === "FLASH") < d.minFlash) v.push("too few FLASH rounds");
  if (count((e) => e.expectedAction === "MOVE") < d.minMove) v.push("too few MOVE rounds");
  if (count((e) => e.kind === "SIDE_GANK") < d.minSideGank) v.push("no SIDE_GANK round");
  if (count((e) => e.kind === "DIRECTIONAL_TRAP") < d.minDirectional) v.push("no DIRECTIONAL round");
  if (count((e) => e.kind === "FAKE_CAST") > d.maxFake) v.push("too many Fake rounds");
  if (new Set(deck.map((e) => e.id)).size !== deck.length) v.push("duplicate encounter id");
  let streak = 1;
  for (let i = 1; i < deck.length; i++) {
    streak = deck[i].kind === deck[i - 1].kind ? streak + 1 : 1;
    if (streak > d.maxSameKindStreak) v.push(`kind ${deck[i].kind} repeats more than ${d.maxSameKindStreak}x`);
  }
  deck.forEach((e, i) => {
    if (!cfg.roundTiers[i].includes(e.difficulty)) v.push(`round ${i + 1} tier mismatch`);
  });
  return v;
}

/** 09_ENCOUNTER_CATALOG 8章のカテゴリ保証/重複制御を満たす10ラウンドのデッキを抽選する */
export function buildDeck(pool: readonly EncounterDefinition[], rng: SeededRandom, cfg: GameConfig): EncounterDefinition[] {
  for (let attempt = 0; attempt < cfg.deck.maxAttempts; attempt++) {
    const deck = tryBuildDeck(pool, rng, cfg);
    if (deck) return deck;
  }
  throw new Error("Could not build a valid deck from the encounter pool");
}

/**
 * デッキを1回だけ抽選する。満たせなければ null。
 * pickRound でラウンドごとの選び方を差し替えられる (相手チャンピオンを決めて、その相手が出題できる問題から選ぶ等)。
 * 渡す候補は「Tierが合い、まだデッキにない問題」
 */
export function tryBuildDeck(
  pool: readonly EncounterDefinition[],
  rng: SeededRandom,
  cfg: GameConfig,
  pickRound: (roundIndex: number, candidates: EncounterDefinition[]) => EncounterDefinition | null = (_i, c) => (c.length ? rng.pick(c) : null),
): EncounterDefinition[] | null {
  const deck: EncounterDefinition[] = [];
  for (let i = 0; i < cfg.roundCount; i++) {
    const tiers = cfg.roundTiers[i];
    const candidates = pool.filter((e) => tiers.includes(e.difficulty) && !deck.some((d) => d.id === e.id));
    const picked = pickRound(i, candidates);
    if (!picked) return null;
    deck.push(picked);
  }
  return deckViolations(deck, cfg).length === 0 ? deck : null;
}
