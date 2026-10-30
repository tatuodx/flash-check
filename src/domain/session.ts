import { GAME_CONFIG, type GameConfig } from "../config/balance";
import { tryBuildDeck } from "./encounters/deck";
import {
  ENCOUNTER_DEFINITIONS,
  getAnyDefinition,
  TAMAMO_REPLACEMENTS,
  YONEKURA_REPLACEMENTS,
} from "./encounters/definitions";
import { generateEncounter, type EncounterGenerationContext } from "./encounters/generators";
import { validateEncounter } from "./encounters/validation";
import { createRng, type SeededRandom } from "./rng";
import type { ChampionId, EncounterDefinition, GeneratedEncounter } from "./types";

const REPLACEMENTS: Record<Exclude<ChampionId, "default">, Record<string, string>> = {
  yonekura: YONEKURA_REPLACEMENTS,
  tamamo: TAMAMO_REPLACEMENTS,
};

/** ラウンドの相手チャンピオンを抽選する (米倉 / アリ / 標準) */
export function rollChampion(rng: SeededRandom, cfg: GameConfig): ChampionId {
  const roll = rng.next();
  const { yonekura, tamamo } = cfg.champions.chances;
  return roll < yonekura ? "yonekura" : roll < yonekura + tamamo ? "tamamo" : "default";
}

/**
 * その相手で出題できる問題か。米倉/アリは自分の技に差し替えた問題だけを出し、標準の技は撃たない。
 * ガンク (クリッツブランク) の問題は、レーンの相手が誰でも出せる
 */
export function championSupports(champion: ChampionId, def: EncounterDefinition): boolean {
  return champion === "default" || def.ganker !== undefined || REPLACEMENTS[champion][def.id] !== undefined;
}

/** 問題をその相手の版に差し替える (ガンクの問題はそのまま) */
export function championVersion(champion: ChampionId, def: EncounterDefinition): EncounterDefinition {
  if (champion === "default") return def;
  const replacement = REPLACEMENTS[champion][def.id];
  if (replacement) return getAnyDefinition(replacement);
  if (def.ganker !== undefined) return def;
  throw new Error(`${champion} cannot present ${def.id}`);
}

/** 10ラウンド分の相手と問題を、相手が出題できる問題だけから抽選する */
export function buildChampionDeck(seed: string, cfg: GameConfig): { def: EncounterDefinition; champion: ChampionId }[] {
  const rng = createRng(`${seed}:deck`);
  for (let attempt = 0; attempt < cfg.deck.maxAttempts; attempt++) {
    const champions = Array.from({ length: cfg.roundCount }, () => rollChampion(rng, cfg));
    const deck = tryBuildDeck(ENCOUNTER_DEFINITIONS, rng, cfg, (def, i) => championSupports(champions[i], def));
    if (deck) return deck.map((def, i) => ({ def: championVersion(champions[i], def), champion: champions[i] }));
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
      prevSideEdge: prev?.kind === "SIDE_GANK" ? prev.sideEdge : undefined,
      champion,
      cfg,
    };
    out.push(generateValidated(def, ctx, createRng(`${seed}:round:${i}:${def.id}`)));
  });
  return out;
}
