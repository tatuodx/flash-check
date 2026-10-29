import * as THREE from "three";
import { GAME_CONFIG, championName } from "../../config/balance";
import { currentCombo } from "../../domain/aggregate";
import type { GeneratedEncounter, Vec2 } from "../../domain/types";
import type { GameBridge, HudState } from "../bridge";
import { RoundSystem } from "../systems/RoundSystem";
import { H, W } from "./field";
import { GameView } from "./GameView";

export interface GameOptions {
  seed: string;
  encounters: GeneratedEncounter[];
  bridge: GameBridge;
}

export interface GameHandle {
  destroy(): void;
}

/**
 * 斜め上からの固定カメラ (追従なし)。
 * yawDeg: 真下 (画面下側) から青タワー側 (ゲーム座標 -x) へ回した角度。
 * 45°で青の背中側から写し、レーンが左下→右上、川が左上→右下に見える。
 */
const CAMERA = {
  pitchDeg: 58,
  yawDeg: 45,
  fovDeg: 26,
  margin: 0.98,
  /**
   * 必ず画面に収めるゲーム座標範囲。斜めに回すとプレイ範囲 (1000x600) の四隅まで収めると
   * 引きすぎるため、攻防が起きる中心エリア (両者の初期位置と上下端からの攻撃の通り道) に絞る。
   */
  frame: { minX: 140, maxX: 860, minY: 40, maxY: 560 },
};

// 採点用の時刻はフレーム番号ではなく monotonic clock から取得する
const clock = () => performance.now();

/**
 * CAMERA.frame の四隅がすべて画面内に収まる距離までカメラを寄せ、
 * 上下の余白が均等になるよう注視点を前後へずらす。戻り値は注視点までの距離。
 */
function fitCamera(camera: THREE.PerspectiveCamera): number {
  const pitch = THREE.MathUtils.degToRad(CAMERA.pitchDeg);
  const yaw = THREE.MathUtils.degToRad(CAMERA.yawDeg);
  // 注視点からカメラへの水平方向
  const back = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  const f = CAMERA.frame;
  const corners = [
    new THREE.Vector3(f.minX - W / 2, 0, f.minY - H / 2),
    new THREE.Vector3(f.maxX - W / 2, 0, f.minY - H / 2),
    new THREE.Vector3(f.minX - W / 2, 0, f.maxY - H / 2),
    new THREE.Vector3(f.maxX - W / 2, 0, f.maxY - H / 2),
  ];
  let shift = 0;
  const place = (d: number) => {
    const target = back.clone().multiplyScalar(shift);
    camera.position.copy(target).addScaledVector(back, d * Math.cos(pitch)).setY(d * Math.sin(pitch));
    camera.lookAt(target);
    camera.updateMatrixWorld();
  };
  const fits = (d: number) => {
    place(d);
    return corners.every((c) => {
      const p = c.clone().project(camera);
      return Math.abs(p.x) <= CAMERA.margin && Math.abs(p.y) <= CAMERA.margin;
    });
  };
  const fitDistance = () => {
    let lo = 200;
    let hi = 8000;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    place(hi);
  };
  for (let iter = 0; iter < 12; iter++) {
    fitDistance();
    const ys = corners.map((c) => c.clone().project(camera).y);
    const center = (Math.max(...ys) + Math.min(...ys)) / 2;
    if (Math.abs(center) < 0.005) break;
    shift -= center * 150;
  }
  fitDistance();
  return camera.position.distanceTo(back.clone().multiplyScalar(shift));
}

export function createGame(parent: HTMLElement, opts: GameOptions): GameHandle {
  const { seed, encounters, bridge } = opts;
  // stencil: 視界なし領域の切り抜きに使う (three r163以降は既定で無効)
  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = false;
  parent.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.style.display = "block";

  const camera = new THREE.PerspectiveCamera(CAMERA.fovDeg, 16 / 9, 10, 12000);
  const view = new GameView();

  const resize = () => {
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const dist = fitCamera(camera);
    // 霧はカメラ距離に合わせ、画面奥の遠景だけを沈める
    view.world.fog = new THREE.Fog(0x10180f, dist * 1.15, dist * 2.4);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(parent);

  const rs = new RoundSystem(seed, encounters, GAME_CONFIG, {
    onComplete: (result) => bridge.emit("complete", result),
  });

  // ---- Input: マウス位置は地面 (Y=0平面) へのレイキャストでゲーム座標に変換する
  const raycaster = new THREE.Raycaster();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  let cursor: Vec2 = { x: W / 2, y: H / 2 };

  const toWorld = (clientX: number, clientY: number): Vec2 | null => {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(ground, hitPoint)) return null;
    return { x: hitPoint.x + W / 2, y: hitPoint.z + H / 2 };
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    if (p) cursor = p;
  };
  const onPointerDown = (e: PointerEvent) => {
    const now = clock();
    const p = toWorld(e.clientX, e.clientY);
    if (!p) return;
    cursor = p;
    // 右クリック: 範囲内の敵ミニオンなら攻撃、それ以外はその地点へ移動
    if (e.button === 2) rs.rightClick(now, p);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || e.key.toLowerCase() !== "f") return;
    rs.flash(clock(), cursor);
  };
  const onContextMenu = (e: Event) => e.preventDefault();
  window.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);

  // ---- Loop
  let lastHudKey = "";
  const emitHud = () => {
    const hud: HudState = {
      roundIndex: rs.roundIndex,
      roundCount: rs.encounters.length,
      phase: rs.phase,
      opponent: championName(rs.encounter.champion),
      totalScore: rs.totalScore,
      roundCs: rs.sim.outcome().csCount,
      roundCsScore: rs.liveCsScore,
      flashReady: rs.sim.flash === null,
      combo: currentCombo(rs.results, GAME_CONFIG.scoring.decision),
      lastResult: rs.lastResult,
    };
    const key = `${hud.roundIndex}|${hud.phase}|${hud.totalScore}|${hud.roundCs}|${hud.flashReady}|${hud.combo}`;
    if (key === lastHudKey) return;
    lastHudKey = key;
    bridge.emit("hud", hud);
  };

  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = clock();
    rs.update(now);
    view.sync(rs, now, camera);
    renderer.clear();
    renderer.render(view.world, camera);
    // 視界なし領域をステンシルへ書き込み、敵・攻撃の地面図形をそこで切り抜く
    renderer.render(view.fog.scene, camera);
    renderer.render(view.overlayScene, camera);
    renderer.clearDepth();
    renderer.render(view.actors, camera);
    const sim = rs.sim;
    if (rs.acceptsInput && sim.t >= sim.encounter.recognitionMs) {
      // 本命が視界内に入った後、実際に描画されたフレームの時刻を認識時刻とする (視界前は無視される)
      sim.markRecognitionVisible(rs.roundTime(now));
    }
    emitHud();
  };

  rs.start(clock());
  raf = requestAnimationFrame(frame);

  // 開発時のみE2E自動操作用に状態と座標変換を公開する
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __flashCheck: rs,
      __flashCheckView: {
        worldToClient(x: number, y: number) {
          const p = new THREE.Vector3(x - W / 2, 0, y - H / 2).project(camera);
          const rect = canvas.getBoundingClientRect();
          return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
        },
      },
    });
  }

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
      view.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
