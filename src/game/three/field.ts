import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { GAME_CONFIG } from "../../config/balance";
import { clamp, lerp } from "../../domain/geometry";
import { BRUSHES, riverX, type Brush } from "../../domain/fieldLayout";
import { createRng } from "../../domain/rng";
import { makeTower } from "./models";

// ゲーム座標 (x: 0..1000 右, y: 0..600 下) と Three.js座標 (X右, Y上, Z手前) の対応。
// 地形は見た目のみで、当たり判定・移動には一切影響しない。

export const W = GAME_CONFIG.world.width;
export const H = GAME_CONFIG.world.height;

export function to3(x: number, y: number, height = 0): THREE.Vector3 {
  return new THREE.Vector3(x - W / 2, height, y - H / 2);
}

export function setPos(obj: THREE.Object3D, x: number, y: number, height = 0): void {
  obj.position.set(x - W / 2, height, y - H / 2);
}

const LANE_TOP = GAME_CONFIG.world.lane.top;
const LANE_BOTTOM = GAME_CONFIG.world.lane.bottom;

// レーン断面 (上から): 陰 (ジャングル台地) | 草地 | レーン | 草地 | 陰
// 川はレーンの上下 (ジャングルの切れ目) を流れ、レーン上では途切れる (レーンは地続き)。
// 上下の川がジャングルの切れ目を通る位置にブッシュがある。陰とブッシュの配置は domain/fieldLayout (視界判定と共通)。

const RIVER_FLAT = 55;
const RIVER_BANK = 45;
const RIVER_DEPTH = 4;
/** 川がレーンの手前で終わる範囲 (この幅でなだらかに浅くなる) */
const RIVER_LANE_FADE = 26;
const JUNGLE_RIVER_GAP = 135;
/** これより外側を陰 (視界なし) として暗くする */
const SHADE_TOP = GAME_CONFIG.world.vision.shadeTop;
const SHADE_BOTTOM = GAME_CONFIG.world.vision.shadeBottom;
const SHADE_RAMP = 30;
const SHADE_STRENGTH = 0.72;

const PLATEAU_HEIGHT = 26;
const PLATEAU_RAMP = 22;
/** ジャングル (岩壁で囲まれた台地) の開始位置 */
const JUNGLE_TOP = 62;
const JUNGLE_BOTTOM = H - 62;

