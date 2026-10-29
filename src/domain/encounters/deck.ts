import type { GameConfig } from "../../config/balance";
import type { SeededRandom } from "../rng";
import type { EncounterDefinition } from "../types";

export function deckViolations(deck: readonly EncounterDefinition[], cfg: GameConfig): string[] {
  const d = cfg.deck;
  const v: string[] = [];
  const count = (f: (e: EncounterDefinition) => boolean) => deck.filter(f).length;
  if (count((e) => e.expectedAction === "FLASH") < d.minFlash) v.push("too few FLASH rounds");
  if (count((e) => e.expectedAction === "MOVE") < d.minMove) v.push("too few MOVE rounds");
  if (count((e) => e.expectedAction === "WAIT") < d.minWait) v.push("too few WAIT rounds");
  if (count((e) => e.kind === "SIDE_GANK") < d.minSideGank) v.push("no SIDE_GANK round");
  if (count((e) => e.kind === "DIRECTIONAL_TRAP") < d.minDirectional) v.push("no DIRECTIONAL round");
  if (count((e) => e.kind === "FAKE_CAST") > d.maxFake) v.push("too many Fake rounds");
  if (new Set(deck.map((e) => e.id)).size !== deck.length) v.push("duplicate encounter id");
  let streak = 1;
  for (let i = 1; i < deck.length; i++) {
    streak = deck[i].kind === deck[i - 1].kind ? streak + 1 : 1;
    if (streak > d.maxSameKindStreak) v.push(`kind ${deck[i].kind} repeats more than ${d.maxSameKindStreak}x`);
    if (deck[i].expectedAction === "WAIT" && deck[i - 1].expectedAction === "WAIT") v.push("consecutive WAIT rounds");
    // 上下が固定のSide Gank (ENC-006) は、直前のSide Gankと同じ方向になり得るため連続させない
    if (deck[i].kind === "SIDE_GANK" && deck[i].parameters.edge !== undefined && deck[i - 1].kind === "SIDE_GANK") {
      v.push("fixed-edge side gank right after another side gank");
    }
  }
  deck.forEach((e, i) => {
    if (!cfg.roundTiers[i].includes(e.difficulty)) v.push(`round ${i + 1} tier mismatch`);
  });
  return v;
}

/** 09_ENCOUNTER_CATALOG 8章のカテゴリ保証/重複制御を満たす10ラウンドのデッキを抽選する */
export function buildDeck(pool: readonly EncounterDefinition[], rng: SeededRandom, cfg: GameConfig): EncounterDefinition[] {
  for (let attempt = 0; attempt < cfg.deck.maxAttempts; attempt++) {
    const deck: EncounterDefinition[] = [];
    for (let i = 0; i < cfg.roundCount; i++) {
      const tiers = cfg.roundTiers[i];
      const prev = deck[i - 1];
      const candidates = pool.filter(
        (e) =>
          tiers.includes(e.difficulty) &&
          !deck.some((d) => d.id === e.id) &&
          !(prev && prev.expectedAction === "WAIT" && e.expectedAction === "WAIT"),
      );
      if (candidates.length === 0) break;
      deck.push(rng.pick(candidates));
    }
    if (deck.length === cfg.roundCount && deckViolations(deck, cfg).length === 0) return deck;
  }
  throw new Error("Could not build a valid deck from the encounter pool");
}
