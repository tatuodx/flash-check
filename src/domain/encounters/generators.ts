import type { GameConfig } from "../../config/balance";
import { isVisible, onScreen } from "../fieldLayout";
import { add, clamp, distance, fromAngle, lerp, scale } from "../geometry";
import type { SeededRandom } from "../rng";
import type {
  ChampionId,
  Edge,
  EncounterDefinition,
  EventPayload,
  DashPayload,
  GankerId,
  GankerPayload,
  GeneratedEncounter,
  LineShotPayload,
  MinionSpec,
  Range,
  ScheduledEvent,
  Vec2,
} from "../types";

export interface EncounterGenerationContext {
  roundIndex: number;
  difficultyBudget: number;
  /** 直前ラウンドがSide Gankだった場合の発生方向 (上下を連続固定しないため) */
  prevSideEdge?: Edge;
  /** このラウンドの相手チャンピオン (省略時 default) */
  champion?: ChampionId;
  cfg: GameConfig;
}

/** Threat builderが返す、本命 (T=0 = Telegraph開始) 基準の相対タイムライン */
interface ThreatPlan {
  events: ScheduledEvent[];
  /** 最後の判定が完了する相対時刻 */
  resolveMs: number;
  recognitionMs: number;
  earlyWindowStartMs?: number;
  /** 本命より前に置くイベントの最大リード (相対時刻の負方向) */
  preLeadMs?: number;
  safeHint?: Vec2;
  idealMargin?: number;
  sideEdge?: Edge;
  variantId?: string;
  /** 敵の小ミニオン1体が (何もしなければ) 倒れる相対時刻。CSの誘惑を本命に重ねる */
  csLureMs?: number;
  /** 米倉のQ1/Q2演出をプラン側で配置済み */
  hasQVisuals?: boolean;
  /** 横から来るガンク役 */
  gankers?: GankerId[];
  /** 本命を避けた後の追撃の予兆の開始 (相対時刻) */
  followUpMs?: number;
}

interface BuildArgs {
  def: EncounterDefinition;
  rng: SeededRandom;
  /** 0 (easy) .. 1 (hard) */
  t: number;
  player: Vec2;
  enemy: Vec2;
  ctx: EncounterGenerationContext;
}

const EDGE_OFFSET = 30;
/** CROSS発射点からanchorまでの最大距離 (RoundSimulationの上限と一致させる) */
const CROSS_MAX_REACH = 700;
const LINE_BODY = 50;
const LINE_TRAVEL = 1_300;

export function difficultyT(budget: number): number {
  return clamp((budget - 1) / 2.2, 0, 1);
}

/** Range [easy, hard] を難易度tで補間し、小さなjitterを加える */
function pr(args: BuildArgs, key: string): number {
  const range = args.def.parameters[key] as Range;
  const tj = clamp(args.t + args.rng.range(-0.15, 0.15), 0, 1);
  return lerp(range[0], range[1], tj);
}

function main(atMs: number, payload: EventPayload): ScheduledEvent {
  return { atMs, type: payload.type, isMainThreat: true, payload };
}

function side(atMs: number, payload: EventPayload): ScheduledEvent {
  return { atMs, type: payload.type, isMainThreat: false, payload };
}

function travelMs(dist: number, speed: number): number {
  return (dist / speed) * 1000;
}

/** 敵は実行時に動くため、敵からPlayerまでの距離は追従レンジの上限で見積もる */
function enemyReach(args: BuildArgs): number {
  return args.ctx.cfg.enemy.ai.keepRange[1];
}

/**
 * 敵が追従レンジの最短距離から撃っても回避の猶予が残るよう、予兆の最低時間を返す。
 * hitHalfWidth: 攻撃判定の半幅 (Playerがこれ + 自分の半径だけ横にずれれば当たらない)
 */
function enemyMinLeadMs(args: BuildArgs, speed: number, hitHalfWidth: number): number {
  const cfg = args.ctx.cfg;
  const ai = cfg.enemy.ai;
  const pr = cfg.player.radius;
  const dMin = ai.keepRange[0] - 30;
  const travel = travelMs(Math.max(0, dMin - hitHalfWidth - pr), speed);
  const window =
    args.def.expectedAction === "MOVE"
      ? cfg.validation.moveSolvableReactionMs + travelMs(hitHalfWidth + pr, cfg.player.moveSpeed) + ai.moveWindowMarginMs
      : ai.minFlashWindowMs;
  return Math.max(0, window - travel);
}

function enemyLine(args: BuildArgs, rawLeadMs: number, speed: number, width: number): ThreatPlan {
  const leadMs = Math.max(rawLeadMs, enemyMinLeadMs(args, speed, width / 2));
  return {
    events: [
      main(0, {
        type: "LINE_SHOT",
        origin: { mode: "ENEMY" },
        aim: { mode: "ANCHOR", angleJitterRad: 0 },
        launchAtMs: leadMs,
        width,
        speed,
        bodyLength: LINE_BODY,
        maxTravel: LINE_TRAVEL,
        enemyCast: true,
      }),
    ],
    resolveMs: leadMs + travelMs(enemyReach(args) + 120, speed),
    recognitionMs: 0,
  };
}

function pickSideEdge(args: BuildArgs): Edge {
  const prev = args.ctx.prevSideEdge;
  if (prev) return prev === "TOP" ? "BOTTOM" : "TOP";
  return args.rng.pick<Edge>(["TOP", "BOTTOM"]);
}

/** 米倉E (魂の踏み込み)。stayMs だけ前に留まってから体へ戻る。E自体は本命ではない */
function yoneE(a: BuildArgs, atMs: number, outDistance: number, stayMs: number): ScheduledEvent {
  const y = a.ctx.cfg.champions.yonekura;
  return side(atMs, {
    type: "YONE_E",
    outDistance,
    outMs: y.eOutMs,
    returnAtMs: atMs + y.eOutMs + stayMs,
    returnMs: y.eReturnMs,
  });
}