function smooth(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** ジャングル台地の内側距離 (正 = 台地内)。川の部分は切れ目になる */
export function jungleInside(x: number, y: number): number {
  const dy = y < H / 2 ? JUNGLE_TOP - y : y - JUNGLE_BOTTOM;
  const dx = Math.abs(x - riverX(y)) - JUNGLE_RIVER_GAP;
  return Math.min(dx, dy);
}

export function riverDepthAt(x: number, y: number): number {
  const d = Math.abs(x - riverX(y));
  const across = 1 - smooth((d - RIVER_FLAT) / RIVER_BANK);
  // レーン上には川を流さない
  const outsideLane = Math.max(LANE_TOP - y, y - LANE_BOTTOM);
  return RIVER_DEPTH * across * smooth(outsideLane / RIVER_LANE_FADE);
}

/** 陰の明るさ係数 (1 = 通常, 小さいほど暗い)。視界の境界から外側へ暗くなる */
export function shadeAt(y: number): number {
  const d = Math.max(SHADE_TOP - y, y - SHADE_BOTTOM);
  return 1 - SHADE_STRENGTH * smooth((d + 6) / SHADE_RAMP);
}

/** 見た目用の地形高さ */
export function groundHeight(x: number, y: number): number {
  const inside = jungleInside(x, y);
  const plateau = PLATEAU_HEIGHT * smooth(inside / PLATEAU_RAMP);
  const jitter = inside > 0 ? (hash2(Math.round(x / 9), Math.round(y / 9)) - 0.5) * 5 * smooth(inside / 8) : 0;
  return plateau + jitter - riverDepthAt(x, y);
}

const COLORS = {
  grass: new THREE.Color(0x4f8a3a),
  grassDark: new THREE.Color(0x3c7330),
  lane: new THREE.Color(0x8a7d64),
  laneDark: new THREE.Color(0x6d6350),
  brushGround: new THREE.Color(0x356b2c),
  sand: new THREE.Color(0x8f8a5c),
  riverBed: new THREE.Color(0x3d6a5e),
  rock: new THREE.Color(0x7b7a72),
  rockDark: new THREE.Color(0x5d5c56),
  jungle: new THREE.Color(0x2f5a2a),
};

function inBrush(x: number, y: number): boolean {
  return BRUSHES.some((b) => ((x - b.x) / b.rx) ** 2 + ((y - b.y) / b.ry) ** 2 <= 1.1);
}

function groundColor(x: number, y: number): THREE.Color {
  return baseGroundColor(x, y).multiplyScalar(shadeAt(y));
}

function baseGroundColor(x: number, y: number): THREE.Color {
  const inside = jungleInside(x, y);
  const n = hash2(Math.floor(x / 14), Math.floor(y / 14));
  if (inside > -2 && inside < PLATEAU_RAMP + 2) return (n > 0.5 ? COLORS.rock : COLORS.rockDark).clone();
  if (inside >= PLATEAU_RAMP + 2) return COLORS.jungle.clone().lerp(COLORS.grassDark, n * 0.5);
  if (inBrush(x, y)) return COLORS.brushGround.clone().lerp(COLORS.grassDark, n * 0.4);
  const depth = riverDepthAt(x, y);
  if (depth > RIVER_DEPTH * 0.6) return COLORS.riverBed.clone().lerp(COLORS.sand, n * 0.3);
  if (depth > 0.5) return COLORS.sand.clone().lerp(COLORS.grassDark, n * 0.3);
  const laneEdge = Math.min(y - LANE_TOP, LANE_BOTTOM - y);
  const laneT = smooth((laneEdge + 18) / 36);
  const grass = COLORS.grass.clone().lerp(COLORS.grassDark, n * 0.6);
  const tile = hash2(Math.floor(x / 34), Math.floor(y / 26));
  const lane = (tile > 0.82 ? COLORS.laneDark : COLORS.lane).clone().lerp(COLORS.laneDark, n * 0.3);
  return grass.lerp(lane, laneT * (laneEdge > -10 + n * 20 ? 1 : 0.4));
}

function buildGround(): THREE.Mesh {
  // カメラを斜めに回しても画面の隅まで地面が見えるよう広めに取る
  const ext = 2800;
  const geo = new THREE.PlaneGeometry(ext, ext, 250, 250);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + W / 2;
    const y = pos.getZ(i) + H / 2;
    pos.setY(i, groundHeight(x, y));
    const c = groundColor(x, y);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  return mesh;
}

/** 水面。陰の領域では地面と同じだけ暗くする (行ごとの頂点カラー) */
function buildWater(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2800, 2800, 1, 280);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(0x2f86b8);
  for (let i = 0; i < pos.count; i++) {
    const k = shadeAt(pos.getZ(i) + H / 2);
    colors.set([base.r * k, base.g * k, base.b * k], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.55, shininess: 80 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -1.6;
  return mesh;
}

function brazier(): THREE.Group {
  const g = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: 0x8c8a80, flatShading: true });
  const base = new THREE.Mesh(new THREE.BoxGeometry(14, 16, 14), stone);
  base.position.y = 8;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(8, 5, 5, 6), stone);
  bowl.position.y = 18;
  const fire = new THREE.Mesh(new THREE.OctahedronGeometry(5), new THREE.MeshBasicMaterial({ color: 0xffa940 }));
  fire.position.y = 23;
  fire.name = "fire";
  g.add(base, bowl, fire);
  g.traverse((o) => (o.castShadow = true));
  return g;
}

function tree(rng: ReturnType<typeof createRng>): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3.5, 12, 6), new THREE.MeshLambertMaterial({ color: 0x5a3d26 }));
  trunk.position.y = 6;
  g.add(trunk);
  const leaf = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.3 + rng.range(-0.03, 0.03), 0.45, 0.22 + rng.range(0, 0.08)), flatShading: true });
  for (let i = 0; i < 3; i++) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(16 - i * 4, 18, 7), leaf);
    cone.position.y = 16 + i * 9;
    g.add(cone);
  }
  g.traverse((o) => (o.castShadow = true));
  const s = rng.range(0.8, 1.35);
  g.scale.set(s, s, s);
  g.rotation.y = rng.range(0, Math.PI * 2);
  return g;
}

function rock(rng: ReturnType<typeof createRng>): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.DodecahedronGeometry(rng.range(9, 18), 0),
    new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.12, 0.05, rng.range(0.38, 0.5)), flatShading: true }),
  );
  m.scale.y = rng.range(0.6, 1.1);
  m.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** 楕円形のブッシュ (草むら)。見た目の範囲は視界判定の楕円と一致させる */
