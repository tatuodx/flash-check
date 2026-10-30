// すべてのバランス値をここへ集約する。数値は本ゲームのworld scale (1000x600) に合わせた暫定値で、
// 外部ゲームの内部数値は流用していない。プレイテストで調整すること。

export const GAME_CONFIG = {
  roundCount: 10,
  roundDurationMs: {
    min: 5_000,
    max: 20_000,
  },
  /** 本命Threatの最も早い開始時刻 (Round開始からの相対ms) */
  minThreatStartMs: 1_500,
  phases: {
    introMs: 500,
    /** 被弾/回避確定後、Result Overlayを出すまでのヒットストップ */
    resolutionMs: 350,
    resultMs: 1_400,
  },
  world: {
    width: 1000,
    height: 600,
    lane: { top: 170, bottom: 430 },
    river: { topEdge: 110, bottomEdge: 490 },
    /** レーン上下の川 (見た目)。中心線 x = centerX + amplitude * sin((y - 300) / period) */
    riverPath: { centerX: 500, amplitude: 45, period: 190 },
    vision: {
      /** これより上 (y小) / 下 (y大) は陰 = 視界なし */
      shadeTop: 114,
      shadeBottom: 486,
      /**
       * ブッシュ (楕円, ゲーム座標)。上下の川がジャングルの切れ目を通る位置に、川を横切る向きで置く。
       * ブッシュ内は陰より優先: 自分が同じブッシュに入っていれば見える
       */
      brushes: [
        { id: "river-top", x: 460, y: 4, rx: 140, ry: 30 },
        { id: "river-bottom", x: 537, y: 558, rx: 140, ry: 30 },
      ],
    },
  },
  player: {
    radius: 18,
    moveSpeed: 180, // units/sec
    spawn: { x: [260, 340] as [number, number], y: [260, 340] as [number, number] },
  },
  enemy: {
    radius: 20,
    spawn: { x: [560, 620] as [number, number], y: [260, 340] as [number, number] },
    /**
     * 相手チャンピオンの移動AI。ランダムな目的地へ歩くが、目的地は常に
     * 「Playerから keepRange の距離・Playerの正面 (右) ±sectorDeg の扇形・レーン内」から選ぶ。
     */
    ai: {
      speed: 150,
      keepRange: [200, 330] as [number, number],
      sectorDeg: 40,
      /** 目的地を選び直す間隔 */
      decisionMs: [700, 1600] as [number, number],
      /** 目的地を選んだとき、その場で様子見する確率 */
      idleChance: 0.25,
      /** レーン端からの余白 (この内側だけを歩く) */
      laneMargin: 20,
      /** 本命の予兆の何ms前から立ち止まるか (発射位置が動かないように) */
      holdBeforeThreatMs: 400,
      /** Fake詠唱の何ms前から立ち止まるか */
      holdBeforeFakeMs: 300,
      /**
       * 敵が撃つ攻撃は、敵が追従レンジの最短距離にいても「予兆が見えてから当たるまで」がこの時間以上になるよう、
       * 生成時に予兆時間を延ばす (Flash問題)。歩き問題は「反応 + 歩いて抜ける時間 + 余裕」を確保する
       */
      minFlashWindowMs: 380,
      moveWindowMarginMs: 150,
    },
  },
  flash: {
    maxDistance: 180,
    usesPerRound: 1,
  },
  /** 相手チャンピオン */
  champions: {
    /** ラウンドごとの相手の抽選確率 (残りは標準) */
    chances: { yonekura: 0.45, tamamo: 0.45 },
    yonekura: {
      name: "米倉",
      /** Q3 (突風の突進) の固定距離・R (一閃) の固定距離 */
      q3Length: 440,
      rLength: 560,
      /** E: 魂が前へ出る時間・戻る時間・Playerに近づき過ぎない距離 */
      eOutMs: 220,
      eReturnMs: 160,
      eKeepFromPlayer: 110,
    },
    tamamo: {
      name: "玉藻",
      /** R: 1ラウンドの最大回数・1回の最大距離・速さ (当たり判定なし) */
      rCharges: 3,
      rMaxLength: 230,
      rSpeed: 1_100,
      /** R着地後に立ち止まる時間 */
      rSettleMs: 250,
      /** E (魅了): 射程・速さ・判定の幅 (直径)・ハートの長さ */
      eRange: 350,
      eSpeed: 750,
      eWidth: 60,
      eBodyLength: 30,
      /** 魅了されたとき、玉藻の方へ歩かされる演出の長さと速さ */
      charmMs: 600,
      charmSpeed: 70,
    },
  },
  /** ガンク専用の敵 */
  gankers: {
    kritz: {
      name: "クリッツブランク",
      radius: 22,
      /** 通常の移動速度と、W (加速) 中の速度 */
      walkSpeed: 150,
      hasteSpeed: 330,
      /** 陰の中で待機・出現するy (陰の境界からの深さ) */
      shadeDepth: 30,
      /** Q (グラブ): 鎖の届く距離・腕の速さ・判定の幅 (直径)・先端の長さ */
      qRange: 390,
      qSpeed: 700,
      qWidth: 70,
      qHeadLength: 30,
      /** 当たったとき、クリッツブランクの前まで引き寄せる演出の長さ */
      pullMs: 320,
    },
  },
  /** Playerの通常攻撃 (攻撃範囲内の敵ミニオンを右クリック。ラストヒット用) */
  attack: {
    damage: 30,
    /** Player中心 → ミニオン外周までの距離 */
    range: 180,
    cooldownMs: 800,
  },
  /**
   * レーン中央で戦うミニオン。味方・敵とも小2体 + 砲台1体。
   * 体力は「初期体力 (最大値に対する割合)」と「倒れる予定時刻 (ラウンド長に対する割合)」から
   * 減る速さを決める。相手側が全滅すると減らなくなる。
   */
  minions: {
    melee: { maxHp: 100, radius: 11 },
    cannon: { maxHp: 180, radius: 15 },
    startHpRatio: [0.6, 1.0] as [number, number],
    /** 何もしなければ倒れる時刻 (ラウンド長に対する割合) */
    enemyDeath: { melee: [0.3, 0.9] as [number, number], cannon: [0.55, 1.05] as [number, number] },
    allyDeath: { melee: [0.6, 1.2] as [number, number], cannon: [0.8, 1.4] as [number, number] },
    /** レーン中央の初期配置 (ゲーム座標) */
    layout: {
      ally: [
        { kind: "melee", x: 452, y: 278 },
        { kind: "melee", x: 452, y: 322 },
        { kind: "cannon", x: 418, y: 300 },
      ],
      enemy: [
        { kind: "melee", x: 548, y: 278 },
        { kind: "melee", x: 548, y: 322 },
        { kind: "cannon", x: 582, y: 300 },
      ],
    } as Record<"ally" | "enemy", { kind: "melee" | "cannon"; x: number; y: number }[]>,
  },
  simulation: {
    /** 衝突判定の固定サブステップ (ms)。描画フレームレートに依存させない */
    stepMs: 1000 / 240,
  },
  scoring: {
    maxPerRound: 1_000,
    decision: 400,
    timing: 400,
    execution: 200,
    /** CS (ラストヒット) ボーナス。1ラウンド1000点とは別枠で加算する */
    cs: { melee: 20, cannon: 50 },
    /** 期待行動と異なるが生存した場合のDecision点 */
    wrongButSurvivedDecision: 100,
    /** 反応時間カーブ: excellent以下=excellent点, good=good点, late=late点 の区間線形補間 */
    timingCurve: { excellent: 400, good: 300, late: 150, beyondLate: 50 },
    /** Lock前Flash等のearly penalty倍率 */
    earlyTimingMultiplier: 0.5,
    /** PERFECTラベルに必要なExecution点 */
    perfectExecutionMin: 150,
    /** 安全余裕がこの値 (world units) 以上でExecution満点。Encounter側で上書き可 */
    defaultIdealMargin: 18,
  },
  validation: {
    /** Flash問題: この反応時間でFlashして安全地点が存在すること */
    assumedReactionMs: 200,
    /** Move問題: この反応時間で歩き始めて回避できること */
    moveSolvableReactionMs: 350,
    /** Flash問題: この反応時間で歩いて避けられるなら「walkable」として再抽選する */
    walkableCheckReactionMs: 300,
    flashSampleAngles: 36,
    flashSampleDistances: [1, 0.75, 0.5],
    moveSampleAngles: 24,
    maxAttempts: 40,
  },
  /** Round indexごとのDifficulty budget (09_ENCOUNTER_CATALOG 8.3) */
  difficultyBudget: [1.0, 1.1, 1.3, 1.5, 1.7, 2.0, 2.2, 2.5, 2.8, 3.2],
  /** Round indexごとの出題Tier (09_ENCOUNTER_CATALOG 3) */
  roundTiers: [[1], [1], [1, 2], [1, 2], [1, 2], [2, 3], [2, 3], [2, 3], [3], [3, 4]] as number[][],
  deck: {
    minFlash: 3,
    minMove: 2,
    minWait: 1,
    minSideGank: 1,
    minDirectional: 1,
    maxFake: 2,
    maxSameKindStreak: 3,
    maxAttempts: 2_000,
  },
} as const;

export type GameConfig = typeof GAME_CONFIG;

/** 相手チャンピオンの表示名 */
export function championName(id: "default" | "yonekura" | "tamamo"): string {
  return id === "default" ? "標準" : GAME_CONFIG.champions[id].name;
}
