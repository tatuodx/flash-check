import type { GameConfig } from "../../config/balance";
import { isVisible } from "../fieldLayout";
import { computeFlash } from "../flash";
import { createRng, type SeededRandom } from "../rng";
import {
  add,
  dot,
  capsuleClearance,
  circleClearance,
  clamp,
  clampToBounds,
  distance,
  inBounds,
  normalize,
  rotate,
  scale,
  sub,
  type Bounds,
} from "../geometry";
import type {
  CirclePayload,
  DashPayload,
  FlashRecord,
  GankerPayload,
  GeneratedEncounter,
  LineShotPayload,
  MinionSpec,
  MoveRecord,
  ScheduledEvent,
  SweepPayload,
  Vec2,
} from "../types";

export interface SimConfig {
  enemyAi: GameConfig["enemy"]["ai"];
  yonekura: GameConfig["champions"]["yonekura"];
  kritz: GameConfig["gankers"]["kritz"];
  tamamo: GameConfig["champions"]["tamamo"];
  /** 陰の境界 (これより上/下は視界なし) */
  shade: { top: number; bottom: number };
  lane: { top: number; bottom: number };
  attack: { damage: number; range: number; cooldownMs: number };
  minionRadius: Record<MinionSpec["kind"], number>;
  worldWidth: number;
  worldHeight: number;
  playerRadius: number;
  enemyRadius: number;
  moveSpeed: number;
  flashMaxDistance: number;
  stepMs: number;
  /** Player中心が移動可能な範囲 */
  bounds: Bounds;
}

export function simConfigFrom(cfg: GameConfig): SimConfig {
  const r = cfg.player.radius;
  return {
    enemyAi: cfg.enemy.ai,
    yonekura: cfg.champions.yonekura,
    kritz: cfg.gankers.kritz,
    tamamo: cfg.champions.tamamo,
    shade: { top: cfg.world.vision.shadeTop, bottom: cfg.world.vision.shadeBottom },
    lane: { ...cfg.world.lane },
    attack: { ...cfg.attack },
    minionRadius: { melee: cfg.minions.melee.radius, cannon: cfg.minions.cannon.radius },
    worldWidth: cfg.world.width,
    worldHeight: cfg.world.height,
    playerRadius: r,
    enemyRadius: cfg.enemy.radius,
    moveSpeed: cfg.player.moveSpeed,
    flashMaxDistance: cfg.flash.maxDistance,
    stepMs: cfg.simulation.stepMs,
    bounds: { minX: r, minY: r, maxX: cfg.world.width - r, maxY: cfg.world.height - r },
  };
}

interface HazardBase {
  id: number;
  isMain: boolean;
  telegraphAtMs: number;
  done: boolean;
  /** このHazardに対するPlayerの最小安全余裕 (Infinity = 未接触) */
  minClearance: number;
}

export interface LineHazard extends HazardBase {
  kind: "LINE";
  payload: LineShotPayload;
  origin: Vec2;
  dir: Vec2;
  /** 画面外へ出るまでの距離でClampした射程 */
  maxTravel: number;
  locked: boolean;
  /** 弾頭の移動距離 (発射前は0) */
  traveled: number;
  launched: boolean;
}

export interface CircleHazard extends HazardBase {
  kind: "CIRCLE";
  center: Vec2;
  radius: number;
  detonateAtMs: number;
  lockAtMs?: number;
  locked: boolean;
}

export interface DashHazard extends HazardBase {
  kind: "DASH";
  payload: DashPayload;
  from: Vec2;
  to: Vec2;
  pos: Vec2;
  traveled: number;
  total: number;
  arrivalAtMs: number;
  /** 米倉Eで体へ戻った後は、この突進の終点に敵を留めない */
  superseded?: boolean;
}

export interface SweepHazard extends HazardBase {
  kind: "SWEEP";
  payload: SweepPayload;
  startX: number;
  x: number;
  gapCenterY: number;
  launched: boolean;
}

export type Hazard = LineHazard | CircleHazard | DashHazard | SweepHazard;

export interface HitInfo {
  atMs: number;
  pos: Vec2;
  hazardId: number;
}

export interface MinionState {
  spec: MinionSpec;
  hp: number;
  alive: boolean;
  diedAtMs?: number;
  /** Playerの攻撃でとどめを刺した (= CS) */
  killedByPlayer: boolean;
  /** Playerの攻撃が最後に当たった時刻 (演出用) */
  lastHitByPlayerMs?: number;
}

/** ガンク役 (クリッツブランク) の状態 */
export interface GankerState {
  payload: GankerPayload;
  spawnedAtMs: number;
  pos: Vec2;
  /** 出現位置 (陰の中)。RETREATはここへ戻る */
  spawn: Vec2;
  /** PASSの目的地 (反対側の陰) */
  exit: Vec2 | null;
  /** 止まる位置のx方向の向き (画面外にはみ出す場合は左右反転して -1) */
  sx: number;
  /** Qの詠唱を始めたら動かない */
  casting: boolean;
  /** このstepで移動したか (演出用) */
  moving: boolean;
}

export type AttackResult = "hit" | "kill" | "out_of_range" | "cooldown" | "no_target";

export interface AttackRecord {
  timestampMs: number;
  result: AttackResult;
  minionId?: number;
}

export interface SimOutcome {
  hit: boolean;
  hitAtMs?: number;
  flash: FlashRecord | null;
  moves: MoveRecord[];
  minClearance: number;
  recognitionMs: number;
  /** ラストヒットしたミニオン数と、そのうち砲台の数 */
  csCount: number;
  csCannon: number;
}

const EDGE_SPAWN_MARGIN = 30;
/** クリック位置とミニオン外周の許容距離 */
const CLICK_SLOP = 10;

/** CROSS発射点からanchorまでの最大距離 (generatorsの見積もりと一致させる) */
const CROSS_MAX_REACH = 700;

/**
 * 1ラウンド分のゲームロジック。Phaserに依存しない。
 * 時刻はRound開始 (NEUTRAL開始) からの相対msで扱う。
 */