/** 米倉のQ3 / R。発射位置から固定距離を駆け抜け、通り道全体が当たり判定 */
function yoneDash(a: BuildArgs, style: "q3" | "r", leadMs: number, atMs: number): ThreatPlan {
  const y = a.ctx.cfg.champions.yonekura;
  const speed = pr(a, "speed");
  const length = style === "q3" ? y.q3Length : y.rLength;
  return {
    events: [
      main(atMs, {
        type: "DASH",
        startAtMs: atMs + leadMs,
        speed,
        width: pr(a, "width"),
        overshoot: 0,
        length,
        harmful: true,
        style,
      }),
    ],
    resolveMs: atMs + leadMs + travelMs(length, speed) + 100,
    recognitionMs: atMs,
  };
}

/** E で踏み込み → Q3 / R → 体へ戻る */
function yoneCombo(a: BuildArgs, style: "q3" | "r"): ThreatPlan {
  const y = a.ctx.cfg.champions.yonekura;
  const skillAt = y.eOutMs + pr(a, "eToSkillMs");
  // Eで近づいた後なので、最短距離に関係なく予兆の最低時間を確保する
  const lead = Math.max(pr(a, "leadMs"), a.ctx.cfg.enemy.ai.minFlashWindowMs);
  const plan = yoneDash(a, style, lead, skillAt);
  const length = style === "q3" ? y.q3Length : y.rLength;
  const dashEnd = skillAt + lead + travelMs(length, (plan.events[0].payload as DashPayload).speed);
  const returnAt = dashEnd + a.rng.range(200, 350);
  plan.events.push(side(0, { type: "YONE_E", outDistance: pr(a, "eOut"), outMs: y.eOutMs, returnAtMs: returnAt, returnMs: y.eReturnMs }));
  plan.resolveMs = Math.max(plan.resolveMs, returnAt + y.eReturnMs);
  return plan;
}

// ---- アリ ----------------------------------------------------------------------

/** アリR (当たり判定なし)。bearingは「Player -> アリ」の向きからの回転 */
function tamamoR(at: number, toDistance: number, bearingRad: number): ScheduledEvent {
  return side(at, { type: "TAMAMO_R", toDistance, bearingRad });
}

/** Rの所要時間の上限 (最大距離を走り切る時間) */
function tamamoRMaxMs(a: BuildArgs): number {
  const tm = a.ctx.cfg.champions.tamamo;
  return travelMs(tm.rMaxLength, tm.rSpeed);
}

/**
 * Eの詠唱時間。距離 d (見積もりの最短) から撃っても、
 * FLASH問題は「詠唱開始 → 着弾」が minFlashWindowMs 以上、MOVE問題は「反応 + 横へ歩いて抜ける + 余裕」以上になるよう延ばす
 */
function tamamoWindup(a: BuildArgs, base: number, d: number): number {
  const cfg = a.ctx.cfg;
  const tm = cfg.champions.tamamo;
  const reach = tm.eWidth / 2 + cfg.player.radius;
  const flight = travelMs(Math.max(0, d - reach), tm.eSpeed);
  const need =
    a.def.expectedAction === "MOVE"
      ? cfg.validation.moveSolvableReactionMs + travelMs(reach, cfg.player.moveSpeed) + cfg.enemy.ai.moveWindowMarginMs
      : cfg.enemy.ai.minFlashWindowMs;
  return Math.max(base, need - flight);
}

/** E (魅了)。範囲は表示せず、詠唱開始時のPlayer位置へまっすぐ飛ぶ */
function tamamoEPlan(a: BuildArgs, windup: number, events: ScheduledEvent[]): ThreatPlan {
  const tm = a.ctx.cfg.champions.tamamo;
  const e = main(0, {
    type: "LINE_SHOT",
    origin: { mode: "ENEMY" },
    aim: { mode: "ANCHOR", angleJitterRad: 0 },
    launchAtMs: windup,
    width: tm.eWidth,
    speed: tm.eSpeed,
    bodyLength: tm.eBodyLength,
    maxTravel: tm.eRange,
    enemyCast: true,
    style: "charm",
  });
  const earliest = Math.min(0, ...events.map((ev) => ev.atMs));
  return {
    events: [...events, e],
    resolveMs: windup + travelMs(tm.eRange + tm.eBodyLength, tm.eSpeed),
    recognitionMs: 0,
    preLeadMs: -earliest,
    variantId: `R${events.filter((ev) => ev.payload.type === "TAMAMO_R").length}`,
  };
}

/** 横への位置取りのR (距離はおおむね保つ) */
function sideR(a: BuildArgs, at: number): ScheduledEvent {
  return tamamoR(at, a.rng.range(240, 320), a.rng.sign() * a.rng.range(0.5, 0.9));
}

/** 最後のRより前に置くRを、間隔をあけて遡って並べる */
function earlierRs(a: BuildArgs, count: number, firstAt: number, gap: () => number, make: (at: number) => ScheduledEvent): ScheduledEvent[] {
  const out: ScheduledEvent[] = [];
  let at = firstAt;
  for (let i = 0; i < count; i++) {
    at -= tamamoRMaxMs(a) + gap();
    out.push(make(at));
  }
  return out;
}

// ---- クリッツブランク ----------------------------------------------------------

/** 陰の中で出現・待機するy */
function kritzShadeY(a: BuildArgs, edge: Edge): number {
  const v = a.ctx.cfg.world.vision;
  const d = a.ctx.cfg.gankers.kritz.shadeDepth;
  return edge === "TOP" ? v.shadeTop - d : v.shadeBottom + d;
}

/**
 * Wで近づいて止まる位置。止まった姿が視界内 (陰の境界から30以上内側) に入るよう、
 * Playerからの向きをedge側へ傾ける角度の上限を決めて抽選する
 */
