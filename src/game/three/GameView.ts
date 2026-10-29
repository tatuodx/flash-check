import * as THREE from "three";
import { GAME_CONFIG } from "../../config/balance";
import { add, normalize, scale, sub } from "../../domain/geometry";
import type { Hazard, LineHazard, MinionState, RoundSimulation } from "../../domain/simulation/RoundSimulation";
import type { ChampionId, ScheduledEvent, Vec2 } from "../../domain/types";
import { isVisible } from "../../domain/fieldLayout";
import type { RoundSystem } from "../systems/RoundSystem";
import { H, buildField, setPos, standHeight } from "./field";
import { makeChampion, makeKritz, makeMinion, makeTamamo, makeYonekura, type ChampionModel } from "./models";
import { Effects3D, FogMask, GroundOverlay } from "./pools";

const C = {
  danger: 0xff3b3b,
  tracking: 0xffa020,
  glow: 0xffe066,
  stance: 0xffffff,
  cs: 0xffd700,
  flash: 0x7ff9ff,
  moveMarker: 0x6dff8a,
  gap: 0xffffff,
  shadow: 0x000000,
};

const PR = GAME_CONFIG.player.radius;
const ER = GAME_CONFIG.enemy.radius;
/** ミニオンの体力バーの高さと幅 */
const MINION_BAR = { melee: { h: 30, w: 24 }, cannon: { h: 34, w: 32 } };
const PROJECTILE_HEIGHT = 16;
const KZ = GAME_CONFIG.gankers.kritz;
/** クリッツブランクの拳・鎖の高さ (モデルの右手の高さ) */
const HOOK_HEIGHT = 14;
/** Qが外れた後、拳が戻ってくる時間 (演出のみ) */
const HOOK_RETRACT_MS = 260;
const TM = GAME_CONFIG.champions.tamamo;
const PINK = 0xff6fae;

function active(ev: ScheduledEvent, t: number, durationMs: number): boolean {
  return t >= ev.atMs && t < ev.atMs + durationMs;
}

/** ゲーム座標の向き (dx, dy) をモデルのY回転へ (モデル正面 = +Z) */
function facing(dx: number, dy: number): number {
  return Math.atan2(dx, dy);
}

/**
 * RoundSystemの状態をThree.jsシーンへ反映する。
 * - world: 静的地形 (深度あり)
 * - overlay: 実Hitboxと一致する地面図形 (深度なし・常に可視)
 * - actors: キャラ・ミニオン・立体エフェクト
 */
export class GameView {
  readonly world = new THREE.Scene();
  readonly overlayScene = new THREE.Scene();
  readonly actors = new THREE.Scene();
  readonly fog = new FogMask();

  private readonly field: { update(t: number): void };
  private readonly overlay: GroundOverlay;
  private readonly fx: Effects3D;
  private readonly player: ChampionModel;
  /** 相手チャンピオンのモデル (ラウンドごとに切り替える) */
  private readonly enemyModels: Record<ChampionId, ChampionModel>;
  /** 米倉Eで残る「体」 (半透明) */
  private readonly yonekuraBody: ChampionModel;
  /** ガンク役 (クリッツブランク) */
  private readonly kritz: ReturnType<typeof makeKritz>;
  private kritzYaw = -Math.PI / 2;
  private kritzLast: Vec2 | null = null;
  /** MinionSpecの並び (味方 小,小,砲台 → 敵 小,小,砲台) と同じ順のモデル */
  private readonly minionModels: THREE.Group[] = [];
  private camera: THREE.Camera | null = null;
  private readonly silhouettes: ChampionModel[] = [];
  private playerYaw = Math.PI / 2;
  /** 今フレームの視界判定 (Player位置から見えるか) */
  private seen: (p: Vec2) => boolean = () => true;