function brushPatch(rng: ReturnType<typeof createRng>, b: Brush, out: THREE.Group): void {
  const mat = new THREE.MeshLambertMaterial({ color: 0x4caf50, flatShading: true });
  const tip = new THREE.MeshLambertMaterial({ color: 0x7fd36b, flatShading: true });
  const dark = new THREE.MeshLambertMaterial({ color: 0x3a8f3f, flatShading: true });
  for (let x = b.x - b.rx; x <= b.x + b.rx; x += 6) {
    for (let y = b.y - b.ry; y <= b.y + b.ry; y += 7) {
      const bx = x + rng.range(-3, 3);
      const by = y + rng.range(-3, 3);
      if (((bx - b.x) / b.rx) ** 2 + ((by - b.y) / b.ry) ** 2 > 1) continue;
      const h = rng.range(16, 28);
      const blade = new THREE.Mesh(new THREE.ConeGeometry(rng.range(3, 5), h, 4), rng.chance(0.25) ? tip : rng.chance(0.4) ? dark : mat);
      setPos(blade, bx, by, Math.max(0, groundHeight(bx, by)) + h / 2);
      blade.rotation.z = rng.range(-0.3, 0.3);
      blade.rotation.x = rng.range(-0.3, 0.3);
      out.add(blade);
    }
  }
}

/**
 * 静的な装飾 (木・岩・草むら等) を頂点カラー付きの1メッシュへ結合する。
 * 個別Meshのままだと数千drawcallになるため。
 */
function bakeStatic(group: THREE.Group): THREE.Mesh {
  group.updateMatrixWorld(true);
  const geos: THREE.BufferGeometry[] = [];
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const color = ((mesh.material as THREE.MeshLambertMaterial).color ?? new THREE.Color(0xffffff)).clone();
    const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    const pos = g.attributes.position;
    const n = pos.count;
    const colors = new Float32Array(n * 3);
    // 陰の領域にある装飾も地面と同じだけ暗くする
    for (let i = 0; i < n; i++) {
      const k = shadeAt(pos.getZ(i) + H / 2);
      colors.set([color.r * k, color.g * k, color.b * k], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geos.push(g);
  });
  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 静的なフィールド (地面・レーン・上下の川とブッシュ・陰のジャングル壁・タワー) */
export function buildField(target: THREE.Scene): { update(t: number): void } {
  target.add(buildGround());
  target.add(buildWater());
  const rng = createRng("field-decoration");
  const scene = new THREE.Group();

  // ジャングル台地の木と、崖際の岩
  for (let i = 0; i < 2_400 && scene.children.length < 900; i++) {
    const x = rng.range(-800, W + 800);
    const y = rng.range(-800, H + 800);
    const inside = jungleInside(x, y);
    if (inside > PLATEAU_RAMP + 8 && rng.chance(0.55)) {
      const t = tree(rng);
      setPos(t, x, y, groundHeight(x, y) - 1);
      scene.add(t);
    } else if (inside > 0 && inside < PLATEAU_RAMP) {
      const r = rock(rng);
      setPos(r, x, y, groundHeight(x, y) + 2);
      scene.add(r);
    }
  }

  // 上下の川のブッシュ
  for (const b of BRUSHES) brushPatch(rng, b, scene);

  // ジャングル壁の端 (川の切れ目) の篝火。炎は揺らすので結合しない
  const fires: THREE.Object3D[] = [];
  for (const [x, y] of [
    [riverX(70) - JUNGLE_RIVER_GAP - 10, 70],
    [riverX(70) + JUNGLE_RIVER_GAP + 10, 70],
    [riverX(H - 70) - JUNGLE_RIVER_GAP - 10, H - 70],
    [riverX(H - 70) + JUNGLE_RIVER_GAP + 10, H - 70],
  ] as [number, number][]) {
    const b = brazier();
    setPos(b, x, y, groundHeight(x, y));
    const fire = b.getObjectByName("fire")!;
    b.remove(fire);
    fire.position.add(b.position);
    target.add(fire);
    scene.add(b);
    fires.push(fire);
  }

  // タワー (装飾)
  const ally = makeTower(0x4d8fe0);
  setPos(ally, 30, 225);
  const enemy = makeTower(0xa060e0);
  setPos(enemy, W - 30, H - 225);
  scene.add(ally, enemy);
  const crystals = [ally, enemy].map((tower) => {
    const c = tower.getObjectByName("crystal")!;
    tower.remove(c);
    c.position.x += tower.position.x;
    c.position.z += tower.position.z;
    target.add(c);
    return c;
  });
  target.add(bakeStatic(scene));

  return {
    update(t: number) {
      fires.forEach((f, i) => {
        const k = 1 + 0.25 * Math.sin(t / 90 + i * 1.7);
        f.scale.set(k, k * 1.3, k);
      });
      crystals.forEach((c, i) => {
        c.rotation.y = t / 900 + i;
        c.position.y = 62 + 3 * Math.sin(t / 500 + i);
        c.castShadow = true;
      });
    },
  };
}

/** 立っている位置の見た目上の高さ (水中は少し沈む) */
export function standHeight(x: number, y: number): number {
  const h = groundHeight(x, y);
  return h < 0 ? lerp(h, -1.6, 0.4) : h;
}