function kritzStop(a: BuildArgs, edge: Edge, stopDistance: number): { angle: number; goal: Vec2 } {
  const v = a.ctx.cfg.world.vision;
  const room = edge === "TOP" ? a.player.y - v.shadeTop - 30 : v.shadeBottom - 30 - a.player.y;
  const maxAngle = Math.asin(clamp(room / stopDistance, 0, 1));
  const angle = maxAngle * a.rng.range(0.5, 0.9);
  const ey = edge === "TOP" ? -1 : 1;
  return { angle, goal: { x: a.player.x + Math.cos(angle) * stopDistance, y: a.player.y + ey * Math.sin(angle) * stopDistance } };
}

/** 陰から斜めにWで近づき、止まる位置に着くまでの出現イベントと所要時間 */
function kritzApproachEvent(
  a: BuildArgs,
  edge: Edge,
  route: "APPROACH" | "RETREAT",
  stopDistance: number,
  extra: Partial<GankerPayload> = {},
): { payload: GankerPayload; travelMs: number; travelDist: number } {
  const k = a.ctx.cfg.gankers.kritz;
  const { angle, goal } = kritzStop(a, edge, stopDistance);
  const maxX = a.ctx.cfg.world.width - k.radius - 20;
  const spawnDx = Math.min(a.rng.range(150, 280), maxX - goal.x);
  const spawn = { x: goal.x + spawnDx, y: kritzShadeY(a, edge) };
  const travelDist = distance(spawn, goal);
  const travel = travelMs(travelDist, k.hasteSpeed);
  return {
    payload: { type: "GANKER", ganker: "kritz", route, edge, stopAngleRad: angle, stopDistance, spawnDx, hasteMs: travel + 300, ...extra },
    travelMs: travel,
    travelDist,
  };
}

/** Q (グラブ)。発射位置はクリッツブランクの位置、狙いは詠唱開始時のPlayer位置 */
function kritzHook(a: BuildArgs, windupMs: number): ScheduledEvent {
  const k = a.ctx.cfg.gankers.kritz;
  return main(0, {
    type: "LINE_SHOT",
    origin: { mode: "GANKER" },
    aim: { mode: "ANCHOR", angleJitterRad: 0 },
    launchAtMs: windupMs,
    width: k.qWidth,
    speed: k.qSpeed,
    bodyLength: k.qHeadLength,
    maxTravel: k.qRange,
    enemyCast: false,
    style: "hook",
  });
}

/** Wで近づいて止まり、少し間をおいてQ */
function kritzApproachQ(a: BuildArgs, edge: Edge, stopDistance: number, windupMs: number, pauseMs?: number): ThreatPlan {
  const k = a.ctx.cfg.gankers.kritz;
  const { payload, travelMs: travel } = kritzApproachEvent(a, edge, "APPROACH", stopDistance);
  // 止まってからQの詠唱を始めるまで
  const appearAt = -(travel + (pauseMs ?? a.rng.range(150, 300)));
  return {
    events: [side(appearAt, payload), kritzHook(a, windupMs)],
    resolveMs: windupMs + travelMs(k.qRange + k.qHeadLength, k.qSpeed),
    // 止まって詠唱を始めた姿が見えた時点
    recognitionMs: 0,
    preLeadMs: -appearAt,
    sideEdge: edge,
    variantId: `APPROACH-${edge}`,
    gankers: ["kritz"],
  };
}

/** 陰に潜んだままQ。見えるのは陰から伸びてくる腕と鎖だけ */
function kritzAmbushQ(a: BuildArgs, edge: Edge, hideDistance: number, windupMs: number): ThreatPlan {
  const k = a.ctx.cfg.gankers.kritz;
  const v = a.ctx.cfg.world.vision;
  const y = kritzShadeY(a, edge);
  const appearAt = -a.rng.range(500, 900);
  // 認識 = 鎖が陰の境界を越えて視界に入る時刻
  const dy = Math.abs(a.player.y - y);
  const toBoundary = (Math.abs((edge === "TOP" ? v.shadeTop : v.shadeBottom) - y) * hideDistance) / Math.max(1, dy);
  return {
    events: [
      side(appearAt, { type: "GANKER", ganker: "kritz", route: "AMBUSH", edge, stopAngleRad: 0, stopDistance: hideDistance, spawnDx: 0, hasteMs: 0 }),
      kritzHook(a, windupMs),
    ],
    resolveMs: windupMs + travelMs(k.qRange + k.qHeadLength, k.qSpeed),
    recognitionMs: Math.max(0, Math.floor(windupMs + travelMs(toBoundary, k.qSpeed)) - 5),
    preLeadMs: -appearAt,
    sideEdge: edge,
    variantId: `AMBUSH-${edge}`,
    gankers: ["kritz"],
  };
}

// ---- アッシュリー ----------------------------------------------------------------

/** Playerから向き u の直線上で、飛んでくる矢が最初に見える (画面に映っていて陰の外の) 距離。見えなければ 0 */
function arrowVisibleDistance(player: Vec2, u: Vec2): number {
  for (let s = 1_800; s > 0; s -= 2) {
    const p = add(player, scale(u, s));
    if (onScreen(p) && isVisible(p, player)) return s;
  }
  return 0;
}

const ARROW_FROM = ["RIGHT", "DOWN_RIGHT", "DOWN", "DOWN_LEFT", "LEFT", "UP_LEFT", "UP", "UP_RIGHT"];

interface ArrowShot {
  event: ScheduledEvent;
  /** 矢が画面に入って見え始める・Playerに当たる (何もしない場合)・判定を終える相対時刻 */
  recognitionMs: number;
  hitMs: number;
  resolveMs: number;
  variantId: string;
}

