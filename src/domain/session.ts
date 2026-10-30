import { GAME_CONFIG, type GameConfig } from "../config/balance";
import { buildDeck } from "./encounters/deck";
import {
  ENCOUNTER_DEFINITIONS,
  getAnyDefinition,
  TAMAMO_REPLACEMENTS,
  TAMAMO_UNSUPPORTED,
  YONEKURA_REPLACEMENTS,
  YONEKURA_UNSUPPORTED,
} from "./encounters/definitions";
import { generateEncounter, type EncounterGenerationContext } from "./encounters/generators";
import { validateEncounter } from "./encounters/validation";
import { createRng, type SeededRandom } from "./rng";
import type { ChampionId, EncounterDefinition, GeneratedEncounter } from "./types";

/**
 * ラウンドの相手チャンピオンを抽選し、米倉/アリなら敵が撃つ攻撃の問題をそのキャラ版に差し替える。
 * そのキャラで出題できない問題 (UNSUPPORTED) なら既定の敵のまま。
 */
export function assignChampion(def: EncounterDefinition, seed: string, roundIndex: number, cfg: GameConfig): { def: EncounterDefinition; champion: ChampionId } {
  const roll = createRng(`${seed}:champion:${roundIndex}`).next();
  const { yonekura, tamamo } = cfg.champions.chances;
  const pick: ChampionId = roll < yonekura ? "yonekura" : roll < yonekura + tamamo ? "tamamo" : "default";
  const table = {
    yonekura: { unsupported: YONEKURA_UNSUPPORTED, replacements: YONEKURA_REPLACEMENTS },
    tamamo: { unsupported: TAMAMO_UNSUPPORTED, replacements: TAMAMO_REPLACEMENTS },
  } as const;
  if (pick === "default" || table[pick].unsupported.has(def.id)) return { def, champion: "default" };
  const replacement = table[pick].replacements[def.id];
  return { def: replacement ? getAnyDefinition(replacement) : def, champion: pick };
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
  const deck = buildDeck(ENCOUNTER_DEFINITIONS, createRng(`${seed}:deck`), cfg);
  const out: GeneratedEncounter[] = [];
  deck.forEach((deckDef, i) => {
    const prev = out[i - 1];
    const { def, champion } = assignChampion(deckDef, seed, i, cfg);
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