  constructor() {
    this.world.background = new THREE.Color(0x10180f);
    addLights(this.world, true);
    addLights(this.actors, false);
    this.field = buildField(this.world);
    this.overlay = new GroundOverlay(this.overlayScene);
    this.fx = new Effects3D(this.actors);

    this.player = makeChampion("player");
    this.enemyModels = { default: makeChampion("enemy"), yonekura: makeYonekura(), tamamo: makeTamamo() };
    this.yonekuraBody = makeYonekura();
    this.yonekuraBody.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.35, depthWrite: false });
    });
    this.kritz = makeKritz();
    this.actors.add(this.player.root, this.enemyModels.default.root, this.enemyModels.yonekura.root, this.enemyModels.tamamo.root, this.yonekuraBody.root, this.kritz.root);
    for (const team of ["ally", "enemy"] as const) {
      for (const slot of GAME_CONFIG.minions.layout[team]) {
        const m = makeMinion(team, slot.kind);
        this.minionModels.push(m);
        this.actors.add(m);
      }
    }
    for (let i = 0; i < 2; i++) {
      const s = makeChampion("enemy");
      s.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        // 陰の中でも見えるよう、真っ黒ではなく暗い紫の影にする
        if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ color: 0x4a3c66, transparent: true, opacity: 0.5 });
      });
      this.silhouettes.push(s);
      this.actors.add(s.root);
    }
  }

  sync(rs: RoundSystem, now: number, camera: THREE.Camera): void {
    this.camera = camera;
    this.overlay.begin();
    this.fx.begin();
    const sim = rs.sim;
    const showWorld = rs.phase !== "INTRO" && rs.phase !== "COMPLETE";
    // 判定確定後も演出用の時間は進める
    const vt = showWorld ? rs.roundTime(now) : 0;
    const t = sim.t;
    const viewer = showWorld ? { ...sim.player.pos } : sim.encounter.playerSpawn;
    this.seen = (p) => isVisible(p, viewer);
    this.fog.update(viewer);
    this.overlay.clip = true;
    this.fx.clip = true;

    this.hideDynamicActors();
    this.drawMinions(sim, vt, showWorld);
    if (showWorld) {
      this.drawNeutral(sim, vt);
      for (const h of sim.hazards) this.drawHazard(h, t, vt);
    }
    this.drawEntities(sim, t, vt, showWorld);
    if (showWorld) this.drawFx(sim, vt);
    this.field.update(now);

    this.overlay.end();
    this.fx.end();
  }

  dispose(): void {
    this.overlay.dispose();
    for (const scene of [this.world, this.overlayScene, this.actors]) {
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m.dispose());
      });
    }
  }

  // ---- Neutral / distractors ------------------------------------------------

  private hideDynamicActors(): void {
    for (const m of this.minionModels) m.visible = false;
    for (const s of this.silhouettes) s.root.visible = false;
  }

  /** ミニオン同士の戦闘 (位置は固定、殴りかかる動きと体力バー) */
  private drawMinions(sim: RoundSimulation, vt: number, showWorld: boolean): void {
    const o = this.overlay;
    const deathFx = 450;
    sim.minions.forEach((m, i) => {
      const model = this.minionModels[i];
      if (!model) return;
      const { x, y } = m.spec.pos;
      const since = m.diedAtMs !== undefined ? vt - m.diedAtMs : -1;
      if (!m.alive && (!showWorld || since > deathFx)) return;
      if (!this.seen({ x, y })) return;
      // 一番近い相手側のミニオンへ向き、周期的に踏み込む
      const foe = nearestFoe(sim.minions, m);
      let dx = m.spec.team === "ally" ? 1 : -1;
      let dy = 0;
      if (foe) {
        const d = Math.hypot(foe.spec.pos.x - x, foe.spec.pos.y - y) || 1;
        dx = (foe.spec.pos.x - x) / d;
        dy = (foe.spec.pos.y - y) / d;
      }
      const fighting = showWorld && m.alive && foe !== null;
      const phase = ((vt + m.spec.id * 277) % 900) / 900;
      const lunge = fighting ? Math.max(0, Math.sin(phase * Math.PI * 2)) * (m.spec.kind === "cannon" ? 2 : 6) : 0;
      const px = x + dx * lunge;
      const py = y + dy * lunge;
      model.visible = true;
      const sink = m.alive ? 0 : since / deathFx;
      setPos(model, px, py, standHeight(px, py) - sink * 14);
      model.rotation.y = facing(dx, dy);
      model.scale.setScalar(m.alive ? 1 : 1 - sink * 0.5);
      o.disk(px, py, GAME_CONFIG.minions[m.spec.kind].radius * 0.9, C.shadow, 0.3);
      if (!m.alive) {
        if (m.killedByPlayer) {
          // ラストヒット成功: 金色の光が昇る
          this.fx.sphere(x, y, 20 + since / 12, 6 + since / 60, C.cs, 0.9 * (1 - since / deathFx), true);
        }
        return;
      }
      const killable = m.spec.team === "enemy" && m.hp <= GAME_CONFIG.attack.damage;
      if (killable) o.ring(x, y, GAME_CONFIG.minions[m.spec.kind].radius + 5, 2.5, C.cs, 0.95);
      const bar = MINION_BAR[m.spec.kind];
      const fill = m.spec.team === "ally" ? 0x5aa0ff : killable ? C.cs : 0xd36cff;
      if (this.camera) this.fx.bar(x, y, standHeight(x, y) + bar.h, bar.w, m.hp / m.spec.maxHp, fill, this.camera);
      // Playerの攻撃が当たった瞬間の閃光
      if (m.lastHitByPlayerMs !== undefined && vt - m.lastHitByPlayerMs < 140) {
        this.fx.sphere(x, y, 12, 9, 0xffffff, 0.7 * (1 - (vt - m.lastHitByPlayerMs) / 140), true);
      }
    });
  }

  private drawNeutral(sim: RoundSimulation, vt: number): void {
    let sil = 0;
    for (const ev of sim.encounter.events) {
      const p = ev.payload;
      switch (p.type) {
        case "EDGE_SHADOW":
          if (active(ev, vt, p.durationMs) && sil < this.silhouettes.length) {
            const k = (vt - ev.atMs) / p.durationMs;
            const s = this.silhouettes[sil++];
            // 陰の中では見えないため、視界の境界のすぐ内側に一瞬だけ姿を見せる
            const { shadeTop, shadeBottom } = GAME_CONFIG.world.vision;
            const y = p.edge === "TOP" ? shadeTop + 14 : shadeBottom - 14;
            s.root.visible = this.seen({ x: p.x, y });
            setPos(s.root, p.x, y, standHeight(p.x, y));
            s.root.rotation.y = facing(0, p.edge === "TOP" ? 1 : -1);
            s.root.traverse((o) => {
              const mesh = o as THREE.Mesh;
              if (mesh.isMesh) (mesh.material as THREE.MeshBasicMaterial).opacity = 0.6 * Math.sin(Math.PI * k);
            });
          }
          break;
        case "FAKE_MARKER":
          if (active(ev, vt, p.durationMs)) this.drawMarker(sim.player.pos, vt);
          break;
        default:
          break;
      }
    }
  }

  private drawMarker(pos: Vec2, vt: number): void {
    const o = this.overlay;
    const r = 30 + 4 * Math.sin(vt / 60);
    o.ring(pos.x, pos.y, r, 3, C.tracking, 0.95);
    o.line({ x: pos.x - r - 8, y: pos.y }, { x: pos.x - r + 8, y: pos.y }, 3, C.tracking, 0.95);
    o.line({ x: pos.x + r - 8, y: pos.y }, { x: pos.x + r + 8, y: pos.y }, 3, C.tracking, 0.95);
    o.line({ x: pos.x, y: pos.y - r - 8 }, { x: pos.x, y: pos.y - r + 8 }, 3, C.tracking, 0.95);
    o.line({ x: pos.x, y: pos.y + r - 8 }, { x: pos.x, y: pos.y + r + 8 }, 3, C.tracking, 0.95);
  }

  // ---- Hazards ------------------------------------------------------------------

  private drawHazard(h: Hazard, t: number, vt: number): void {
    const o = this.overlay;
    switch (h.kind) {
      case "LINE": {
        const p = h.payload;
        if (!h.locked) {
          // Tracking中: 橙の照準線 (まだ危険領域ではない)
          o.dashed(h.origin, add(h.origin, scale(h.dir, 900)), 3, 14, 10, C.tracking, 0.9);
          break;
        }
        // クリッツブランクのQは範囲を表示しない (拳と鎖は drawGanker で描く)
        if (p.style === "hook") break;
        if (p.style === "charm") {
          this.drawCharm(h, t, vt);
          break;
        }
        if (h.done) break;
        const tailStart = Math.max(0, h.traveled - p.bodyLength);
        const from = add(h.origin, scale(h.dir, tailStart));
        o.corridor(from, h.dir, h.maxTravel - tailStart, p.width, C.danger, 0.22);
        o.corridorOutline(from, h.dir, h.maxTravel - tailStart, p.width, 2, C.danger, 0.8);
        if (h.launched) {
          const a = add(h.origin, scale(h.dir, Math.min(tailStart, h.maxTravel)));
          const b = add(h.origin, scale(h.dir, Math.min(h.traveled, h.maxTravel)));
          // 地面の弾体 = 実Hitbox
          o.line(a, b, p.width, C.danger, 0.75);
          o.disk(a.x, a.y, p.width / 2, C.danger, 0.75);
          o.disk(b.x, b.y, p.width / 2, C.danger, 0.75);
          // 立体の弾 (装飾)
          if (this.seen(b)) {
            this.fx.rod(a, b, PROJECTILE_HEIGHT, p.width * 0.25, 0xff7070, 0.9);
            this.fx.sphere(b.x, b.y, PROJECTILE_HEIGHT, p.width * 0.32, 0xff5050, 0.95);
            this.fx.sphere(b.x, b.y, PROJECTILE_HEIGHT, p.width * 0.5, 0xff2020, 0.35, true);
          }
        } else {
          const k = Math.min(1, (t - h.telegraphAtMs) / Math.max(1, p.launchAtMs - h.telegraphAtMs));
          o.corridor(h.origin, h.dir, 120 * k, p.width * 0.5, C.danger, 0.5);
        }
        break;
      }
      case "CIRCLE": {
        const c = h.center;
        if (!h.locked) {
          this.drawMarker(c, vt);
          break;
        }
        if (h.done) {
          const since = vt - h.detonateAtMs;
          if (since < 260) {
            const k = since / 260;
            o.disk(c.x, c.y, h.radius, C.danger, 0.6 * (1 - k));
            if (this.seen(c)) this.fx.sphere(c.x, c.y, 0, h.radius * (0.6 + 0.4 * k), 0xff3030, 0.35 * (1 - k), true);
          }
          break;
        }
        const start = h.lockAtMs ?? h.telegraphAtMs;
        const k = Math.min(1, Math.max(0, (t - start) / Math.max(1, h.detonateAtMs - start)));
        o.disk(c.x, c.y, h.radius, C.danger, 0.2);
        o.disk(c.x, c.y, h.radius * k, C.danger, 0.35);
        o.ring(c.x, c.y, h.radius, 3, C.danger, 0.95);
        break;
      }
      case "DASH": {
        const p = h.payload;
        if (p.style === "r" && h.done) {
          // 米倉R: 斬り抜けた軌跡に閃光 (判定はもう終わっている)
          const since = vt - h.arrivalAtMs;
          if (since < 280) {
            const a = 1 - since / 280;
            const d = normalize(sub(h.to, h.from));
            const n = { x: -d.y, y: d.x };
            o.line(h.from, h.to, 6, 0xffffff, 0.9 * a);
            for (let k = 40; k < h.total; k += 70) {
              const c = add(h.from, scale(d, k));
              o.line(add(c, scale(add(n, scale(d, 0.6)), p.width / 2)), sub(c, scale(add(n, scale(d, 0.6)), p.width / 2)), 3, 0xdff4ff, 0.8 * a);
            }
          }
          break;
        }
        if (h.done) break;
        const dir = normalize(sub(h.to, h.from));
        if (p.harmful) {
          // 米倉Q3は本家同様に範囲を表示しない (詠唱の光・剣の風・竜巻だけが手がかり)
          if (p.style !== "q3") {
            const from = add(h.from, scale(dir, h.traveled));
            o.corridor(from, dir, h.total - h.traveled, p.width, C.danger, 0.22);
            o.corridorOutline(from, dir, h.total - h.traveled, p.width, 2, C.danger, 0.8);
            if (t >= p.startAtMs) o.disk(h.pos.x, h.pos.y, p.width / 2, C.danger, 0.6);
          }
          if (p.style === "q3" && t >= p.startAtMs) {
            // 米倉Q3: 突進の先端に竜巻
            for (let i = 0; i < 5; i++) {
              const ang = vt / 50 + i * 1.3;
              const r = 6 + i * 2.5;
              this.fx.sphere(h.pos.x + Math.cos(ang) * r, h.pos.y + Math.sin(ang) * r, 6 + i * 9, 7 + i * 2, 0xeef9ff, 0.55, true);
            }
          }
        } else {
          o.dashed(h.from, h.to, 2, 12, 10, C.stance, 0.5);
        }
        break;
      }
      case "SWEEP": {
        const p = h.payload;
        if (h.done) break;
        const half = p.gapWidth / 2;
        const top = h.gapCenterY - half;
        const bottom = h.gapCenterY + half;
        const front = Math.min(h.x, h.startX);
        o.quad(front / 2, top / 2, front, top, 0, C.danger, 0.2);
        o.quad(front / 2, (bottom + H) / 2, front, H - bottom, 0, C.danger, 0.2);
        // Gap: 色だけでなく形状 (白い山形) でも識別可能にする
        for (let x = 20; x < front; x += 60) {
          o.line({ x, y: top }, { x: x + 14, y: top + 8 }, 3, C.gap, 0.95);
          o.line({ x: x + 14, y: top + 8 }, { x: x + 28, y: top }, 3, C.gap, 0.95);
          o.line({ x, y: bottom }, { x: x + 14, y: bottom - 8 }, 3, C.gap, 0.95);
          o.line({ x: x + 14, y: bottom - 8 }, { x: x + 28, y: bottom }, 3, C.gap, 0.95);
        }
        const bx = h.launched ? h.x : h.startX;
        const th = p.thickness / 2;
        o.quad(bx, top / 2, p.thickness, top, 0, C.danger, h.launched ? 0.85 : 0.5);
        o.quad(bx, (bottom + H) / 2, p.thickness, H - bottom, 0, C.danger, h.launched ? 0.85 : 0.5);
        // 立体の壁 (視界内の範囲だけ立ち上げる)
        const wallH = h.launched ? 34 : 10;
        const { shadeTop, shadeBottom } = GAME_CONFIG.world.vision;
        if (top > shadeTop) this.fx.box(bx - th, shadeTop, bx + th, top, wallH, 0xff4848, h.launched ? 0.55 : 0.3);
        if (bottom < shadeBottom) this.fx.box(bx - th, bottom, bx + th, shadeBottom, wallH, 0xff4848, h.launched ? 0.55 : 0.3);
        break;
      }
    }
  }

  // ---- Entities / FX -------------------------------------------------------------

  private enemyCasting(sim: RoundSimulation, t: number): "glow" | "stance" | null {
    for (const ev of sim.encounter.events) {
      const p = ev.payload;
      if (p.type === "LINE_SHOT" && p.enemyCast && t >= ev.atMs && t < p.launchAtMs) return "glow";
      if (p.type === "FAKE_CAST" && active(ev, t, p.durationMs)) return "glow";
      if (p.type === "STEP_IN" && active(ev, t, p.durationMs)) return "stance";
      if (p.type === "YONE_E" && t >= ev.atMs && t < p.returnAtMs) return "stance";
      if (p.type === "DASH" && t >= ev.atMs && t < p.startAtMs) return "glow";
    }
    return null;
  }

  /** 米倉の演出: Eの体と糸、Q1/Q2の突き、Q3の準備 (剣にまとう風) */
  private drawYonekura(sim: RoundSimulation, enemy: Vec2, vt: number): void {
    const o = this.overlay;
    const e = sim.yoneE;
    const body = this.yonekuraBody;
    body.root.visible = false;
    if (e && sim.t >= e.atMs) {
      if (this.seen(e.body)) {
        body.root.visible = true;
        setPos(body.root, e.body.x, e.body.y, standHeight(e.body.x, e.body.y));
        body.root.rotation.y = facing(e.out.x - e.body.x, e.out.y - e.body.y);
      }
      o.line(e.body, enemy, 2, 0x9fd8ff, 0.6);
    }
    let qStacks = 0;
    let q3Used = false;
    for (const ev of sim.encounter.events) {
      const p = ev.payload;
      if (p.type === "DASH" && p.style === "q3" && sim.t >= ev.atMs) q3Used = true;
      if (p.type !== "YONE_Q_VISUAL" || vt < ev.atMs) continue;
      qStacks = Math.max(qStacks, p.stack);
      const since = vt - ev.atMs;
      if (since >= p.durationMs) continue;
      // 一番近い相手側 (味方) のミニオンへ突く。演出のみで判定・ダメージなし
      let target: Vec2 = { x: enemy.x - 80, y: enemy.y };
      let best = Infinity;
      for (const m of sim.minions) {
        if (!m.alive || m.spec.team !== "ally") continue;
        const d = Math.hypot(m.spec.pos.x - enemy.x, m.spec.pos.y - enemy.y);
        if (d < best) {
          best = d;
          target = m.spec.pos;
        }
      }
      const d = Math.hypot(target.x - enemy.x, target.y - enemy.y) || 1;
      const reach = Math.min(d, 90);
      const tip = { x: enemy.x + ((target.x - enemy.x) / d) * reach, y: enemy.y + ((target.y - enemy.y) / d) * reach };
      const a = 1 - since / p.durationMs;
      o.line(enemy, tip, 6, 0xffffff, 0.75 * a);
      this.fx.sphere(tip.x, tip.y, 14, 7 + since / 30, 0xdff4ff, 0.6 * a, true);
    }
    if (qStacks >= 2 && !q3Used) {
      // Q3の準備ができた合図: 剣のまわりに風がまとう
      for (let i = 0; i < 3; i++) {
        const ang = vt / 160 + (i * Math.PI * 2) / 3;
        this.fx.sphere(enemy.x + Math.cos(ang) * 22, enemy.y + Math.sin(ang) * 22, 22 + i * 6, 4, 0xe8fbff, 0.8, true);
      }
    }
  }

  /**
   * 被弾後に動かされる自分の表示位置。
   * クリッツブランクのQ = 本人の前まで引き寄せ (加減速あり) / 玉藻のE = 魅了されて一定の速さで歩かされる
   */
  private pulledPlayerPos(sim: RoundSimulation, vt: number): Vec2 {
    const d = sim.hitDisplacement();
    if (!d) return sim.player.pos;
    const k = Math.min(1, Math.max(0, (vt - d.atMs) / d.durationMs));
    const e = d.kind === "hook" ? k * k * (3 - 2 * k) : k;
    return add(d.from, scale(sub(d.to, d.from), e));
  }

  /** 玉藻のE: 範囲は表示せず、飛んでいく桃色のハートだけを描く */
  private drawCharm(h: LineHazard, t: number, vt: number): void {
    if (!h.launched || h.done) return;
    const p = h.payload;
    const head = add(h.origin, scale(h.dir, Math.min(h.traveled, h.maxTravel)));
    if (!this.seen(head)) return;
    this.overlay.disk(head.x, head.y, p.width * 0.3, C.shadow, 0.3);
    // ハート: 上の2つの丸 + 下の小さな丸 (カメラ側から見て横に並ぶよう、進行方向に垂直に置く)
    const n = { x: -h.dir.y, y: h.dir.x };
    const bob = 3 * Math.sin(vt / 60);
    const y = PROJECTILE_HEIGHT + 4 + bob;
    for (const s of [-1, 1]) this.fx.sphere(head.x + n.x * 6 * s, head.y + n.y * 6 * s, y + 4, 7, PINK, 0.95);
    this.fx.sphere(head.x + h.dir.x * 4, head.y + h.dir.y * 4, y - 3, 5.5, PINK, 0.95);
    this.fx.sphere(head.x, head.y, y, 16, 0xff9ccc, 0.35, true);
    // 尾を引く桃色の粒
    for (let i = 1; i <= 3; i++) {
      const b = sub(head, scale(h.dir, i * 14));
      this.fx.sphere(b.x, b.y, y, 6 - i, 0xffc4de, 0.5 - i * 0.12, true);
    }
    void t;
  }

  /** 玉藻の演出: 残りのRの回数を表す狐火 (頭上を回る玉) とRの残像 */
  private drawTamamo(sim: RoundSimulation, enemy: Vec2, vt: number, seen: boolean): void {
    if (!seen) return;
    const left = sim.tamamoRLeft;
    for (let i = 0; i < left; i++) {
      const a = vt / 400 + (i * Math.PI * 2) / TM.rCharges;
      this.fx.sphere(enemy.x + Math.cos(a) * 22, enemy.y + Math.sin(a) * 22, 64, 6.5, 0xbfe9ff, 0.95, true);
    }
    const r = sim.tamamoR;
    if (r && sim.t >= r.atMs) {
      // R: 走った軌跡に桃色の残像
      const k = Math.min(1, (sim.t - r.atMs) / Math.max(1, r.endMs - r.atMs));
      for (let i = 1; i <= 4; i++) {
        const f = Math.max(0, k - i * 0.15);
        const p = add(r.from, scale(sub(r.to, r.from), f));
        this.fx.sphere(p.x, p.y, 24, 12 - i * 1.5, PINK, 0.35 - i * 0.06, true);
      }
    }
  }

  /**
   * ガンク役 (クリッツブランク): 陰からW (蒸気を噴いて加速) で来る / 潜んだままQ。
   * Qは範囲を表示せず、詠唱で拳が光り、飛んでいく拳と鎖だけを見せる
   */
  private drawGanker(sim: RoundSimulation, t: number, vt: number, showWorld: boolean): void {
    const model = this.kritz;
    const g = sim.ganker;
    model.root.visible = false;
    model.weapon.visible = true;
    if (!g || !showWorld) {
      this.kritzLast = null;
      return;
    }
    const o = this.overlay;
    const pos = g.pos;
    const seen = this.seen(pos);
    const hook = sim.hazards.find((h): h is LineHazard => h.kind === "LINE" && h.payload.style === "hook") ?? null;
    const pp = this.pulledPlayerPos(sim, vt);

    // 向き: 動いている間は進行方向、止まったらPlayer (Q中は撃った方向)
    const last = this.kritzLast;
    if (hook) this.kritzYaw = facing(hook.dir.x, hook.dir.y);
    else if (g.moving && last && (pos.x !== last.x || pos.y !== last.y)) this.kritzYaw = facing(pos.x - last.x, pos.y - last.y);
    else if (!g.moving) this.kritzYaw = facing(pp.x - pos.x, pp.y - pos.y);
    this.kritzLast = { ...pos };

    o.disk(pos.x, pos.y, KZ.radius, C.shadow, 0.35);
    o.ring(pos.x, pos.y, KZ.radius, 2, 0xc28cff, 0.8);
    model.root.visible = seen;
    setPos(model.root, pos.x, pos.y, standHeight(pos.x, pos.y));
    model.root.rotation.y = this.kritzYaw;
    const hasted = sim.gankerHasted();
    const swing = g.moving ? Math.sin(vt / (hasted ? 40 : 70)) * 0.8 : 0;
    model.legs[0].rotation.x = swing;
    model.legs[1].rotation.x = -swing;

    // W: 煙突から蒸気、足元に橙の加速の輪と残像
    if (hasted && g.moving) {
      o.ring(pos.x, pos.y, KZ.radius + 6, 3, 0xff9a3c, 0.85);
      for (let i = 0; i < 4; i++) {
        const k = ((vt / 380 + i / 4) % 1);
        const back = { x: Math.sin(this.kritzYaw), y: Math.cos(this.kritzYaw) };
        this.fx.sphere(pos.x - back.x * (10 + k * 26), pos.y - back.y * (10 + k * 26), 50 + k * 30, 5 + k * 9, 0xf4f4f4, 0.55 * (1 - k), false);
      }
    }

    const fistMat = model.weapon.material as THREE.MeshLambertMaterial;
    fistMat.emissive.setHex(0x000000);
    if (!hook) return;
    const p = hook.payload;
    const hand = add(pos, scale(hook.dir, KZ.radius));
    if (!hook.launched) {
      // 詠唱: 右の拳が光る (範囲は見せない)
      fistMat.emissive.setHex(0xffaa22);
      o.ring(pos.x, pos.y, KZ.radius + 8, 4, C.glow, 1);
      if (seen) this.fx.sphere(hand.x, hand.y, HOOK_HEIGHT + 4, 10 + 3 * Math.sin(t / 40), C.glow, 0.35, true);
      return;
    }
    // 拳の位置: 伸びる → (外れたら) 戻る / (当たったら) Playerごと戻る
    const pull = sim.hookPull();
    let reach: number;
    if (pull) {
      reach = Math.max(0, distance2(hand, pp) - PR * 0.5);
    } else if (!hook.done) {
      reach = Math.min(hook.traveled, hook.maxTravel);
    } else {
      const doneAt = p.launchAtMs + ((hook.maxTravel + p.bodyLength) / p.speed) * 1000;
      const k = Math.min(1, Math.max(0, (vt - doneAt) / HOOK_RETRACT_MS));
      reach = hook.maxTravel * (1 - k);
    }
    if (reach <= 1) return;
    const dir = pull ? normalize(sub(pp, hand)) : hook.dir;
    const head = add(hand, scale(dir, reach));
    model.weapon.visible = false;
    o.disk(head.x, head.y, p.width * 0.3, C.shadow, 0.3);
    // 鎖 (輪をつないだように明暗を交互に) と拳
    const links = Math.max(1, Math.floor(reach / 12));
    for (let i = 0; i < links; i++) {
      const a = add(hand, scale(dir, (reach * i) / links));
      const b = add(hand, scale(dir, (reach * (i + 0.8)) / links));
      this.fx.rod(a, b, HOOK_HEIGHT, 3, i % 2 ? 0x8d8f94 : 0xc4c7cc, 1);
    }
    this.fx.sphere(head.x, head.y, HOOK_HEIGHT, 10, 0xe0a040, 1);
    this.fx.sphere(head.x, head.y, HOOK_HEIGHT, 15, 0xffc060, 0.35, true);
  }

  private animateLegs(model: ChampionModel, moving: boolean, vt: number): void {
    const swing = moving ? Math.sin(vt / 70) * 0.7 : 0;
    model.legs[0].rotation.x = swing;
    model.legs[1].rotation.x = -swing;
  }

  private drawEntities(sim: RoundSimulation, t: number, vt: number, showWorld: boolean): void {
    const o = this.overlay;
    // ---- Enemy
    const enemy = showWorld ? sim.enemyPos() : sim.encounter.enemySpawns[0];
    const pp = showWorld ? this.pulledPlayerPos(sim, vt) : sim.encounter.playerSpawn;
    const cast = showWorld ? this.enemyCasting(sim, t) : null;
    o.disk(enemy.x, enemy.y, ER, C.shadow, 0.35);
    o.ring(enemy.x, enemy.y, ER, 2, 0xc28cff, 0.8);
    const enemySeen = this.seen(enemy);
    const champion = sim.encounter.champion;
    const model = this.enemyModels[champion];
    this.enemyModels.default.root.visible = champion === "default" && enemySeen;
    this.enemyModels.yonekura.root.visible = champion === "yonekura" && enemySeen;
    this.enemyModels.tamamo.root.visible = champion === "tamamo" && enemySeen;
    if (champion === "tamamo" && showWorld) this.drawTamamo(sim, enemy, vt, enemySeen);
    if (champion === "yonekura" && showWorld) this.drawYonekura(sim, enemy, vt);
    else this.yonekuraBody.root.visible = false;
    this.drawGanker(sim, t, vt, showWorld);
    if (cast === "glow") {
      o.ring(enemy.x, enemy.y, ER + 8, 4, C.glow, 1);
      if (enemySeen) this.fx.sphere(enemy.x, enemy.y, 30, ER + 12 + 3 * Math.sin(t / 40), C.glow, 0.25, true);
    } else if (cast === "stance") {
      o.ring(enemy.x, enemy.y, ER + 8, 3, C.stance, 0.9);
    }
    const weaponMat = model.weapon.material as THREE.MeshLambertMaterial;
    const idleEmissive = { default: 0x332200, yonekura: 0x0a2233, tamamo: 0x330a1c }[champion];
    weaponMat.emissive.setHex(cast === "glow" ? (champion === "tamamo" ? 0xff3d8a : 0xffcc33) : idleEmissive);
    setPos(model.root, enemy.x, enemy.y, standHeight(enemy.x, enemy.y));
    model.root.rotation.y = facing(pp.x - enemy.x, pp.y - enemy.y);
    this.animateLegs(model, showWorld && sim.enemyMoving, vt);

    // ---- Player
    const displaced = showWorld ? sim.hitDisplacement() : null;
    const charmed = displaced?.kind === "charm" && vt - displaced.atMs < displaced.durationMs;
    const moving = showWorld && !displaced ? sim.player.target !== null : charmed;
    if (displaced) {
      // 引き寄せ・魅了中は相手の方を向く
      this.playerYaw = facing(displaced.to.x - displaced.from.x, displaced.to.y - displaced.from.y);
    } else if (moving && sim.player.target) {
      const tg = sim.player.target;
      this.playerYaw = facing(tg.x - pp.x, tg.y - pp.y);
    } else if (showWorld && sim.flash && vt - sim.flash.timestampMs < 50) {
      this.playerYaw = facing(sim.flash.direction.x, sim.flash.direction.y);
    } else if (!showWorld) {
      this.playerYaw = facing(enemy.x - pp.x, enemy.y - pp.y);
    }
    // ここから下は自分の情報なので、陰やブッシュの中でも常に表示する
    o.clip = false;
    if (moving && !displaced && sim.player.target) {
      const m = sim.player.target;
      o.line({ x: m.x - 6, y: m.y - 6 }, { x: m.x + 6, y: m.y + 6 }, 2.5, C.moveMarker, 0.9);
      o.line({ x: m.x - 6, y: m.y + 6 }, { x: m.x + 6, y: m.y - 6 }, 2.5, C.moveMarker, 0.9);
    }
    const disp = displaced;
    if (disp?.kind === "charm") {
      // 魅了: 頭上にハートが浮かぶ
      const since = vt - disp.atMs;
      for (let i = 0; i < 3; i++) {
        const k = ((since / 500 + i / 3) % 1);
        this.fx.sphere(pp.x + (i - 1) * 9, pp.y, 58 + k * 22, 4.5, PINK, 0.9 * (1 - k), true);
      }
    }
    o.disk(pp.x, pp.y, PR, C.shadow, 0.35);
    // Player hitbox (白い輪) = 当たり判定の円
    o.ring(pp.x, pp.y, PR, 2, 0xffffff, 0.9);
    const bob = moving ? Math.abs(Math.sin(vt / 70)) * 2 : 0;
    setPos(this.player.root, pp.x, pp.y, standHeight(pp.x, pp.y) + bob);
    this.player.root.rotation.y = this.playerYaw;
    this.animateLegs(this.player, moving, vt);
  }

  private drawFx(sim: RoundSimulation, vt: number): void {
    const o = this.overlay;
    o.clip = false;
    this.fx.clip = false;
    const last = sim.attacks[sim.attacks.length - 1];
    if (last) {
      const since = vt - last.timestampMs;
      const target = sim.minions.find((m) => m.spec.id === last.minionId);
      if ((last.result === "hit" || last.result === "kill") && target && since < 160) {
        // 通常攻撃の軌跡
        const p = sim.player.pos;
        o.line(p, target.spec.pos, 4, 0xffffff, 0.8 * (1 - since / 160));
      }
    }
    const f = sim.flash;
    if (f) {
      const since = vt - f.timestampMs;
      if (since < 400) {
        const a = 1 - since / 400;
        o.line(f.before, f.after, 8, C.flash, 0.6 * a);
        o.ring(f.before.x, f.before.y, 18 + since / 10, 2, C.flash, a);
        o.ring(f.after.x, f.after.y, 22 + since / 8, 3, C.flash, a);
        this.fx.sphere(f.before.x, f.before.y, 22, 16 + since / 12, C.flash, 0.45 * a, true);
        this.fx.sphere(f.after.x, f.after.y, 22, 20 * a + 6, C.flash, 0.6 * a, true);
      }
    }
    const hit = sim.hit;
    if (hit) {
      const since = vt - hit.atMs;
      const a = Math.max(0, 1 - since / 600);
      o.disk(hit.pos.x, hit.pos.y, 20 + since / 8, C.danger, 0.5 * a);
      o.ring(hit.pos.x, hit.pos.y, 24 + since / 6, 4, 0xffffff, a);
      this.fx.sphere(hit.pos.x, hit.pos.y, 22, 18 + since / 10, 0xff3030, 0.6 * a, true);
    }
  }
}

function addLights(scene: THREE.Scene, shadows: boolean): void {
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x2a3a20, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(-300, 700, 350);
  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -900;
    cam.right = 900;
    cam.top = 700;
    cam.bottom = -700;
    cam.near = 10;
    cam.far = 2000;
    sun.shadow.bias = -0.0008;
  }
  scene.add(sun);
}

function nearestFoe(all: readonly MinionState[], m: MinionState): MinionState | null {
  let best: MinionState | null = null;
  let bestD = Infinity;
  for (const f of all) {
    if (!f.alive || f.spec.team === m.spec.team) continue;
    const d = Math.hypot(f.spec.pos.x - m.spec.pos.x, f.spec.pos.y - m.spec.pos.y);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

function distance2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
