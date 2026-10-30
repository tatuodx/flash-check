import { GAME_CONFIG, type GameConfig } from "../config/balance";
import { tryBuildDeck } from "./encounters/deck";
import { ENCOUNTER_DEFINITIONS, TAMAMO_DEFINITIONS, YONEKURA_DEFINITIONS } from "./encounters/definitions";
import { generateEncounter, type EncounterGenerationContext } from "./encounters/generators";
import { validateEncounter } from "./encounters/validation";
import { createRng, type SeededRandom } from "./rng";
import type { ChampionId, EncounterDefinition, GeneratedEncounter } from "./types";

const GANK_DEFINITIONS = ENCOUNTER_DEFINITIONS.filter((d) => d.gankers !== undefined);

/**
 * 相手ごとに出せる問題。米倉/アリは自分の技の問題とガンクの問題だけで、標準の技は撃たない。
 * ガンク (クリッツブランク / アッシュリー) の問題はレーンの相手が誰でも出せる
 */
const CHAMPION_POOLS: Record<ChampionId, ReadonlySet<string>> = {
  default: new Set(ENCOUNTER_DEFINITIONS.map((d) => d.id)),
  yonekura: new Set([...YONEKURA_DEFINITIONS, ...GANK_DEFINITIONS].map((d) => d.id)),
  tamamo: new Set([...TAMAMO_DEFINITIONS, ...GANK_DEFINITIONS].map((d) => d.id)),
};
const ALL_DEFINITIONS = [...ENCOUNTER_DEFINITIONS, ...YONEKURA_DEFINITIONS, ...TAMAMO_DEFINITIONS];

/** ラウンドの相手チャンピオンを抽選する (米倉 / アリ / 標準) */
export function rollChampion(rng: SeededRandom, cfg: GameConfig): ChampionId {
  const roll = rng.next();
  const { yonekura, tamamo } = cfg.champions.chances;
  return roll < yonekura ? "yonekura" : roll < yonekura + tamamo ? "tamamo" : "default";
}

/**
 * 10ラウンド分の相手と問題を、相手が出題できる問題だけから抽選する。
 * ガンクのラウンド数は毎ゲーム deck.gankRounds の範囲で抽選し、ガンクを出せるラウンド (Tierが合う) からその数だけ選ぶ
 */
export function buildChampionDeck(seed: string, cfg: GameConfig): { def: EncounterDefinition; champion: ChampionId }[] {
  const rng = createRng(`${seed}:deck`);
  const gankCount = rng.int(...cfg.deck.gankRounds);
  const gankable = cfg.roundTiers
    .map((tiers, i) => (ENCOUNTER_DEFINITIONS.some((d) => d.gankers && tiers.includes(d.difficulty)) ? i : -1))
    .filter((i) => i >= 0);
  for (let attempt = 0; attempt < cfg.deck.maxAttempts; attempt++) {
    const gankRounds = new Set(rng.shuffle(gankable).slice(0, gankCount));
    const champions: ChampionId[] = [];
    const deck = tryBuildDeck(ALL_DEFINITIONS, rng, cfg, (i, candidates) => {
      const fits = candidates.filter((d) => (d.gankers !== undefined) === gankRounds.has(i));
      // 抽選した相手がこのラウンドに出せる問題を持たなければ、もう一方のキャラ → 標準 の順に代える
      const rolled = rollChampion(rng, cfg);
      const order: ChampionId[] =
        rolled === "default" ? ["default"] : [rolled, rolled === "yonekura" ? "tamamo" : "yonekura", "default"];
      for (const champion of order) {
        const options = fits.filter((d) => CHAMPION_POOLS[champion].has(d.id));
        if (options.length === 0) continue;
        champions[i] = champion;
        return rng.pick(options);
      }
      return null;
    });
    if (deck) return deck.map((def, i) => ({ def, champion: champions[i] }));
  }
  throw new Error("Could not build a valid deck from the encounter pool");
}

/** 生成 -> Validation を繰り返し、回避可能な問題だけを返す */
export function generateValidated(
  def: EncounterDefinition,
  ctx: EncounterGenerationContext,
  rng: SeededRandom,
): GeneratedEncounter {
  let fallback: GeneratedEncounter | null = null;
  for (let i = 0; i < ctx.cfg.validation.maxAttempts; i++) {
    const enc = generateEncounter(def, ctx, rng);
    const v = validateEncounter(enc, ctx.cfg);
    if (v.ok && v.warnings.length === 0) return enc;
    if (v.ok && !fallback) fallback = enc;
  }
  if (fallback) return fallback;
  throw new Error(`Could not generate a valid ${def.id} (seed ${rng.seed})`);
}

export function buildEncounterSequence(seed: string, cfg: GameConfig = GAME_CONFIG): GeneratedEncounter[] {
  const out: GeneratedEncounter[] = [];
  buildChampionDeck(seed, cfg).forEach(({ def, champion }, i) => {
    const prev = out[i - 1];
    const ctx: EncounterGenerationContext = {
      roundIndex: i,
      difficultyBudget: cfg.difficultyBudget[i],
      prevSideEdge: prev?.gankers?.includes("kritz") ? prev.sideEdge : undefined,
      champion,
      cfg,
    };
    out.push(generateValidated(def, ctx, createRng(`${seed}:round:${i}:${def.id}`)));
  });
  return out;
}