/**
 * 画面外から飛んでくるアッシュリーの矢 (R)。atMs に画面外で放たれ、その時点のPlayer位置へまっすぐ飛ぶ。
 * どの向きから来るかを抽選し、「画面に入って見えてから当たるまで」が windowMs になる速さにする。
 * 速さが範囲に収まらない向き (陰を長く通る真上・真下など) は選び直す
 */
function ashleyArrow(a: BuildArgs, windowMs: number, atMs = 0): ArrowShot {
  const ash = a.ctx.cfg.gankers.ashley;
  const reach = ash.arrowWidth / 2 + a.ctx.cfg.player.radius;
  for (let i = 0; i < 200; i++) {
    const angle = a.rng.range(-Math.PI, Math.PI);
    const visible = arrowVisibleDistance(a.player, fromAngle(angle));
    const speed = ((visible - reach) / windowMs) * 1000;
    if (visible <= reach || speed < ash.minSpeed || speed > ash.maxSpeed) continue;
    const dist = visible + ash.spawnBeyond;
    const sector = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    return {
      event: main(atMs, {
        type: "LINE_SHOT",
        origin: { mode: "OFFSCREEN", angleRad: angle, distance: dist },
        aim: { mode: "ANCHOR", angleJitterRad: 0 },
        launchAtMs: atMs,
        width: ash.arrowWidth,
        speed,
        bodyLength: ash.arrowLength,
        maxTravel: dist + 1_400,
        enemyCast: false,
        style: "arrow",
      }),
      recognitionMs: atMs + travelMs(dist - visible, speed),
      hitMs: atMs + travelMs(dist - reach, speed),
      resolveMs: atMs + travelMs(dist + reach + ash.arrowLength + 60, speed),
      variantId: `FROM-${ARROW_FROM[sector]}`,
    };
  }
  throw new Error("no arrow direction fits the window");
}

/** 矢だけの問題 */
function ashleyArrowPlan(a: BuildArgs, windowMs: number): ThreatPlan {
  const arrow = ashleyArrow(a, windowMs);
  return {
    events: [arrow.event],
    resolveMs: arrow.resolveMs,
    // 生成時の幾何の見積もり。Validationで実際に見えた時刻との差 (50ms以内) を確認する
    recognitionMs: Math.floor(arrow.recognitionMs) - 2,
    variantId: arrow.variantId,
    gankers: ["ashley"],
  };
}

/** プランを dt だけ後ろへずらす */
function shiftPlan(plan: ThreatPlan, dt: number): ThreatPlan {
  return { ...plan, events: plan.events.map((e) => shiftEvent(e, dt)), resolveMs: plan.resolveMs + dt };
}

/** レーンの相手のフェイク (当たり判定なし)。標準: 空詠唱 / 米倉: Eで踏み込んで戻る / アリ: Rで近づく */
function laneFake(a: BuildArgs, at: number): ScheduledEvent {
  const { rng } = a;
  switch (a.ctx.champion ?? "default") {
    case "yonekura":
      return yoneE(a, at, 130, 500);
    case "tamamo":
      return tamamoR(at, rng.range(190, 230), rng.sign() * rng.range(0, 0.4));
    default:
      return side(at, { type: "FAKE_CAST", durationMs: 500 });
  }
}

/** レーンの相手の本命の技 (T=0 から)。標準: 直線 / 米倉: Q3 / アリ: Rで近づいてE */
function laneSkill(a: BuildArgs): ThreatPlan {
  switch (a.ctx.champion ?? "default") {
    case "yonekura": {
      const speed = pr(a, "dashSpeed");
      const width = pr(a, "dashWidth");
      const dashArgs = { ...a, def: { ...a.def, parameters: { ...a.def.parameters, speed: [speed, speed], width: [width, width] } } };
      return yoneDash(dashArgs, "q3", Math.max(pr(a, "leadMs"), enemyMinLeadMs(a, speed, width / 2)), 0);
    }
    case "tamamo": {
      // Eは遅いので、直前にRで近づいてからEを撃ち、Qとほぼ同時に届くようにする
      const d = a.rng.range(195, 225);
      const r = tamamoR(-(tamamoRMaxMs(a) + a.rng.range(80, 200)), d, a.rng.sign() * a.rng.range(0, 0.4));
      return tamamoEPlan(a, tamamoWindup(a, pr(a, "leadMs"), d - 15), [r]);
    }
    default:
      return enemyLine(a, pr(a, "leadMs"), pr(a, "speed"), pr(a, "width"));
  }
}

