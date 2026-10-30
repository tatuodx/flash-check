import type { EncounterDefinition } from "../types";

// parameters の [a, b] は [Easy, Hard] の範囲。Difficulty budgetにより補間して抽選する。
// 値は暫定値 (09_ENCOUNTER_CATALOG) でプレイテストにより調整する。

export const ENCOUNTER_DEFINITIONS: EncounterDefinition[] = [
  // ---- Tier 1 ----
  {
    id: "ENC-001",
    name: "Front Fast Line",
    kind: "STRAIGHT_FAST",
    expectedAction: "FLASH",
    difficulty: 1,
    durationRangeMs: [5_000, 9_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 300, goodMs: 450, lateMs: 650 },
    parameters: { leadMs: [280, 200], speed: [900, 1100], width: [80, 105] },
  },
  {
    id: "ENC-002",
    name: "Front Slow Line",
    kind: "STRAIGHT_SLOW",
    expectedAction: "MOVE",
    difficulty: 1,
    durationRangeMs: [6_000, 11_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 450, goodMs: 700, lateMs: 1_000 },
    parameters: { leadMs: [520, 420], speed: [300, 380], width: [90, 110] },
  },
  {
    id: "ENC-003",
    name: "Delayed Circle",
    kind: "CIRCLE_DELAYED",
    expectedAction: "MOVE",
    difficulty: 1,
    durationRangeMs: [6_000, 12_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 300, goodMs: 500, lateMs: 750 },
    parameters: { radius: [85, 100], delayMs: [1_250, 1_000] },
  },
  {
    id: "ENC-004",
    name: "Harmless Cast",
    kind: "FAKE_CAST",
    expectedAction: "WAIT",
    difficulty: 1,
    durationRangeMs: [5_000, 10_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 0, goodMs: 0, lateMs: 0 },
    parameters: { castMs: [700, 500] },
  },
  // ---- Tier 2 ----
  {
    id: "ENC-008",
    name: "Fast Circle Trap",
    kind: "CIRCLE_DELAYED",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [7_000, 13_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 200, goodMs: 330, lateMs: 480 },
    parameters: { radius: [115, 130], delayMs: [720, 520] },
  },
  {
    id: "ENC-010",
    name: "Dash Through",
    kind: "DASH",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [7_000, 12_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 260, goodMs: 400, lateMs: 560 },
    parameters: { leadMs: [300, 220], speed: [1_500, 1_800], width: [76, 90], overshoot: 170, endBurstRadius: 60 },
  },
  {
    id: "ENC-012",
    name: "Two Lane Choices",
    kind: "DIRECTIONAL_TRAP",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [8_000, 15_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 280, goodMs: 420, lateMs: 600 },
    parameters: { leadMs: [340, 260], speed: [1_300, 1_500], width: [76, 90], narrowGap: [54, 44] },
  },
  {
    id: "ENC-013",
    name: "Moving Aim Line",
    kind: "STRAIGHT_FAST",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [9_000, 15_000],
    recognitionOffsetMs: 800, // 実際のTracking時間はgeneratorで抽選
    timingWindow: { excellentMs: 300, goodMs: 450, lateMs: 650 },
    parameters: { trackMs: [800, 550], lockToLaunchMs: [260, 200], speed: [1_000, 1_200], width: [80, 95] },
  },
  {
    id: "ENC-015",
    name: "Slow Projectile with Distraction",
    kind: "STRAIGHT_SLOW",
    expectedAction: "MOVE",
    difficulty: 2,
    durationRangeMs: [10_000, 16_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 450, goodMs: 700, lateMs: 1_000 },
    parameters: { leadMs: [480, 400], speed: [340, 420], width: [90, 110] },
  },
  // ---- Tier 3 ----
  {
    id: "ENC-017",
    name: "Crossing Projectiles",
    kind: "DIRECTIONAL_TRAP",
    expectedAction: "FLASH",
    difficulty: 3,
    durationRangeMs: [10_000, 17_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 300, goodMs: 450, lateMs: 650 },
    parameters: { leadMs: [360, 280], speed: [1_100, 1_300], width: [75, 90], crossAngleDeg: [60, 120] },
  },
  {
    id: "ENC-020",
    name: "Target Marker Then Strike",
    kind: "CIRCLE_DELAYED",
    expectedAction: "FLASH",
    difficulty: 3,
    durationRangeMs: [10_000, 18_000],
    recognitionOffsetMs: 900, // 実際のTracking時間はgeneratorで抽選
    timingWindow: { excellentMs: 220, goodMs: 350, lateMs: 500 },
    parameters: { trackMs: [900, 550], detonateAfterLockMs: [700, 520], radius: [110, 125] },
  },
  {
    id: "ENC-021",
    name: "Safe Gap Sweep",
    kind: "DIRECTIONAL_TRAP",
    expectedAction: "FLASH",
    difficulty: 3,
    durationRangeMs: [12_000, 18_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 300, goodMs: 450, lateMs: 650 },
    parameters: { leadMs: [480, 320], speed: [1_200, 1_400], gapDiameters: [4, 2.5], thickness: 40 },
  },
  // ---- クリッツブランク (ガンク専用の敵) ------------------------------------------
  // レーンの相手とは別に、川の陰から来る。Q (グラブ) を出題し、W (加速) で近づく姿を予兆にする。
  // Qは範囲を表示しない。当たると引き寄せられる
  {
    id: "KRZ-Q",
    name: "クリッツブランク Q",
    kind: "SIDE_GANK",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [8_000, 14_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 280, goodMs: 420, lateMs: 600 },
    // APPROACH: Wで近づいて止まる距離 / AMBUSH: 陰の中に潜む距離
    parameters: { stopDistance: [255, 235], ambushDistance: [365, 375], windupMs: [220, 200] },
  },
  {
    id: "KRZ-Q-FAR",
    name: "クリッツブランク 遠いQ",
    kind: "SIDE_GANK",
    expectedAction: "MOVE",
    difficulty: 2,
    durationRangeMs: [8_000, 14_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 320, goodMs: 480, lateMs: 680 },
    parameters: { stopDistance: [355, 340], windupMs: [300, 280] },
  },
  {
    id: "KRZ-W",
    name: "クリッツブランク W (近づくだけ)",
    kind: "SIDE_GANK",
    expectedAction: "WAIT",
    difficulty: 2,
    durationRangeMs: [9_000, 15_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 0, goodMs: 0, lateMs: 0 },
    parameters: { stopDistance: [370, 340], waitMs: [800, 500], passDx: [380, 330] },
  },
  {
    id: "ENC-024",
    name: "Hold Your Flash",
    kind: "FAKE_CAST",
    expectedAction: "WAIT",
    difficulty: 3,
    durationRangeMs: [12_000, 20_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 0, goodMs: 0, lateMs: 0 },
    parameters: { fakeCount: [2, 3] },
  },
];