export class RoundSimulation {
  t = 0;
  readonly player: { pos: Vec2; target: Vec2 | null };
  flash: FlashRecord | null = null;
  readonly moves: MoveRecord[] = [];
  readonly hazards: Hazard[] = [];
  hit: HitInfo | null = null;
  anchor: Vec2 | null = null;
  mirror = { x: false, y: false };
  /** 描画側が本命を実際に表示したフレームの時刻 */
  recognitionVisibleMs: number | null = null;
  /** 本命 (の予兆・弾) の一部が初めてPlayerの視界内に入った時刻 */
  threatVisibleMs: number | null = null;
  readonly minions: MinionState[];
  readonly attacks: AttackRecord[] = [];
  private lastAttackAtMs = -Infinity;

  /** 相手チャンピオン (移動AI)。Dash中・踏み込み中の表示位置は enemyPos() を使う */
  readonly enemy: { pos: Vec2; target: Vec2 | null; nextDecisionAtMs: number };

  private readonly events: ScheduledEvent[];
  private nextEventIdx = 0;
  private nextHazardId = 1;
  private readonly enemyRng: SeededRandom;
  /** 立ち止まる時間帯 (本命の詠唱前〜, Fake詠唱, 踏み込み) */
  private readonly holdWindows: [number, number][];
  private stepIn: { atMs: number; durationMs: number; from: Vec2; dir: Vec2; distance: number } | null = null;
  /** 米倉E: 体の位置 (body) を残して魂が前へ出る。returnAtMsで体へ戻る */
  yoneE: { atMs: number; outMs: number; body: Vec2; out: Vec2; returnAtMs: number; returnMs: number; returnFrom: Vec2 | null } | null = null;
  /** ガンク役 (出現前は null) */
  ganker: GankerState | null = null;
  /** 玉藻R: ダッシュ中の区間 (着地後は null) と、このラウンドで使った回数 */
  tamamoR: { atMs: number; from: Vec2; to: Vec2; endMs: number } | null = null;
  tamamoRUsed = 0;

  constructor(
    readonly encounter: GeneratedEncounter,
    readonly cfg: SimConfig,
  ) {
    this.player = { pos: { ...encounter.playerSpawn }, target: null };
    this.events = encounter.events.slice().sort((a, b) => a.atMs - b.atMs);
    this.minions = encounter.minions.map((spec) => ({ spec, hp: spec.startHp, alive: true, killedByPlayer: false }));
    this.enemy = { pos: { ...encounter.enemySpawns[0] }, target: null, nextDecisionAtMs: 0 };
    this.enemyRng = createRng(`${encounter.seed}:${encounter.definitionId}:enemy-ai`);
    const ai = cfg.enemyAi;
    this.holdWindows = [];
    if (encounter.events.some((e) => e.isMainThreat)) {
      this.holdWindows.push([encounter.threatStartMs - ai.holdBeforeThreatMs, Infinity]);
    }
    for (const ev of encounter.events) {
      if (ev.payload.type === "FAKE_CAST") this.holdWindows.push([ev.atMs - ai.holdBeforeFakeMs, ev.atMs + ev.payload.durationMs]);
      if (ev.payload.type === "STEP_IN") this.holdWindows.push([ev.atMs - 100, ev.atMs + ev.payload.durationMs]);
      if (ev.payload.type === "YONE_E") this.holdWindows.push([ev.atMs - 100, ev.payload.returnAtMs + ev.payload.returnMs]);
      if (ev.payload.type === "YONE_Q_VISUAL") this.holdWindows.push([ev.atMs - 50, ev.atMs + ev.payload.durationMs]);
      if (ev.payload.type === "TAMAMO_R") {
        const tm = cfg.tamamo;
        let until = ev.atMs + (tm.rMaxLength / tm.rSpeed) * 1000 + tm.rSettleMs;
        // 本命の直前のRは、着地点からそのままEを撃つ (着地後に歩き出さない)
        const nextR = encounter.events.find((x) => x.payload.type === "TAMAMO_R" && x.atMs > ev.atMs);
        if (!nextR && ev.atMs < encounter.threatStartMs) until = Math.max(until, encounter.threatStartMs);
        this.holdWindows.push([ev.atMs - 100, until]);
      }
    }
  }

  get finished(): boolean {
    return this.hit !== null || this.t >= this.encounter.roundDurationMs;
  }

  /**
   * 反応時間の基準。予定時刻以降で、本命が視界内に入り、かつ描画された時刻。
   * (本命Hazardがないラウンドは予定時刻)
   */
  get recognitionMs(): number {
    return this.recognitionVisibleMs ?? this.threatVisibleMs ?? this.encounter.recognitionMs;
  }

  private get hasMainHazard(): boolean {
    return this.encounter.events.some((e) => e.isMainThreat);
  }

  /** 描画側が本命Telegraphを実際に表示した時刻を通知する (視界内に入った後のみ有効) */
  markRecognitionVisible(atMs: number): void {
    if (this.recognitionVisibleMs !== null || atMs < this.encounter.recognitionMs) return;
    if (this.hasMainHazard && (this.threatVisibleMs === null || atMs < this.threatVisibleMs)) return;
    this.recognitionVisibleMs = atMs;
  }

  enemyPos(): Vec2 {
    const r = this.tamamoR;
    if (r && this.t >= r.atMs && this.t < r.endMs) {
      const k = (this.t - r.atMs) / Math.max(1, r.endMs - r.atMs);
      return add(r.from, scale(sub(r.to, r.from), k));
    }
    const e = this.yoneE;
    if (e && this.t >= e.returnAtMs) return this.enemy.pos;
    const dash = this.activeDash();
    if (dash) return dash.pos;
    const st = this.stepIn;
    if (st && this.t >= st.atMs && this.t < st.atMs + st.durationMs) {
      // 踏み込み: 28%で前進、保持、最後の33%で戻る
      const k = (this.t - st.atMs) / st.durationMs;
      const f = k < 0.28 ? k / 0.28 : k > 0.67 ? (1 - k) / 0.33 : 1;
      return add(st.from, scale(st.dir, st.distance * f));
    }
    return this.enemy.pos;
  }