const THREAT_BUILDERS: Record<string, (args: BuildArgs) => ThreatPlan> = {
  "ENC-001": (a) => enemyLine(a, pr(a, "leadMs"), pr(a, "speed"), pr(a, "width")),

  "ENC-002": (a) => enemyLine(a, pr(a, "leadMs"), pr(a, "speed"), pr(a, "width")),

  "ENC-003": (a) => {
    const delay = pr(a, "delayMs");
    return {
      events: [main(0, { type: "CIRCLE", center: { mode: "ANCHOR", offset: { x: 0, y: 0 } }, radius: pr(a, "radius"), detonateAtMs: delay })],
      resolveMs: delay,
      recognitionMs: 0,
    };
  },

  "ENC-008": (a) => {
    const delay = pr(a, "delayMs");
    const offset = fromAngle(a.rng.range(0, Math.PI * 2));
    const len = a.rng.range(0, 15);
    return {
      events: [
        main(0, {
          type: "CIRCLE",
          center: { mode: "ANCHOR", offset: { x: offset.x * len, y: offset.y * len } },
          radius: pr(a, "radius"),
          detonateAtMs: delay,
        }),
      ],
      resolveMs: delay,
      recognitionMs: 0,
    };
  },

  "ENC-010": (a) => {
    const speed = pr(a, "speed");
    const width = pr(a, "width");
    const lead = Math.max(pr(a, "leadMs"), enemyMinLeadMs(a, speed, width / 2));
    const overshoot = a.def.parameters.overshoot as number;
    const burstDelay = 120;
    return {
      events: [
        main(0, {
          type: "DASH",
          startAtMs: lead,
          speed,
          width,
          overshoot,
          harmful: true,
          endBurst: { radius: a.def.parameters.endBurstRadius as number, delayAfterArrivalMs: burstDelay },
        }),
      ],
      resolveMs: lead + travelMs(enemyReach(a) + overshoot, speed) + burstDelay,
      recognitionMs: 0,
    };
  },

  "ENC-012": (a) => {
    const { rng, ctx } = a;
    const edge = rng.pick<Edge>(["TOP", "BOTTOM"]);
    const lead = pr(a, "leadMs");
    const speed = pr(a, "speed");
    const width = pr(a, "width");
    const gap = pr(a, "narrowGap");
    const s = rng.sign();
    const bDx = rng.range(-8, 8);
    const aDx = bDx + s * (width + gap);
    const dir = { x: 0, y: edge === "TOP" ? 1 : -1 };
    const line = (dx: number) =>
      main(0, {
        type: "LINE_SHOT",
        origin: { mode: "EDGE", edge, dxFromAnchor: dx },
        aim: { mode: "FIXED_DIR", dir },
        launchAtMs: lead,
        width,
        speed,
        bodyLength: LINE_BODY,
        maxTravel: ctx.cfg.world.height + EDGE_OFFSET * 2 + LINE_BODY,
        enemyCast: false,
      });
    return {
      events: [line(bDx), line(aDx)],
      resolveMs: lead + travelMs(ctx.cfg.world.height + EDGE_OFFSET * 2 + LINE_BODY * 2, speed),
      recognitionMs: 0,
      safeHint: { x: -s * 170, y: 0 },
      idealMargin: 70,
      variantId: `${edge}-${s > 0 ? "WIDE_LEFT" : "WIDE_RIGHT"}`,
    };
  },

  "ENC-013": (a) => {
    const track = pr(a, "trackMs");
    const speed = pr(a, "speed");
    const width = pr(a, "width");
    // Lock (= 認識) から当たるまでの猶予を確保する
    const lockToLaunch = Math.max(pr(a, "lockToLaunchMs"), enemyMinLeadMs(a, speed, width / 2));
    return {
      events: [
        main(0, {
          type: "LINE_SHOT",
          origin: { mode: "ENEMY" },
          aim: { mode: "TRACK", lockAtMs: track },
          launchAtMs: track + lockToLaunch,
          width,
          speed,
          bodyLength: LINE_BODY,
          maxTravel: LINE_TRAVEL,
          enemyCast: true,
        }),
      ],
      resolveMs: track + lockToLaunch + travelMs(enemyReach(a) + 120, speed),
      recognitionMs: track,
      earlyWindowStartMs: 0,
    };
  },

  "ENC-015": (a) => {
    // CS可能になったミニオンの直後に遅いprojectile: 敵の小ミニオン1体の体力が本命直後に尽きるようにする
    const plan = enemyLine(a, pr(a, "leadMs"), pr(a, "speed"), pr(a, "width"));
    plan.csLureMs = a.rng.range(300, 900);
    return plan;
  },

  "ENC-017": (a) => {
    const { rng } = a;
    const speed = pr(a, "speed");
    const width = pr(a, "width");
    const lead = Math.max(pr(a, "leadMs"), enemyMinLeadMs(a, speed, width / 2));
    // 2本目は「敵 -> Player の線」を交差角だけ回した向き。敵の位置は実行時に決まるため発射点も実行時に計算する
    const angle = rng.sign() * ((pr(a, "crossAngleDeg") * Math.PI) / 180);
    const edge = rng.pick<Edge>(["TOP", "BOTTOM"]);
    const delay2 = rng.range(0, 120);
    const line = (origin: LineShotPayload["origin"], launch: number, cast: boolean) =>
      main(0, {
        type: "LINE_SHOT",
        origin,
        aim: { mode: "ANCHOR", angleJitterRad: 0 },
        launchAtMs: launch,
        width,
        speed,
        bodyLength: LINE_BODY,
        maxTravel: LINE_TRAVEL,
        enemyCast: cast,
      });
    return {
      events: [line({ mode: "ENEMY" }, lead, true), line({ mode: "CROSS", edge, angleRad: angle }, lead + delay2, false)],
      resolveMs: lead + delay2 + travelMs(CROSS_MAX_REACH + 120, speed),
      recognitionMs: 0,
      sideEdge: edge,
    };
  },

  "ENC-020": (a) => {
    const track = pr(a, "trackMs");
    const det = pr(a, "detonateAfterLockMs");
    return {
      events: [main(0, { type: "CIRCLE", center: { mode: "TRACK", lockAtMs: track }, radius: pr(a, "radius"), detonateAtMs: track + det })],
      resolveMs: track + det,
      recognitionMs: track,
      earlyWindowStartMs: 0,
    };
  },

  "ENC-021": (a) => {
    const { rng, player, ctx } = a;
    const lead = pr(a, "leadMs");
    const speed = pr(a, "speed");
    const thickness = a.def.parameters.thickness as number;
    const gapWidth = ctx.cfg.player.radius * 2 * pr(a, "gapDiameters");
    const gapOffsetY = rng.sign() * rng.range(130, 165);
    const startXOffset = rng.range(200, 240);
    return {
      events: [main(0, { type: "SWEEP", startXOffset, launchAtMs: lead, speed, thickness, gapOffsetY, gapWidth })],
      resolveMs: lead + travelMs(player.x + startXOffset + thickness, speed),
      recognitionMs: 0,
      safeHint: { x: 0, y: gapOffsetY },
      idealMargin: Math.max(6, (gapWidth / 2 - ctx.cfg.player.radius) * 0.75),
      variantId: gapOffsetY < 0 ? "GAP_UP" : "GAP_DOWN",
    };
  },

  // ---- クリッツブランク ---------------------------------------------------------
  "KRZ-Q": (a) => {
    const edge = pickSideEdge(a);
    const windup = pr(a, "windupMs");
    // 陰からWで来るか、陰に潜んだままいきなりQか (半々)
    return a.rng.chance(0.5) ? kritzApproachQ(a, edge, pr(a, "stopDistance"), windup) : kritzAmbushQ(a, edge, pr(a, "ambushDistance"), windup);
  },

  "KRZ-Q-FAR": (a) => kritzApproachQ(a, pickSideEdge(a), pr(a, "stopDistance"), pr(a, "windupMs")),

  // レーンの相手のフェイクに目を向けさせた直後、陰に潜んだままQ
  "KRZ-FAKE-Q": (a) => {
    const edge = pickSideEdge(a);
    const plan = kritzAmbushQ(a, edge, pr(a, "ambushDistance"), pr(a, "windupMs"));
    const fakeAt = -pr(a, "fakeToHookMs");
    plan.events.push(laneFake(a, fakeAt));
    plan.preLeadMs = Math.max(plan.preLeadMs ?? 0, -fakeAt);
    plan.variantId = `${a.ctx.champion ?? "default"}-${edge}`;
    return plan;
  },

  // Wで近づいて止まったクリッツブランクのQと、レーンの相手の技がほぼ同時に来る。逃げられる向きが限られる
  "KRZ-PINCER": (a) => {
    const edge = pickSideEdge(a);
    const hook = kritzApproachQ(a, edge, pr(a, "stopDistance"), pr(a, "windupMs"));
    const lane = shiftPlan(laneSkill(a), Math.round(pr(a, "laneDelayMs")));
    return {
      ...hook,
      events: [...hook.events, ...lane.events],
      resolveMs: Math.max(hook.resolveMs, lane.resolveMs),
      preLeadMs: Math.max(hook.preLeadMs ?? 0, lane.preLeadMs ?? 0),
      variantId: `${a.ctx.champion ?? "default"}-${edge}`,
    };
  },

  // Wで近づいて止まり、Wだけのフェイク (KRZ-W) と同じくらい様子を見てから近距離でQ
  "KRZ-W-HOLD": (a) => {
    const edge = pickSideEdge(a);
    const plan = kritzApproachQ(a, edge, pr(a, "stopDistance"), pr(a, "windupMs"), a.rng.range(...(a.def.parameters.holdMs as Range)));
    plan.variantId = `HOLD-${edge}`;
    return plan;
  },

  // 陰の境界に近い位置から短い距離でQ。鎖が見えてから当たるまでが短い
  "KRZ-AMBUSH-NEAR": (a) => kritzAmbushQ(a, pickSideEdge(a), pr(a, "ambushDistance"), pr(a, "windupMs")),

  // ---- アッシュリー ---------------------------------------------------------------
  "ASH-R": (a) => ashleyArrowPlan(a, pr(a, "windowMs")),

  "ASH-R-FAR": (a) => ashleyArrowPlan(a, pr(a, "windowMs")),

  // 矢が画面に入るのとほぼ同時に、レーンの相手も本命の技を撃つ
  "ASH-R-LANE": (a) => {
    const arrow = ashleyArrow(a, pr(a, "windowMs"));
    const laneAt = Math.round(arrow.recognitionMs + a.rng.range(-80, 120));
    const lane = shiftPlan(laneSkill(a), laneAt);
    return {
      events: [arrow.event, ...lane.events],
      resolveMs: Math.max(arrow.resolveMs, lane.resolveMs),
      recognitionMs: Math.floor(Math.min(arrow.recognitionMs, laneAt)) - 2,
      preLeadMs: Math.max(0, (lane.preLeadMs ?? 0) - laneAt),
      variantId: `${a.ctx.champion ?? "default"}-${arrow.variantId}`,
      gankers: ["ashley"],
    };
  },

  // クリッツブランクがWで近づいて止まりQ。その詠唱とほぼ同時に矢も画面に入ってくる
  "ASH-R-KRZ": (a) => {
    const edge = pickSideEdge(a);
    const hook = kritzApproachQ(a, edge, pr(a, "stopDistance"), pr(a, "windupMs"));
    const arrow0 = ashleyArrow(a, pr(a, "windowMs"));
    const shift = Math.round(-arrow0.recognitionMs + pr(a, "arrowDelayMs"));
    return {
      ...hook,
      events: [...hook.events, shiftEvent(arrow0.event, shift)],
      resolveMs: Math.max(hook.resolveMs, arrow0.resolveMs + shift),
      preLeadMs: Math.max(hook.preLeadMs ?? 0, -shift),
      variantId: `${edge}-${arrow0.variantId}`,
      gankers: ["kritz", "ashley"],
    };
  },

  // 矢をFlashで避けた直後に、レーンの相手が追撃 (歩いて避けられる予兆の長さ)
  "ASH-R-FOLLOW": (a) => {
    const arrow = ashleyArrow(a, pr(a, "windowMs"));
    const followAt = Math.round(arrow.hitMs + pr(a, "followGapMs"));
    const moveArgs = { ...a, def: { ...a.def, expectedAction: "MOVE" as const } };
    const follow = shiftPlan(laneSkill(moveArgs), followAt);
    // 追撃はFlash後の位置を狙う
    for (const e of follow.events) if (e.isMainThreat) e.reanchor = true;
    return {
      events: [arrow.event, ...follow.events],
      resolveMs: Math.max(arrow.resolveMs, follow.resolveMs),
      recognitionMs: Math.floor(arrow.recognitionMs) - 2,
      followUpMs: followAt,
      variantId: `${a.ctx.champion ?? "default"}-${arrow.variantId}`,
      gankers: ["ashley"],
    };
  },

  // ---- アリ -------------------------------------------------------------------
  "TMM-RE": (a) => {
    const { rng } = a;
    const [lo, hi] = a.def.parameters.rCount as Range;
    const n = rng.int(lo, hi);
    const d = pr(a, "inDistance");
    const lastAt = -(tamamoRMaxMs(a) + pr(a, "rToEMs"));
    const last = tamamoR(lastAt, d, rng.sign() * rng.range(0, 0.5));
    const before = earlierRs(a, n - 1, lastAt, () => rng.range(700, 1_800), (at) => sideR(a, at));
    return tamamoEPlan(a, tamamoWindup(a, pr(a, "windupMs"), d - 15), [...before, last]);
  },

  "TMM-E-FAR": (a) => {
    const { rng, ctx } = a;
    const [lo, hi] = a.def.parameters.rCount as Range;
    const n = rng.int(lo, hi);
    const ai = ctx.cfg.enemy.ai;
    if (n === 0) {
      // Rを使わない: 追従レンジのどこにいても歩いて避けられる詠唱時間にする
      return tamamoEPlan(a, tamamoWindup(a, pr(a, "windupMs"), ai.keepRange[0] - 30), []);
    }
    const out = pr(a, "outDistance");
    const lastAt = -(tamamoRMaxMs(a) + pr(a, "rToEMs"));
    const last = tamamoR(lastAt, out, rng.sign() * rng.range(0, 0.3));
    const before = earlierRs(a, n - 1, lastAt, () => rng.range(700, 1_600), (at) => sideR(a, at));
    // 追従レンジの最短距離から最大距離だけ下がった場合でも足りるように見積もる
    const dWorst = Math.min(out, ai.keepRange[0] - 30 + ctx.cfg.champions.tamamo.rMaxLength) - 20;
    return tamamoEPlan(a, tamamoWindup(a, pr(a, "windupMs"), dWorst), [...before, last]);
  },

  "TMM-RRE": (a) => {
    const { rng } = a;
    const [lo, hi] = a.def.parameters.rCount as Range;
    const n = rng.int(lo, hi);
    const d = pr(a, "inDistance");
    const lastAt = -(tamamoRMaxMs(a) + pr(a, "rToEMs"));
    const last = tamamoR(lastAt, d, rng.sign() * rng.range(0, 0.5));
    const before = earlierRs(a, n - 1, lastAt, () => pr(a, "rGapMs"), (at) => sideR(a, at));
    return tamamoEPlan(a, tamamoWindup(a, pr(a, "windupMs"), d - 15), [...before, last]);
  },

  "TMM-RBACK": (a) => {
    const { rng } = a;
    const back = pr(a, "backDistance");
    const backAt = -(tamamoRMaxMs(a) + pr(a, "rToEMs"));
    const inAt = backAt - tamamoRMaxMs(a) - pr(a, "rGapMs");
    const events = [tamamoR(inAt, pr(a, "inDistance"), rng.sign() * rng.range(0, 0.4)), tamamoR(backAt, back, rng.sign() * rng.range(0, 0.12))];
    // 半分の問題では、その前に横へのRも1回使う (合計3回)
    if (rng.chance(0.5)) events.unshift(sideR(a, inAt - tamamoRMaxMs(a) - rng.range(900, 1_800)));
    return tamamoEPlan(a, tamamoWindup(a, pr(a, "windupMs"), back - 20), events);
  },

  "TMM-RBACK-F": (a) => {
    const { rng } = a;
    const d = pr(a, "inDistance");
    const lastAt = -(tamamoRMaxMs(a) + pr(a, "rToEMs"));
    const backAt = lastAt - tamamoRMaxMs(a) - pr(a, "rGapMs");
    const inAt = backAt - tamamoRMaxMs(a) - pr(a, "rGapMs");
    const events = [
      tamamoR(inAt, pr(a, "inDistance"), rng.sign() * rng.range(0, 0.4)),
      tamamoR(backAt, pr(a, "backDistance"), rng.sign() * rng.range(0, 0.12)),
      tamamoR(lastAt, d, rng.sign() * rng.range(0, 0.5)),
    ];
    return tamamoEPlan(a, tamamoWindup(a, pr(a, "windupMs"), d - 15), events);
  },

  // ---- 米倉 -------------------------------------------------------------------
  "YNK-Q3": (a) => {
    const plan = yoneDash(a, "q3", Math.max(pr(a, "leadMs"), enemyMinLeadMs(a, pr(a, "speed"), pr(a, "width") / 2)), 0);
    // Q3の前にQ1/Q2の演出 (近くのミニオンを2回突いて風が溜まる)
    const { rng } = a;
    const q1 = -rng.range(3_200, 4_200);
    const q2 = -rng.range(1_500, 2_300);
    plan.events.push(side(q1, { type: "YONE_Q_VISUAL", stack: 1, durationMs: 300 }), side(q2, { type: "YONE_Q_VISUAL", stack: 2, durationMs: 300 }));
    plan.preLeadMs = -q1;
    plan.hasQVisuals = true;
    return plan;
  },

  "YNK-R": (a) => yoneDash(a, "r", Math.max(pr(a, "leadMs"), enemyMinLeadMs(a, pr(a, "speed"), pr(a, "width") / 2)), 0),

  "YNK-EQ3": (a) => yoneCombo(a, "q3"),

  "YNK-ER": (a) => yoneCombo(a, "r"),

};