export function getDefinition(id: string): EncounterDefinition {
  const def = ENCOUNTER_DEFINITIONS.find((d) => d.id === id);
  if (!def) throw new Error(`Unknown encounter ${id}`);
  return def;
}

// ---- 米倉 (相手チャンピオン) の出題 ---------------------------------------------
// 敵が撃つ攻撃の問題を、米倉のラウンドではこれらに差し替える (YONEKURA_REPLACEMENTS)。
// Q1/Q2は演出のみで出題しない。Q3は直前にQ1/Q2の演出で「溜まった」ことを見せる。

export const YONEKURA_DEFINITIONS: EncounterDefinition[] = [
  {
    id: "YNK-Q3",
    name: "米倉 Q3 突風の突進",
    kind: "DASH",
    expectedAction: "FLASH",
    difficulty: 1,
    durationRangeMs: [7_000, 11_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 260, goodMs: 400, lateMs: 560 },
    parameters: { leadMs: [340, 260], speed: [1_500, 1_800], width: [80, 95] },
  },
  {
    id: "YNK-R",
    name: "米倉 R 一閃",
    kind: "STRAIGHT_FAST",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [7_000, 12_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 300, goodMs: 450, lateMs: 650 },
    parameters: { leadMs: [650, 500], speed: [5_000, 5_000], width: [120, 135] },
  },
  {
    id: "YNK-EQ3",
    name: "米倉 E→Q3",
    kind: "DASH",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [9_000, 15_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 260, goodMs: 400, lateMs: 560 },
    parameters: { leadMs: [420, 380], speed: [1_500, 1_800], width: [80, 95], eOut: [130, 160], eToSkillMs: [450, 300] },
  },
  {
    id: "YNK-ER",
    name: "米倉 E→R",
    kind: "DIRECTIONAL_TRAP",
    expectedAction: "FLASH",
    difficulty: 3,
    durationRangeMs: [10_000, 17_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 300, goodMs: 450, lateMs: 650 },
    parameters: { leadMs: [600, 480], speed: [5_000, 5_000], width: [120, 135], eOut: [130, 160], eToSkillMs: [450, 300] },
  },
  {
    id: "YNK-E",
    name: "米倉 E (踏み込みのみ)",
    kind: "FAKE_CAST",
    expectedAction: "WAIT",
    difficulty: 1,
    durationRangeMs: [5_000, 10_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 0, goodMs: 0, lateMs: 0 },
    parameters: { eOut: [130, 160], stayMs: [900, 1_300] },
  },
  {
    id: "YNK-E2",
    name: "米倉 E を二度見せる",
    kind: "FAKE_CAST",
    expectedAction: "WAIT",
    difficulty: 3,
    durationRangeMs: [12_000, 20_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 0, goodMs: 0, lateMs: 0 },
    parameters: { eOut: [130, 160], stayMs: [900, 1_300] },
  },
];