  /** 相手チャンピオンが歩いている (演出用) */
  get enemyMoving(): boolean {
    const st = this.stepIn;
    const stepping = st !== null && this.t >= st.atMs && this.t < st.atMs + st.durationMs;
    const dash = this.activeDash();
    const e = this.yoneE;
    const eMoving = e !== null && ((this.t >= e.atMs && this.t < e.atMs + e.outMs) || (this.t >= e.returnAtMs && this.t < e.returnAtMs + e.returnMs));
    const rDash = this.tamamoR !== null && this.t >= this.tamamoR.atMs;
    return stepping || eMoving || rDash || (dash !== null && !dash.done) || (this.enemy.target !== null && !this.enemyHeld());
  }

  private activeDash(): DashHazard | null {
    return this.hazards.find((h): h is DashHazard => h.kind === "DASH" && !h.superseded && this.t >= h.payload.startAtMs) ?? null;
  }

  // ---- Input ----------------------------------------------------------------

  move(atMs: number, target: Vec2): void {
    if (this.finished) return;
    this.advanceTo(atMs);
    const clamped = clampToBounds(target, this.cfg.bounds);
    this.player.target = clamped;
    this.moves.push({ timestampMs: this.t, target: clamped });
  }

  tryFlash(atMs: number, cursor: Vec2): FlashRecord | null {
    if (this.finished || this.flash) return null;
    this.advanceTo(atMs);
    const rec = computeFlash(this.player.pos, cursor, this.cfg.flashMaxDistance, this.cfg.bounds, this.t);
    this.player.pos = rec.after;
    this.player.target = null;
    this.flash = rec;
    return rec;
  }

  /**
   * 右クリック: 攻撃範囲内の敵ミニオン上なら通常攻撃、それ以外 (地面・範囲外のミニオン) はその地点へ移動。
   * 戻り値は攻撃した場合の記録 (移動ならnull)
   */
  rightClick(atMs: number, pos: Vec2): AttackRecord | null {
    if (this.finished) return null;
    this.advanceTo(atMs);
    const target = this.minionUnder(pos);
    if (target && this.inAttackRange(target)) return this.attack(this.t, pos);
    this.move(this.t, pos);
    return null;
  }

  private minionUnder(cursor: Vec2): MinionState | undefined {
    return this.minions.find(
      (m) => m.alive && m.spec.team === "enemy" && distance(cursor, m.spec.pos) <= this.cfg.minionRadius[m.spec.kind] + CLICK_SLOP,
    );
  }

  /** 射程: Player中心からミニオン外周まで */
  private inAttackRange(m: MinionState): boolean {
    return distance(this.player.pos, m.spec.pos) - this.cfg.minionRadius[m.spec.kind] <= this.cfg.attack.range;
  }