export function hasGenerator(id: string): boolean {
  return id in THREAT_BUILDERS;
}

function shiftEvent(ev: ScheduledEvent, dt: number): ScheduledEvent {
  const p = { ...ev.payload } as EventPayload;
  switch (p.type) {
    case "LINE_SHOT":
      p.launchAtMs += dt;
      if (p.aim.mode === "TRACK") p.aim = { ...p.aim, lockAtMs: p.aim.lockAtMs + dt };
      break;
    case "CIRCLE":
      p.detonateAtMs += dt;
      if (p.center.mode === "TRACK") p.center = { ...p.center, lockAtMs: p.center.lockAtMs + dt };
      break;
    case "DASH":
      p.startAtMs += dt;
      break;
    case "SWEEP":
      p.launchAtMs += dt;
      break;
    case "YONE_E":
      p.returnAtMs += dt;
      break;
    default:
      break;
  }
  return { ...ev, atMs: ev.atMs + dt, payload: p };
}

/** Neutral区間のイベント (本命とは内部フラグで区別される) */
function buildNeutral(rng: SeededRandom, tier: number, t: number, limitMs: number): ScheduledEvent[] {
  const events: ScheduledEvent[] = [];
  const count = Math.round(lerp(tier === 1 ? 0 : 1, 3, t) + rng.range(0, 1));
  // 相手チャンピオンの移動はRoundSimulationのAIが担うため、Neutralイベントは画面端の敵影のみ
  if (tier < 2) return events;
  let cursor = 1_000;
  for (let i = 0; i < count; i++) {
    const at = cursor + rng.range(0, 1_200);
    if (at > limitMs) break;
    events.push(
      side(at, {
        type: "EDGE_SHADOW",
        edge: rng.pick<Edge>(["TOP", "BOTTOM"]),
        x: rng.range(200, 800),
        durationMs: 400,
      }),
    );
    cursor = at + 900;
  }
  return events;
}