/** 米倉のラウンドで差し替える問題 (既定ID -> 米倉ID)。ここにない「敵が撃つMOVE問題」は既定の敵のまま */
export const YONEKURA_REPLACEMENTS: Record<string, string> = {
  "ENC-001": "YNK-Q3",
  "ENC-010": "YNK-R",
  "ENC-013": "YNK-EQ3",
  "ENC-017": "YNK-ER",
  "ENC-004": "YNK-E",
  "ENC-024": "YNK-E2",
};

/** 米倉では出題できない問題 (Q1/Q2を出題しない方針のため、敵が撃つMOVE問題) */
export const YONEKURA_UNSUPPORTED = new Set(["ENC-002", "ENC-015"]);

// ---- アリ (相手チャンピオン) の出題 -----------------------------------------------
// E (魅了) を出題し、R (最大3回の短いダッシュ、当たり判定なし) で接近とEのタイミングを読みにくくする。
// Eは範囲を表示しない。R の回数は問題ごとに抽選する (parameters.rCount = [最小, 最大])

export const TAMAMO_DEFINITIONS: EncounterDefinition[] = [
  {
    id: "TMM-RE",
    name: "アリ R接近→E",
    kind: "STRAIGHT_FAST",
    expectedAction: "FLASH",
    difficulty: 1,
    durationRangeMs: [7_000, 12_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 280, goodMs: 420, lateMs: 600 },
    // inDistance: 最後のRで近づく距離 / rToEMs: 着地からEの詠唱まで
    parameters: { rCount: [1, 3], inDistance: [225, 195], rToEMs: [450, 120], windupMs: [250, 220] },
  },
  {
    id: "TMM-E-FAR",
    name: "アリ 遠いE",
    kind: "STRAIGHT_SLOW",
    expectedAction: "MOVE",
    difficulty: 1,
    durationRangeMs: [7_000, 12_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 320, goodMs: 480, lateMs: 680 },
    // Rは横か後ろへの位置取りだけ。最後のRで outDistance まで離れる (0回なら追従レンジのまま)
    parameters: { rCount: [0, 2], outDistance: [330, 310], rToEMs: [700, 300], windupMs: [260, 250] },
  },
  {
    id: "TMM-RRE",
    name: "アリ R揺さぶり→E",
    kind: "STRAIGHT_FAST",
    expectedAction: "FLASH",
    difficulty: 2,
    durationRangeMs: [9_000, 15_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 280, goodMs: 420, lateMs: 600 },
    parameters: { rCount: [2, 3], inDistance: [220, 190], rGapMs: [1_100, 500], rToEMs: [500, 100], windupMs: [240, 220] },
  },
  {
    id: "TMM-RBACK",
    name: "アリ R接近→R後退→E",
    kind: "STRAIGHT_SLOW",
    expectedAction: "MOVE",
    difficulty: 2,
    durationRangeMs: [9_000, 15_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 320, goodMs: 480, lateMs: 680 },
    parameters: { inDistance: [200, 185], backDistance: [320, 305], rGapMs: [900, 450], rToEMs: [600, 250], windupMs: [260, 250] },
  },
  {
    id: "TMM-RBACK-F",
    name: "アリ R接近→R後退→R再接近→E",
    kind: "DIRECTIONAL_TRAP",
    expectedAction: "FLASH",
    difficulty: 3,
    durationRangeMs: [10_000, 17_000],
    recognitionOffsetMs: 0,
    timingWindow: { excellentMs: 280, goodMs: 420, lateMs: 600 },
    parameters: { inDistance: [215, 190], backDistance: [315, 300], rGapMs: [800, 400], rToEMs: [400, 100], windupMs: [240, 215] },
  },
];

/** アリのラウンドで差し替える問題 (既定ID -> アリID) */
export const TAMAMO_REPLACEMENTS: Record<string, string> = {
  "ENC-001": "TMM-RE",
  "ENC-002": "TMM-E-FAR",
  "ENC-013": "TMM-RRE",
  "ENC-015": "TMM-RBACK",
  "ENC-017": "TMM-RBACK-F",
};

/** アリでは出題しない問題 (Rだけのフェイクは作らない方針のためWAIT問題、Eで再現しない突進) */
export const TAMAMO_UNSUPPORTED = new Set(["ENC-004", "ENC-024", "ENC-010"]);

export function getAnyDefinition(id: string): EncounterDefinition {
  const def = [...ENCOUNTER_DEFINITIONS, ...YONEKURA_DEFINITIONS, ...TAMAMO_DEFINITIONS].find((d) => d.id === id);
  if (!def) throw new Error(`Unknown encounter ${id}`);
  return def;
}