  /** 敵ミニオンへの通常攻撃。とどめを刺すとCS。攻撃するとその場で立ち止まる */
  attack(atMs: number, cursor: Vec2): AttackRecord | null {
    if (this.finished) return null;
    this.advanceTo(atMs);
    const record = (result: AttackResult, minionId?: number): AttackRecord => {
      const r = { timestampMs: this.t, result, minionId };
      this.attacks.push(r);
      return r;
    };
    const target = this.minionUnder(cursor);
    if (!target) return record("no_target");
    if (this.t - this.lastAttackAtMs < this.cfg.attack.cooldownMs) return record("cooldown", target.spec.id);
    if (!this.inAttackRange(target)) return record("out_of_range", target.spec.id);
    this.player.target = null;
    this.lastAttackAtMs = this.t;
    target.hp -= this.cfg.attack.damage;
    target.lastHitByPlayerMs = this.t;
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.diedAtMs = this.t;
      target.killedByPlayer = true;
      return record("kill", target.spec.id);
    }
    return record("hit", target.spec.id);
  }

  get attackReadyAtMs(): number {
    return this.lastAttackAtMs + this.cfg.attack.cooldownMs;
  }

  // ---- Time -----------------------------------------------------------------

  advanceTo(targetMs: number): void {
    const end = Math.min(targetMs, this.encounter.roundDurationMs);
    while (this.t < end && !this.hit) {
      // 早送りの判定より先に、敵AIの判断 (目的地の選択) を済ませる
      this.updateEnemy(0);
      const enemyBoundary = this.nextEnemyBoundaryMs();
      if (!this.player.target && !this.enemy.target && !this.enemyMoving && !this.gankerWantsToMove() && !this.hazards.some((h) => !h.done)) {
        // 動的要素がない区間は次のイベントまで早送り (結果は逐次stepと同一)
        const nextAt = this.events[this.nextEventIdx]?.atMs ?? Infinity;
        if (nextAt > this.t) {
          // ミニオンの体力は線形に減るため、次に誰かが倒れる時刻までは一気に進めてよい
          const to = Math.max(this.t + 0.001, Math.min(end, nextAt, enemyBoundary, this.t + this.nextMinionDeathInMs()));
          this.stepMinions(to - this.t);
          this.t = to;
          this.updateEnemy(0);
          this.processEvents();
          this.checkThreatVisible();
          continue;
        }
      }
      // 敵AIの判断時刻・立ち止まり開始時刻ちょうどで区切る (描画の刻みに結果が左右されないように)
      const t1 = Math.min(end, this.t + this.cfg.stepMs, Math.max(enemyBoundary, this.t + 0.001));
      this.movePlayer(t1 - this.t);
      this.updateEnemy(t1 - this.t);
      this.updateGanker(t1 - this.t);
      this.stepMinions(t1 - this.t);
      this.t = t1;
      this.processEvents();
      this.updateHazards(t1);
      this.checkThreatVisible();
    }
  }

  private checkThreatVisible(): void {
    if (this.threatVisibleMs === null && this.t >= this.encounter.recognitionMs && this.mainThreatVisible()) {
      this.threatVisibleMs = this.t;
    }
  }

  /** 本命Hazardの見た目 (予兆・弾) のどこかがPlayerの視界内にあるか */
  mainThreatVisible(): boolean {
    const viewer = this.player.pos;
    const seen = (p: Vec2) => isVisible(p, viewer);
    const along = (a: Vec2, dir: Vec2, len: number) => {
      for (let d = 0; d <= len; d += 15) if (seen({ x: a.x + dir.x * d, y: a.y + dir.y * d })) return true;
      return false;
    };
    for (const h of this.hazards) {
      if (!h.isMain || h.done) continue;
      switch (h.kind) {
        case "LINE": {
          if (h.payload.style === "charm") {
            // 玉藻のEは範囲を表示しない: 詠唱する本人か、飛んでいくハートが見えているか
            if (!h.launched && seen(h.origin)) return true;
            if (h.launched) {
              const tail = Math.max(0, h.traveled - h.payload.bodyLength);
              if (along(add(h.origin, scale(h.dir, tail)), h.dir, Math.min(h.traveled, h.maxTravel) - tail)) return true;
            }
            break;
          }
          if (h.payload.style === "hook") {
            // クリッツブランクのQは範囲を表示しない: 詠唱する本人か、伸びていく腕と鎖が見えているか
            if (!h.launched && seen(h.origin)) return true;
            if (h.launched && along(h.origin, h.dir, Math.min(h.traveled, h.maxTravel))) return true;
            break;
          }
          const from = Math.max(0, h.traveled - h.payload.bodyLength);
          if (along(add(h.origin, scale(h.dir, from)), h.dir, h.maxTravel - from)) return true;
          break;
        }
        case "CIRCLE": {
          if (!h.locked) break;
          if (seen(h.center)) return true;
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            if (seen({ x: h.center.x + Math.cos(a) * h.radius * 0.9, y: h.center.y + Math.sin(a) * h.radius * 0.9 })) return true;
          }
          break;
        }
        case "DASH":
          // 米倉Q3は範囲を表示しないため、詠唱・突進する本人が見えているかで判定する
          if (h.payload.style === "q3") {
            if (seen(h.pos)) return true;
            break;
          }
          if (seen(h.pos) || along(h.from, normalize(sub(h.to, h.from)), h.total)) return true;
          break;
        case "SWEEP": {
          const front = Math.min(h.x, h.startX);
          for (let x = front; x >= 0; x -= 40) {
            for (let y = 0; y <= this.cfg.worldHeight; y += 30) if (seen({ x, y })) return true;
          }
          break;
        }
      }
    }
    return false;
  }

  outcome(): SimOutcome {
    let minClearance = Infinity;
    for (const h of this.hazards) if (h.isMain) minClearance = Math.min(minClearance, h.minClearance);
    return {
      hit: this.hit !== null,
      hitAtMs: this.hit?.atMs,
      flash: this.flash,
      moves: this.moves.slice(),
      minClearance,
      recognitionMs: this.recognitionMs,
      csCount: this.minions.filter((m) => m.killedByPlayer).length,
      csCannon: this.minions.filter((m) => m.killedByPlayer && m.spec.kind === "cannon").length,
    };
  }

  // ---- Internals ------------------------------------------------------------

  private enemyHeld(at = this.t): boolean {
    return this.holdWindows.some(([a, b]) => at >= a && at < b);
  }

  /** 戻り始める直前の位置 (Dash後ならDashの終点) */
  private enemyPosBeforeReturn(): Vec2 {
    const dash = this.activeDash();
    return dash ? dash.pos : this.enemy.pos;
  }

  /** 次に敵AIの状態が変わり得る時刻 (判断時刻 / 立ち止まり開始 / 米倉Eの区切り) */
  private nextEnemyBoundaryMs(): number {
    let next = Infinity;
    const e = this.yoneE;
    if (e) {
      for (const at of [e.atMs + e.outMs, e.returnAtMs, e.returnAtMs + e.returnMs]) if (at > this.t) next = Math.min(next, at);
    }
    if (!this.enemyHeld() && this.enemy.nextDecisionAtMs > this.t) next = this.enemy.nextDecisionAtMs;
    if (this.tamamoR && this.tamamoR.endMs > this.t) next = Math.min(next, this.tamamoR.endMs);
    const g = this.ganker;
    if (g?.payload.leaveAfterMs !== undefined) {
      const leaveAt = g.spawnedAtMs + g.payload.leaveAfterMs;
      if (leaveAt > this.t) next = Math.min(next, leaveAt);
    }
    for (const [a] of this.holdWindows) if (a > this.t) next = Math.min(next, a);
    return next;
  }

  /**
   * 相手チャンピオンの移動AI。ランダムな目的地へ歩き、目的地は常に
   * 「Playerから keepRange の距離・正面 (+x) ±sectorDeg・レーン内」から選ぶ。
   * 立ち止まる時間帯は動かない。Dash後はDashの終点に留まる。
   */
  private updateEnemy(dtMs: number): void {
    const r = this.tamamoR;
    if (r && this.t >= r.atMs) {
      // 玉藻R: ダッシュ中は移動AIを止め、着地したらその場所から再開する
      this.enemy.target = null;
      if (this.t < r.endMs) {
        this.enemy.pos = this.enemyPos();
        return;
      }
      this.enemy.pos = { ...r.to };
      this.tamamoR = null;
    }
    const e = this.yoneE;
    if (e && this.t >= e.returnAtMs) {
      // 米倉E: 時間切れで体の位置へ戻る (Q3/Rで動いた後でも戻る)
      if (!e.returnFrom) e.returnFrom = { ...this.enemyPosBeforeReturn() };
      const k = Math.min(1, (this.t - e.returnAtMs) / e.returnMs);
      this.enemy.pos = add(e.returnFrom, scale(sub(e.body, e.returnFrom), k));
      this.enemy.target = null;
      if (k >= 1) {
        // 戻り終わり: Eの状態を片付け、それ以前の突進の終点にも縛られないようにする
        for (const h of this.hazards) if (h.kind === "DASH") h.superseded = true;
        this.yoneE = null;
      }
      return;
    }
    const dash = this.activeDash();
    if (dash) {
      this.enemy.pos = { ...dash.pos };
      this.enemy.target = null;
      return;
    }
    if (e && this.t >= e.atMs) {
      const k = Math.min(1, (this.t - e.atMs) / e.outMs);
      this.enemy.pos = add(e.body, scale(sub(e.out, e.body), k));
      this.enemy.target = null;
      return;
    }
    if (this.enemyHeld()) {
      this.enemy.target = null;
      return;
    }
    const ai = this.cfg.enemyAi;
    const [min, max] = ai.keepRange;
    const inRange = (p: Vec2) => {
      const d = distance(p, this.player.pos);
      return d >= min - 30 && d <= max + 30;
    };
    const lost = !inRange(this.enemy.pos) && (this.enemy.target === null || !inRange(this.enemy.target));
    if (this.t >= this.enemy.nextDecisionAtMs || lost) this.decideEnemy(lost);
    const target = this.enemy.target;
    if (!target || dtMs <= 0) return;
    const step = (ai.speed * dtMs) / 1000;
    const d = distance(this.enemy.pos, target);
    if (d <= step) {
      this.enemy.pos = { ...target };
      this.enemy.target = null;
    } else {
      this.enemy.pos = add(this.enemy.pos, scale(normalize(sub(target, this.enemy.pos)), step));
    }
  }

  private decideEnemy(mustMove: boolean): void {
    const ai = this.cfg.enemyAi;
    const rng = this.enemyRng;
    this.enemy.nextDecisionAtMs = this.t + rng.range(ai.decisionMs[0], ai.decisionMs[1]);
    if (!mustMove && rng.chance(ai.idleChance)) {
      this.enemy.target = null;
      return;
    }
    const [min, max] = ai.keepRange;
    const sector = (ai.sectorDeg * Math.PI) / 180;
    const r = this.cfg.enemyRadius;
    const yMin = this.cfg.lane.top + ai.laneMargin;
    const yMax = this.cfg.lane.bottom - ai.laneMargin;
    let pick: Vec2 | null = null;
    for (let i = 0; i < 10; i++) {
      const a = rng.range(-sector, sector);
      const dist = rng.range(min, max);
      const p = {
        x: clamp(this.player.pos.x + Math.cos(a) * dist, r, this.cfg.worldWidth - r),
        y: clamp(this.player.pos.y + Math.sin(a) * dist, yMin, yMax),
      };
      pick = p;
      const d = distance(p, this.player.pos);
      if (d >= min && d <= max) break;
    }
    this.enemy.target = pick;
  }

  private opposingAlive(team: MinionSpec["team"]): boolean {
    return this.minions.some((m) => m.alive && m.spec.team !== team);
  }

  /** ミニオン同士の戦闘: 相手側が1体以上生きている間、体力が一定速度で減る */
  private stepMinions(dtMs: number): void {
    const draining = this.minions.filter((m) => m.alive && this.opposingAlive(m.spec.team));
    const deathAt = this.t + dtMs;
    for (const m of draining) {
      m.hp -= (m.spec.drainPerSec * dtMs) / 1000;
      if (m.hp <= 1e-6) {
        m.hp = 0;
        m.alive = false;
        m.diedAtMs = deathAt;
      }
    }
  }

  private nextMinionDeathInMs(): number {
    let next = Infinity;
    for (const m of this.minions) {
      if (!m.alive || !this.opposingAlive(m.spec.team) || m.spec.drainPerSec <= 0) continue;
      next = Math.min(next, (m.hp / m.spec.drainPerSec) * 1000);
    }
    return next;
  }

  private movePlayer(dtMs: number): void {
    const target = this.player.target;
    if (!target) return;
    const step = (this.cfg.moveSpeed * dtMs) / 1000;
    const d = distance(this.player.pos, target);
    if (d <= step) {
      this.player.pos = { ...target };
      this.player.target = null;
    } else {
      this.player.pos = add(this.player.pos, scale(normalize(sub(target, this.player.pos)), step));
    }
  }

  private processEvents(): void {
    while (this.nextEventIdx < this.events.length && this.events[this.nextEventIdx].atMs <= this.t) {
      const ev = this.events[this.nextEventIdx++];
      this.spawnHazard(ev);
    }
  }

  private captureAnchor(): Vec2 {
    if (this.anchor) return this.anchor;
    this.anchor = { ...this.player.pos };
    const hint = this.encounter.safeHint;
    if (hint) {
      const safe = add(this.anchor, hint);
      const b = this.cfg.bounds;
      this.mirror = { x: safe.x < b.minX || safe.x > b.maxX, y: safe.y < b.minY || safe.y > b.maxY };
    }
    return this.anchor;
  }

  private mx(v: number): number {
    return this.mirror.x ? -v : v;
  }

  private my(v: number): number {
    return this.mirror.y ? -v : v;
  }

  private spawnHazard(ev: ScheduledEvent): void {
    const p = ev.payload;
    if (p.type === "YONE_E") {
      // 前へ出る距離は、Playerに近づき過ぎないよう実行時に縮める
      const body = { ...this.enemy.pos };
      const toPlayer = sub(this.player.pos, body);
      const room = Math.max(0, Math.hypot(toPlayer.x, toPlayer.y) - this.cfg.yonekura.eKeepFromPlayer);
      const out = add(body, scale(normalize(toPlayer), Math.min(p.outDistance, room)));
      this.yoneE = { atMs: ev.atMs, outMs: p.outMs, body, out, returnAtMs: p.returnAtMs, returnMs: p.returnMs, returnFrom: null };
      return;
    }
    if (p.type === "TAMAMO_R") {
      this.castTamamoR(ev.atMs, p.toDistance, p.bearingRad);
      return;
    }
    if (p.type === "GANKER") {
      this.spawnGanker(ev.atMs, p);
      return;
    }
    if (p.type === "STEP_IN") {
      const from = { ...this.enemy.pos };
      this.stepIn = { atMs: ev.atMs, durationMs: p.durationMs, from, dir: normalize(sub(this.player.pos, from)), distance: p.distance };
      return;
    }
    if (p.type !== "LINE_SHOT" && p.type !== "CIRCLE" && p.type !== "DASH" && p.type !== "SWEEP") return;
    const anchor = this.captureAnchor();
    const base = {
      id: this.nextHazardId++,
      isMain: ev.isMainThreat,
      telegraphAtMs: ev.atMs,
      done: false,
      minClearance: Infinity,
    };
    switch (p.type) {
      case "LINE_SHOT": {
        let origin: Vec2;
        if (p.origin.mode === "ENEMY") {
          origin = this.enemyPos();
        } else if (p.origin.mode === "GANKER") {
          // 詠唱を始めたらその場で止まる
          if (this.ganker) this.ganker.casting = true;
          origin = this.ganker ? { ...this.ganker.pos } : this.enemyPos();
        } else if (p.origin.mode === "CROSS") {
          origin = this.crossOrigin(anchor, p.origin.edge, p.origin.angleRad);
        } else {
          const top = (p.origin.edge === "TOP") !== this.mirror.y;
          origin = {
            x: anchor.x + this.mx(p.origin.dxFromAnchor),
            y: top ? -EDGE_SPAWN_MARGIN : this.cfg.worldHeight + EDGE_SPAWN_MARGIN,
          };
        }
        let dir: Vec2;
        if (p.aim.mode === "FIXED_DIR") dir = normalize({ x: this.mx(p.aim.dir.x), y: this.my(p.aim.dir.y) });
        else if (p.aim.mode === "ANCHOR") dir = rotate(normalize(sub(anchor, origin)), p.aim.angleJitterRad);
        else dir = normalize(sub(this.player.pos, origin));
        this.hazards.push({
          ...base,
          kind: "LINE",
          payload: p,
          origin,
          dir,
          maxTravel: Math.min(p.maxTravel, this.exitDistance(origin, dir)),
          locked: p.aim.mode !== "TRACK",
          traveled: 0,
          launched: false,
        });
        break;
      }
      case "CIRCLE":
        this.hazards.push(this.makeCircle(base, p, anchor));
        break;
      case "DASH": {
        const from = this.enemyPos();
        const dir = normalize(sub(anchor, from));
        const r = this.cfg.enemyRadius;
        const end = p.length !== undefined ? add(from, scale(dir, p.length)) : add(anchor, scale(dir, p.overshoot));
        const to = clampToBounds(end, {
          minX: r,
          minY: r,
          maxX: this.cfg.worldWidth - r,
          maxY: this.cfg.worldHeight - r,
        });
        const total = distance(from, to);
        const arrivalAtMs = p.startAtMs + (total / p.speed) * 1000;
        this.hazards.push({ ...base, kind: "DASH", payload: p, from, to, pos: from, traveled: 0, total, arrivalAtMs });
        if (p.endBurst) {
          this.hazards.push({
            ...base,
            id: this.nextHazardId++,
            kind: "CIRCLE",
            center: to,
            radius: p.endBurst.radius,
            detonateAtMs: arrivalAtMs + p.endBurst.delayAfterArrivalMs,
            locked: true,
          });
        }
        break;
      }
      case "SWEEP": {
        const half = p.gapWidth / 2;
        const startX = anchor.x + p.startXOffset;
        this.hazards.push({
          ...base,
          kind: "SWEEP",
          payload: p,
          startX,
          x: startX,
          gapCenterY: clamp(anchor.y + this.my(p.gapOffsetY), half, this.cfg.worldHeight - half),
          launched: false,
        });
        break;
      }
    }
  }

  // ---- 玉藻 -------------------------------------------------------------------

  /** 玉藻R: 着地点へ向かって最大 rMaxLength だけダッシュする (回数を使い切ったら何もしない) */
  private castTamamoR(atMs: number, toDistance: number, bearingRad: number): void {
    const tm = this.cfg.tamamo;
    if (this.tamamoRUsed >= tm.rCharges) return;
    const from = { ...this.enemyPos() };
    const toEnemy = normalize(sub(from, this.player.pos));
    const r = this.cfg.enemyRadius;
    const margin = this.cfg.enemyAi.laneMargin;
    const landing = (bearing: number): Vec2 => {
      const desired = add(this.player.pos, scale(rotate(toEnemy, bearing), toDistance));
      const goal = {
        x: clamp(desired.x, r, this.cfg.worldWidth - r),
        y: clamp(desired.y, this.cfg.lane.top + margin, this.cfg.lane.bottom - margin),
      };
      const len = Math.min(distance(from, goal), tm.rMaxLength);
      return add(from, scale(normalize(sub(goal, from)), len));
    };
    // レーン端・画面端で押し戻されて狙いの距離にならない場合は、向きを変えて着地点を探す
    const candidates = [bearingRad, -bearingRad, bearingRad / 2, -bearingRad / 2, 0, 0.6, -0.6, 1, -1];
    let to = landing(bearingRad);
    let best = Infinity;
    for (const b of candidates) {
      const p = landing(b);
      const err = Math.abs(distance(p, this.player.pos) - toDistance);
      if (err < best - 1e-6) {
        best = err;
        to = p;
      }
      if (err <= 10) break;
    }
    const len = distance(from, to);
    this.tamamoR = { atMs, from, to, endMs: atMs + (len / tm.rSpeed) * 1000 };
    this.tamamoRUsed++;
  }

  /** 残りのRの回数 (演出用) */
  get tamamoRLeft(): number {
    return this.cfg.tamamo.rCharges - this.tamamoRUsed;
  }

  /**
   * 被弾後に自分のキャラが動かされる演出 (採点には影響しない)。
   * クリッツブランクのQ = 本人の前まで引き寄せ / 玉藻のE = 魅了されて玉藻の方へ歩かされる
   */
  hitDisplacement(): { kind: "hook" | "charm"; from: Vec2; to: Vec2; atMs: number; durationMs: number } | null {
    const hook = this.hookPull();
    if (hook) return { kind: "hook", ...hook, durationMs: this.cfg.kritz.pullMs };
    const hit = this.hit;
    if (!hit) return null;
    const h = this.hazards.find((x) => x.id === hit.hazardId);
    if (!h || h.kind !== "LINE" || h.payload.style !== "charm") return null;
    const tm = this.cfg.tamamo;
    const enemy = this.enemyPos();
    const room = Math.max(0, distance(hit.pos, enemy) - this.cfg.enemyRadius - this.cfg.playerRadius - 4);
    const walk = Math.min(room, (tm.charmSpeed * tm.charmMs) / 1000);
    return { kind: "charm", from: hit.pos, to: add(hit.pos, scale(normalize(sub(enemy, hit.pos)), walk)), atMs: hit.atMs, durationMs: tm.charmMs };
  }

  // ---- ガンク役 (クリッツブランク) ----------------------------------------------

  /** 陰の中のy (edge側の陰の境界から shadeDepth だけ奥) */
  private shadeY(edge: "TOP" | "BOTTOM"): number {
    const d = this.cfg.kritz.shadeDepth;
    return edge === "TOP" ? this.cfg.shade.top - d : this.cfg.shade.bottom + d;
  }

  /** 止まる位置: Playerから stopDistance、edge側へ stopAngleRad 傾けた向き */
  private gankerGoal(g: GankerState, from: Vec2 = this.player.pos): Vec2 {
    const p = g.payload;
    const ey = p.edge === "TOP" ? -1 : 1;
    return {
      x: from.x + g.sx * Math.cos(p.stopAngleRad) * p.stopDistance,
      y: from.y + ey * Math.sin(p.stopAngleRad) * p.stopDistance,
    };
  }

  private spawnGanker(atMs: number, p: GankerPayload): void {
    const r = this.cfg.kritz.radius;
    const minX = r + 20;
    const maxX = this.cfg.worldWidth - r - 20;
    const fits = (x: number) => x >= minX && x <= maxX;
    const pp = this.player.pos;
    const y = this.shadeY(p.edge);
    const g: GankerState = { payload: p, spawnedAtMs: atMs, pos: pp, spawn: pp, exit: null, sx: 1, casting: false, moving: false };
    // 右側 (相手側) から来る。はみ出す場合だけ左右を反転する
    const spawnFor = (sx: number): Vec2 => {
      g.sx = sx;
      switch (p.route) {
        case "AMBUSH": {
          const dy = Math.abs(y - pp.y);
          return { x: pp.x + sx * Math.sqrt(Math.max(0, p.stopDistance ** 2 - dy ** 2)), y };
        }
        case "PASS":
          return { x: pp.x + sx * p.spawnDx, y };
        default:
          return { x: this.gankerGoal(g).x + sx * p.spawnDx, y };
      }
    };
    let spawn = spawnFor(1);
    if (!fits(spawn.x) || (p.route !== "AMBUSH" && p.route !== "PASS" && !fits(this.gankerGoal(g).x))) spawn = spawnFor(-1);
    spawn = { x: clamp(spawn.x, minX, maxX), y };
    g.spawn = spawn;
    g.pos = { ...spawn };
    if (p.route === "PASS") g.exit = { x: spawn.x, y: this.shadeY(p.edge === "TOP" ? "BOTTOM" : "TOP") };
    this.ganker = g;
  }

  /** いま向かうべき地点 (止まっている・待機中は null) */
  private gankerTarget(g: GankerState): Vec2 | null {
    if (g.casting) return null;
    const p = g.payload;
    switch (p.route) {
      case "AMBUSH":
        return null;
      case "PASS":
        return g.exit;
      case "RETREAT":
        if (p.leaveAfterMs !== undefined && this.t >= g.spawnedAtMs + p.leaveAfterMs) return g.spawn;
        return this.clampGoal(this.gankerGoal(g));
      case "APPROACH":
        return this.clampGoal(this.gankerGoal(g));
    }
  }

  private clampGoal(p: Vec2): Vec2 {
    const r = this.cfg.kritz.radius;
    return clampToBounds(p, { minX: r, minY: r, maxX: this.cfg.worldWidth - r, maxY: this.cfg.worldHeight - r });
  }

  private gankerWantsToMove(): boolean {
    const g = this.ganker;
    if (!g) return false;
    const target = this.gankerTarget(g);
    return target !== null && distance(target, g.pos) > 0.01;
  }

  /** W (加速) 中か */
  gankerHasted(at = this.t): boolean {
    const g = this.ganker;
    return g !== null && at < g.spawnedAtMs + g.payload.hasteMs;
  }

  private updateGanker(dtMs: number): void {
    const g = this.ganker;
    if (!g) return;
    g.moving = false;
    const target = this.gankerTarget(g);
    if (!target || dtMs <= 0) return;
    const k = this.cfg.kritz;
    const step = ((this.gankerHasted() ? k.hasteSpeed : k.walkSpeed) * dtMs) / 1000;
    const d = distance(g.pos, target);
    if (d <= 0.01) return;
    g.moving = true;
    g.pos = d <= step ? { ...target } : add(g.pos, scale(normalize(sub(target, g.pos)), step));
  }

  /**
   * Qが当たったときの引き寄せ (演出用): 当たった位置から、クリッツブランクの正面まで
   */
  hookPull(): { from: Vec2; to: Vec2; atMs: number } | null {
    const hit = this.hit;
    const g = this.ganker;
    if (!hit || !g) return null;
    const h = this.hazards.find((x) => x.id === hit.hazardId);
    if (!h || h.kind !== "LINE" || h.payload.style !== "hook") return null;
    const gap = this.cfg.kritz.radius + this.cfg.playerRadius + 4;
    const back = normalize(sub(hit.pos, g.pos));
    return { from: hit.pos, to: add(g.pos, scale(back, gap)), atMs: hit.atMs };
  }

  /** 敵 -> anchor の線を angleRad 回した向きで anchor へ飛ぶ弾の、画面端の発射点 */
  private crossOrigin(anchor: Vec2, edge: "TOP" | "BOTTOM", angleRad: number): Vec2 {
    const d1 = normalize(sub(anchor, this.enemyPos()));
    const fits = (d: Vec2, top: boolean) => (top ? d.y >= 0.3 : d.y <= -0.3);
    let top = edge === "TOP";
    let d2 = rotate(d1, angleRad);
    if (!fits(d2, top)) {
      const alt = rotate(d1, -angleRad);
      if (fits(alt, top)) d2 = alt;
      else {
        d2 = Math.abs(alt.y) > Math.abs(d2.y) ? alt : d2;
        top = d2.y > 0;
      }
    }
    const edgeY = top ? -EDGE_SPAWN_MARGIN : this.cfg.worldHeight + EDGE_SPAWN_MARGIN;
    const k = Math.min(CROSS_MAX_REACH, Math.abs((anchor.y - edgeY) / (d2.y || 1e-6)));
    return sub(anchor, scale(d2, k));
  }

  private makeCircle(base: HazardBase, p: CirclePayload, anchor: Vec2): CircleHazard {
    if (p.center.mode === "TRACK") {
      return {
        ...base,
        kind: "CIRCLE",
        center: { ...this.player.pos },
        radius: p.radius,
        detonateAtMs: p.detonateAtMs,
        lockAtMs: p.center.lockAtMs,
        locked: false,
      };
    }
    const off = p.center.offset;
    return {
      ...base,
      kind: "CIRCLE",
      center: { x: anchor.x + this.mx(off.x), y: anchor.y + this.my(off.y) },
      radius: p.radius,
      detonateAtMs: p.detonateAtMs,
      locked: true,
    };
  }

  private registerClearance(h: Hazard, clearance: number): void {
    h.minClearance = Math.min(h.minClearance, clearance);
    if (clearance < 0 && h.isMain && !this.hit) {
      this.hit = { atMs: this.t, pos: { ...this.player.pos }, hazardId: h.id };
    }
  }

  /** originからdir方向に進み、画面外 (余白込み) へ出るまでの距離 */
  private exitDistance(origin: Vec2, dir: Vec2): number {
    const m = 80;
    const ts: number[] = [];
    if (dir.x > 1e-9) ts.push((this.cfg.worldWidth + m - origin.x) / dir.x);
    if (dir.x < -1e-9) ts.push((-m - origin.x) / dir.x);
    if (dir.y > 1e-9) ts.push((this.cfg.worldHeight + m - origin.y) / dir.y);
    if (dir.y < -1e-9) ts.push((-m - origin.y) / dir.y);
    return ts.length ? Math.max(0, Math.min(...ts)) : 0;
  }

  /**
   * 本命Hazardが現在のPlayer位置に対して判定を終えたか。
   * (ラウンド終了時に未消滅の弾があっても、Playerを通過済みなら解決済みとみなす)
   */
  mainThreatsResolved(): boolean {
    const pr = this.cfg.playerRadius;
    const pp = this.player.pos;
    return this.hazards.every((h) => {
      if (h.done || !h.isMain) return true;
      switch (h.kind) {
        case "LINE": {
          if (!h.launched) return false;
          const along = dot(sub(pp, h.origin), h.dir);
          return h.traveled - h.payload.bodyLength > along + h.payload.width / 2 + pr;
        }
        case "SWEEP":
          return h.launched && h.x + h.payload.thickness / 2 < pp.x - pr;
        default:
          return false;
      }
    });
  }

  private updateHazards(t1: number): void {
    const pr = this.cfg.playerRadius;
    const pp = this.player.pos;
    for (const h of this.hazards) {
      if (h.done) continue;
      switch (h.kind) {
        case "LINE": {
          const p = h.payload;
          if (!h.locked && p.aim.mode === "TRACK") {
            h.dir = normalize(sub(pp, h.origin));
            if (t1 >= p.aim.lockAtMs) h.locked = true;
          }
          if (t1 < p.launchAtMs) break;
          h.launched = true;
          const prevTail = Math.max(0, h.traveled - p.bodyLength);
          h.traveled = (p.speed * (t1 - p.launchAtMs)) / 1000;
          const a = add(h.origin, scale(h.dir, Math.min(prevTail, h.maxTravel)));
          const b = add(h.origin, scale(h.dir, Math.min(h.traveled, h.maxTravel)));
          this.registerClearance(h, capsuleClearance(pp, pr, a, b, p.width / 2));
          if (h.traveled - p.bodyLength >= h.maxTravel) h.done = true;
          break;
        }
        case "CIRCLE": {
          if (!h.locked) {
            h.center = { ...pp };
            if (h.lockAtMs !== undefined && t1 >= h.lockAtMs) h.locked = true;
          }
          if (t1 >= h.detonateAtMs) {
            this.registerClearance(h, circleClearance(pp, pr, h.center, h.radius));
            h.done = true;
          }
          break;
        }
        case "DASH": {
          const p = h.payload;
          if (t1 < p.startAtMs) break;
          const prev = h.pos;
          h.traveled = Math.min(h.total, (p.speed * (t1 - p.startAtMs)) / 1000);
          h.pos = add(h.from, scale(normalize(sub(h.to, h.from)), h.traveled));
          if (p.harmful) this.registerClearance(h, capsuleClearance(pp, pr, prev, h.pos, p.width / 2));
          if (h.traveled >= h.total) h.done = true;
          break;
        }
        case "SWEEP": {
          const p = h.payload;
          if (t1 < p.launchAtMs) break;
          h.launched = true;
          const prevX = h.x;
          h.x = h.startX - (p.speed * Math.max(0, t1 - p.launchAtMs)) / 1000;
          const minX = h.x - p.thickness / 2;
          const maxX = prevX + p.thickness / 2;
          if (pp.x + pr >= minX && pp.x - pr <= maxX) {
            const half = p.gapWidth / 2;
            const clearance = Math.min(pp.y - pr - (h.gapCenterY - half), h.gapCenterY + half - (pp.y + pr));
            this.registerClearance(h, clearance);
          }
          if (h.x + p.thickness / 2 < 0) h.done = true;
          break;
        }
      }
      if (this.hit) return;
    }
  }
}

export function pointInPlayBounds(p: Vec2, cfg: SimConfig): boolean {
  return inBounds(p, cfg.bounds);
}