/**
 * レーン中央で戦うミニオン。初期体力と、何もしなければ倒れる時刻をSeedで抽選し、
 * そこから毎秒の体力減少量を決める。
 */
export function buildMinions(rng: SeededRandom, cfg: GameConfig, durationMs: number, csLureAtMs?: number): MinionSpec[] {
  const m = cfg.minions;
  const out: MinionSpec[] = [];
  let lureUsed = csLureAtMs === undefined;
  for (const team of ["ally", "enemy"] as const) {
    for (const slot of m.layout[team]) {
      const maxHp = m[slot.kind].maxHp;
      const startHp = Math.round(maxHp * rng.range(...m.startHpRatio));
      const window = (team === "enemy" ? m.enemyDeath : m.allyDeath)[slot.kind];
      let deathAt = durationMs * rng.range(...window);
      if (!lureUsed && team === "enemy" && slot.kind === "melee") {
        deathAt = csLureAtMs!;
        lureUsed = true;
      }
      out.push({
        id: out.length + 1,
        team,
        kind: slot.kind,
        pos: { x: slot.x + rng.range(-6, 6), y: slot.y + rng.range(-6, 6) },
        maxHp,
        startHp,
        drainPerSec: startHp / (Math.max(500, deathAt) / 1000),
      });
    }
  }
  return out;
}

