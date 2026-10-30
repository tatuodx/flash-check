export type Vec2 = { x: number; y: number };

export type PlayerAction = "FLASH" | "MOVE" | "WAIT";

export type RoundPhase = "INTRO" | "NEUTRAL" | "THREAT" | "RESOLUTION" | "RESULT" | "COMPLETE";

export type EncounterKind =
  | "STRAIGHT_FAST"
  | "STRAIGHT_SLOW"
  | "CIRCLE_DELAYED"
  | "DASH"
  | "SIDE_GANK"
  | "FAKE_CAST"
  | "DIRECTIONAL_TRAP";

export type Edge = "TOP" | "BOTTOM";

/** 相手チャンピオン。default = 初期の敵、yonekura = 米倉 (二刀の剣士モチーフ)、tamamo = アリ (九尾の狐モチーフ) */
export type ChampionId = "default" | "yonekura" | "tamamo";

/** ガンク専用の敵 (レーンの相手とは別に横から来る)。kritz = クリッツブランク (蒸気ロボのグラブ使いモチーフ) */
export type GankerId = "kritz";

export type Range = [number, number];

export interface TimingWindow {
  excellentMs: number;
  goodMs: number;
  lateMs: number;
}

export interface EncounterDefinition {
  id: string;
  name: string;
  kind: EncounterKind;
  expectedAction: PlayerAction;
  /** Tier (1-4) */
  difficulty: number;
  durationRangeMs: Range;
  /** Telegraph開始からRecognitionまでのオフセット (Lock型はTracking時間) */
  recognitionOffsetMs: number;
  timingWindow: TimingWindow;
  parameters: Record<string, unknown>;
  /** ガンク専用の敵の問題 (レーンの相手が誰でも出題できる) */
  ganker?: GankerId;
}

// ---- Scheduled events -------------------------------------------------------

export type LineOrigin =
  | { mode: "ENEMY" }
  | { mode: "EDGE"; edge: Edge; dxFromAnchor: number }
  /**
   * 敵 -> anchor の向きを angleRad 回した方向から anchor へ飛ぶよう、画面端 (edge) に発射点を置く。
   * 敵の位置は実行時に決まるため、交差角を保つにはこの方式で実行時に計算する
   */
  | { mode: "CROSS"; edge: Edge; angleRad: number }
  /** ガンク役 (クリッツブランク) の現在位置 */
  | { mode: "GANKER" };

export type LineAim =
  | { mode: "ANCHOR"; angleJitterRad: number }
  | { mode: "FIXED_DIR"; dir: Vec2 }
  /** lockAtMsまでLive Playerを追尾し、その時点で方向を固定 */
  | { mode: "TRACK"; lockAtMs: number };

export interface LineShotPayload {
  type: "LINE_SHOT";
  origin: LineOrigin;
  aim: LineAim;
  launchAtMs: number;
  width: number;
  speed: number;
  bodyLength: number;
  maxTravel: number;
  /** 発射元の敵が詠唱モーション(glow)を見せるか */
  enemyCast: boolean;
  /**
   * 見た目: hook = クリッツブランクのQ (範囲を表示せず、腕と鎖だけが見える)
   * / charm = アリのE (範囲を表示せず、飛んでいくハートだけが見える)
   */
  style?: "hook" | "charm";
}

export type CircleCenter =
  | { mode: "ANCHOR"; offset: Vec2 }
  | { mode: "TRACK"; lockAtMs: number };

export interface CirclePayload {
  type: "CIRCLE";
  center: CircleCenter;
  radius: number;
  detonateAtMs: number;
}

export interface DashPayload {
  type: "DASH";
  startAtMs: number;
  speed: number;
  /** 軌道Hitboxの幅 (直径) */
  width: number;
  /** anchorを越えて進む距離 (length未指定時) */
  overshoot: number;
  /** 指定時は、発射位置から固定距離だけ進む (米倉のQ3/R) */
  length?: number;
  /** 見た目: 通常のDash / 米倉Q3 (突風の突進) / 米倉R (一閃) */
  style?: "dash" | "q3" | "r";
  harmful: boolean;
  endBurst?: { radius: number; delayAfterArrivalMs: number };
}

export interface SweepPayload {
  type: "SWEEP";
  /** anchor.xからの開始位置 (+は敵側) */
  startXOffset: number;
  launchAtMs: number;
  speed: number;
  thickness: number;
  gapOffsetY: number;
  gapWidth: number;
}

export interface FakeCastPayload {
  type: "FAKE_CAST";
  durationMs: number;
}

export interface StepInPayload {
  type: "STEP_IN";
  distance: number;
  durationMs: number;
}

export interface EdgeShadowPayload {
  type: "EDGE_SHADOW";
  edge: Edge;
  x: number;
  durationMs: number;
}

/**
 * 米倉E: 魂だけが前へ出て、returnAtMsに体の位置へ戻る。E自体に当たり判定はない。
 * 前へ出る距離は実行時にPlayerとの距離で縮める (近すぎないように)
 */
export interface YoneEPayload {
  type: "YONE_E";
  outDistance: number;
  outMs: number;
  /** 体へ戻り始める時刻 (Round相対) */
  returnAtMs: number;
  returnMs: number;
}

/** 米倉Q1/Q2: 近くの相手ミニオンを突く演出 (出題ではない。当たり判定もダメージもなし) */
export interface YoneQVisualPayload {
  type: "YONE_Q_VISUAL";
  stack: 1 | 2;
  durationMs: number;
}