export function generateEncounter(
  def: EncounterDefinition,
  ctx: EncounterGenerationContext,
  rng: SeededRandom,
): GeneratedEncounter {
  const builder = THREAT_BUILDERS[def.id];
  if (!builder) throw new Error(`No generator for ${def.id}`);
  const cfg = ctx.cfg;
  const t = difficultyT(ctx.difficultyBudget);
  const player = { x: rng.range(...cfg.player.spawn.x), y: rng.range(...cfg.player.spawn.y) };
  const enemy = { x: rng.range(...cfg.enemy.spawn.x), y: rng.range(...cfg.enemy.spawn.y) };

  const plan = builder({ def, rng, t, player, enemy, ctx });

  const tail = rng.range(350, 650);
  const budget = plan.resolveMs + tail;
  const preLead = plan.preLeadMs ?? 0;
  let duration = rng.int(def.durationRangeMs[0], def.durationRangeMs[1]);
  duration = clamp(duration, cfg.roundDurationMs.min, cfg.roundDurationMs.max);
  let threatStart = duration - budget;
  const minStart = Math.max(cfg.minThreatStartMs, preLead + 1_200);
  if (threatStart < minStart) {
    threatStart = minStart;
    duration = Math.min(cfg.roundDurationMs.max, Math.ceil(threatStart + budget));
  }
  threatStart = Math.round(threatStart);

  const threatEvents = plan.events.map((e) => shiftEvent(e, threatStart));
  const champion = ctx.champion ?? "default";
  const neutral = buildNeutral(rng, def.difficulty, t, threatStart - preLead - 1_300);
  if (champion === "yonekura" && !plan.hasQVisuals) {
    // 米倉のQ1/Q2演出 (出題ではない)
    let at = rng.range(1_200, 2_200);
    for (const stack of [1, 2] as const) {
      if (at > threatStart - preLead - 900) break;
      neutral.push(side(at, { type: "YONE_Q_VISUAL", stack, durationMs: 300 }));
      at += rng.range(1_200, 2_400);
    }
  }
  const events = [...neutral, ...threatEvents].sort((a, b) => a.atMs - b.atMs);

  return {
    definitionId: def.id,
    champion,
    gankers: plan.gankers,
    followUpMs: plan.followUpMs !== undefined ? Math.round(threatStart + plan.followUpMs) : undefined,
    name: def.name,
    kind: def.kind,
    seed: rng.seed,
    roundIndex: ctx.roundIndex,
    difficultyBudget: ctx.difficultyBudget,
    roundDurationMs: duration,
    threatStartMs: threatStart,
    recognitionMs: Math.round(threatStart + plan.recognitionMs),
    earlyWindowStartMs: plan.earlyWindowStartMs !== undefined ? threatStart + plan.earlyWindowStartMs : undefined,
    playerSpawn: player,
    enemySpawns: [enemy],
    minions: buildMinions(rng, cfg, duration, plan.csLureMs !== undefined ? threatStart + plan.csLureMs : undefined),
    events,
    expectedAction: def.expectedAction,
    timingWindow: def.timingWindow,
    idealMargin: plan.idealMargin ?? cfg.scoring.defaultIdealMargin,
    safeHint: plan.safeHint,
    variantId: plan.variantId,
    sideEdge: plan.sideEdge,
  };
}