/**
 * クリッツブランクの出現と移動。位置は出現時点のPlayer位置から実行時に決める。
 * - APPROACH: 陰からW (加速) で近づき、止まる位置で待つ (Qはこの後のLINE_SHOTで撃つ)
 * - AMBUSH: 陰の中に潜んだまま動かない (陰からいきなりQ)
 * - RETREAT: Wで近づいて止まり、leaveAfterMs後に出現位置 (陰) へ歩いて戻る (Qは撃たない)
 * - PASS: Wで反対側の陰へレーンを横切る (こちらには向かわない)
 */
export interface GankerPayload {
  type: "GANKER";
  ganker: GankerId;
  route: "APPROACH" | "AMBUSH" | "RETREAT" | "PASS";
  edge: Edge;
  /** 止まる位置 = Player + stopDistance * (cos, edge側へsin)。AMBUSHは陰の中でPlayerからこの距離 */
  stopAngleRad: number;
  stopDistance: number;
  /** APPROACH/RETREAT: 出現位置のx = 止まる位置.x + spawnDx / PASS: Player.x + spawnDx */
  spawnDx: number;
  /** W (加速) の持続時間 (出現から) */
  hasteMs: number;
  /** RETREAT: 出現から何ms後に陰へ戻り始めるか */
  leaveAfterMs?: number;
}

/**
 * アリR: 当たり判定のない短いダッシュ (1ラウンド最大3回)。
 * 着地点は実行時に「Player -> アリ の向きを bearingRad 回した方向・Playerから toDistance」とし、
 * 届かない場合は最大距離だけ進む
 */
export interface TamamoRPayload {
  type: "TAMAMO_R";
  toDistance: number;
  bearingRad: number;
}

export interface FakeMarkerPayload {
  type: "FAKE_MARKER";
  durationMs: number;
}



export type HazardPayload = LineShotPayload | CirclePayload | DashPayload | SweepPayload;

export type EventPayload =
  | HazardPayload
  | FakeCastPayload
  | StepInPayload
  | EdgeShadowPayload
  | FakeMarkerPayload
  | YoneEPayload
  | YoneQVisualPayload
  | GankerPayload
  | TamamoRPayload;

export type EventType = EventPayload["type"];

export interface ScheduledEvent {
  /** Round開始からの相対時刻。Hazardの場合はTelegraph表示開始時刻 */
  atMs: number;
  type: EventType;
  isMainThreat: boolean;
  payload: EventPayload;
}


export type MinionKind = "melee" | "cannon";
export type Team = "ally" | "enemy";

/** レーン中央で戦うミニオン (生成時に体力の推移が決まる) */
export interface MinionSpec {
  id: number;
  team: Team;
  kind: MinionKind;
  pos: Vec2;
  maxHp: number;
  startHp: number;
  /** 相手側のミニオンが1体以上生きている間、毎秒減る体力 */
  drainPerSec: number;
}

export interface GeneratedEncounter {
  definitionId: string;
  /** このラウンドの相手チャンピオン */
  champion: ChampionId;
  /** このラウンドで横から来るガンク役 (いなければ undefined) */
  ganker?: GankerId;
  name: string;
  kind: EncounterKind;
  seed: string;
  roundIndex: number;
  difficultyBudget: number;
  roundDurationMs: number;
  /** 本命 (Fakeラウンドでは最初のFake) の開始時刻 */
  threatStartMs: number;
  /** 反応時間の基準 (予定値)。実行時は描画された時刻で上書きされ得る */
  recognitionMs: number;
  /** Lock型: この時刻以降recognition前の行動はearly扱い */
  earlyWindowStartMs?: number;
  playerSpawn: Vec2;
  enemySpawns: Vec2[];
  minions: MinionSpec[];
  events: ScheduledEvent[];
  expectedAction: PlayerAction;
  timingWindow: TimingWindow;
  idealMargin: number;
  /** Anchorからの理想的な退避ベクトル。画面外になる場合は実行時に鏡像化する */
  safeHint?: Vec2;
  variantId?: string;
  sideEdge?: Edge;
}

// ---- Records / results ------------------------------------------------------

export interface FlashRecord {
  timestampMs: number;
  before: Vec2;
  cursor: Vec2;
  after: Vec2;
  distance: number;
  direction: Vec2;
}

export interface MoveRecord {
  timestampMs: number;
  target: Vec2;
}

export type ResultLabel =
  | "PERFECT"
  | "GOOD"
  | "LATE"
  | "EARLY"
  | "HIT"
  | "WASTED FLASH"
  | "WRONG DIRECTION"
  | "GOOD HOLD"
  | "SURVIVED";

export interface RoundResult {
  roundIndex: number;
  encounterId: string;
  encounterName: string;
  variantId?: string;
  champion: ChampionId;
  ganker?: GankerId;
  survived: boolean;
  expectedAction: PlayerAction;
  playerAction: PlayerAction;
  reactionTimeMs?: number;
  early: boolean;
  wastedFlash: boolean;
  decisionScore: number;
  timingScore: number;
  executionScore: number;
  totalScore: number;
  label: ResultLabel;
  flash?: FlashRecord;
  /** このラウンドでラストヒットしたミニオン数 */
  csCount: number;
  csCannon: number;
  /** CSボーナス (totalScoreとは別枠) */
  csScore: number;
}

export interface GameResult {
  seed: string;
  /** 本命の採点 + CSボーナス */
  totalScore: number;
  /** 本命の採点の合計 (最大 roundCount x 1000) */
  mainScore: number;
  csScore: number;
  /** 本命の採点の最大値 */
  maxScore: number;
  averageReactionMs?: number;
  bestReactionMs?: number;
  perfectCount: number;
  hitCount: number;
  wastedFlashCount: number;
  csCount: number;
  rounds: RoundResult[];
}
