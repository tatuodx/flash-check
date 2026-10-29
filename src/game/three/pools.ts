import * as THREE from "three";
import { BRUSHES, brushAt } from "../../domain/fieldLayout";
import type { Vec2 } from "../../domain/types";
import { GAME_CONFIG } from "../../config/balance";
import { W, H } from "./field";

const FOG_STENCIL = 1;

/** clip=true の図形は、視界なし領域 (ステンシル=1) には描かれない */
function applyFogClip(mat: THREE.Material, clip: boolean): void {
  mat.stencilWrite = clip;
  mat.stencilRef = FOG_STENCIL;
  mat.stencilFunc = THREE.NotEqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
}

/**
 * 視界なし領域をステンシルへ書き込むマスク。色は描かない。
 * 陰の帯とブッシュを「視界なし (1)」で書き、最後に自分が入っているブッシュだけ「見える (0)」で上書きする
 * (ブッシュ内のルールは陰より優先)。地面に貼る図形と立体の演出の切り抜きに使う。
 */
export class FogMask {
  readonly scene = new THREE.Scene();
  private readonly brushMeshes: { id: string; mesh: THREE.Mesh }[] = [];
  private readonly hideMat: THREE.MeshBasicMaterial;
  private readonly revealMat: THREE.MeshBasicMaterial;

  constructor() {
    const maskMat = (ref: number) =>
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilRef: ref,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
      });
    const mat = (this.hideMat = maskMat(FOG_STENCIL));
    this.revealMat = maskMat(0);
    const { shadeTop, shadeBottom } = GAME_CONFIG.world.vision;
    const far = 4000;
    const band = (y0: number, y1: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
      m.position.set(0, 0, (y0 + y1) / 2 - H / 2);
      m.scale.set(far * 2, 1, y1 - y0);
      m.renderOrder = 0;
      this.scene.add(m);
    };
    band(-far, shadeTop);
    band(shadeBottom, far);
    for (const b of BRUSHES) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), mat);
      m.position.set(b.x - W / 2, 0, b.y - H / 2);
      m.scale.set(b.rx, 1, b.ry);
      this.scene.add(m);
      this.brushMeshes.push({ id: b.id, mesh: m });
    }
  }

  /** 自分が入っているブッシュは最後に「見える」で上書きする */
  update(viewer: Vec2): void {
    const inside = brushAt(viewer)?.id;
    for (const { id, mesh } of this.brushMeshes) {
      const reveal = id === inside;
      mesh.material = reveal ? this.revealMat : this.hideMat;
      mesh.renderOrder = reveal ? 2 : 1;
    }
  }
}

/** 毎フレーム描き直す図形を、Meshを使い回して描くためのプール */
class MeshPool {
  private readonly items: THREE.Mesh[] = [];
  private used = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly geometry: THREE.BufferGeometry,
    private readonly depth: boolean,
    private readonly blending: THREE.Blending = THREE.NormalBlending,
  ) {}

  next(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    let m = this.items[this.used];
    if (!m) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        depthTest: this.depth,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: this.blending,
      });
      m = new THREE.Mesh(this.geometry, mat);
      m.frustumCulled = false;
      this.scene.add(m);
      this.items.push(m);
    }
    this.used++;
    m.visible = true;
    return m as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  }

  begin(): void {
    this.used = 0;
  }

  end(): void {
    for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false;
  }
}

const OVERLAY_Y = 0.3;

/**
 * 地面に貼る2D図形 (危険領域・照準・Hitbox輪など)。
 * 地形の起伏に隠れないよう深度テストなしで描き、呼び出し順に重ねる。
 * 座標はゲーム座標 (Y=0平面) で、当たり判定と完全に一致する。
 */
export class GroundOverlay {
  private readonly quads: MeshPool;
  private readonly disks: MeshPool;
  private readonly rings: MeshPool;
  private readonly ringGeos = new Map<number, THREE.RingGeometry>();
  private order = 0;
  /** trueの間に描いた図形は視界なし領域で切り抜かれる (敵や攻撃の情報) */
  clip = true;

  constructor(scene: THREE.Scene) {
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const disk = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this.quads = new MeshPool(scene, plane, false);
    this.disks = new MeshPool(scene, disk, false);
    this.rings = new MeshPool(scene, disk, false);
  }

  begin(): void {
    this.order = 0;
    this.quads.begin();
    this.disks.begin();
    this.rings.begin();
  }

  end(): void {
    this.quads.end();
    this.disks.end();
    this.rings.end();
  }

  private style(m: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>, color: number, alpha: number): void {
    m.material.color.setHex(color);
    m.material.opacity = alpha;
    m.renderOrder = this.order++;
    applyFogClip(m.material, this.clip);
  }

  /** 中心(cx,cy)・長さlen・幅widthの矩形 (angleはゲーム座標系のラジアン) */
  quad(cx: number, cy: number, len: number, width: number, angle: number, color: number, alpha: number): void {
    const m = this.quads.next();
    m.position.set(cx - W / 2, OVERLAY_Y, cy - H / 2);
    m.rotation.set(0, -angle, 0);
    m.scale.set(Math.max(0.01, len), 1, Math.max(0.01, width));
    this.style(m, color, alpha);
  }

  /** aからdir方向へlenの帯 */
  corridor(a: Vec2, dir: Vec2, len: number, width: number, color: number, alpha: number): void {
    this.quad(a.x + (dir.x * len) / 2, a.y + (dir.y * len) / 2, len, width, Math.atan2(dir.y, dir.x), color, alpha);
  }

  line(a: Vec2, b: Vec2, thickness: number, color: number, alpha: number): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    this.quad((a.x + b.x) / 2, (a.y + b.y) / 2, len, thickness, Math.atan2(b.y - a.y, b.x - a.x), color, alpha);
  }

  /** 帯の外枠 */
  corridorOutline(a: Vec2, dir: Vec2, len: number, width: number, thickness: number, color: number, alpha: number): void {
    const n = { x: -dir.y, y: dir.x };
    const hw = width / 2;
    const p = (s: number, along: number) => ({ x: a.x + dir.x * along + n.x * hw * s, y: a.y + dir.y * along + n.y * hw * s });
    this.line(p(1, 0), p(1, len), thickness, color, alpha);
    this.line(p(-1, 0), p(-1, len), thickness, color, alpha);
    this.line(p(1, 0), p(-1, 0), thickness, color, alpha);
    this.line(p(1, len), p(-1, len), thickness, color, alpha);
  }

  disk(x: number, y: number, r: number, color: number, alpha: number): void {
    if (r <= 0) return;
    const m = this.disks.next();
    m.position.set(x - W / 2, OVERLAY_Y, y - H / 2);
    m.rotation.set(0, 0, 0);
    m.scale.set(r, 1, r);
    this.style(m, color, alpha);
  }

  ring(x: number, y: number, r: number, thickness: number, color: number, alpha: number): void {
    if (r <= 0) return;
    const ratio = Math.min(0.99, Math.max(0.01, Math.round((thickness / r) * 100) / 100));
    let geo = this.ringGeos.get(ratio);
    if (!geo) {
      geo = new THREE.RingGeometry(1 - ratio, 1, 64).rotateX(-Math.PI / 2) as THREE.RingGeometry;
      this.ringGeos.set(ratio, geo);
    }
    const m = this.rings.next();
    m.geometry = geo;
    m.position.set(x - W / 2, OVERLAY_Y, y - H / 2);
    m.rotation.set(0, 0, 0);
    m.scale.set(r, 1, r);
    this.style(m, color, alpha);
  }

  dashed(a: Vec2, b: Vec2, thickness: number, dash: number, gap: number, color: number, alpha: number): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) return;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(len, d + dash);
      this.line({ x: a.x + dx * d, y: a.y + dy * d }, { x: a.x + dx * e, y: a.y + dy * e }, thickness, color, alpha);
    }
  }

  dispose(): void {
    this.ringGeos.forEach((g) => g.dispose());
  }
}

/** 立体のエフェクト (弾・スイープの壁・爆発など) */
export class Effects3D {
  private readonly spheres: MeshPool;
  private readonly boxes: MeshPool;
  private readonly glows: MeshPool;
  private readonly planes: MeshPool;
  private barOrder = 0;
  /** trueの間に描いた立体は視界なし領域で切り抜かれる */
  clip = true;

  constructor(scene: THREE.Scene) {
    this.spheres = new MeshPool(scene, new THREE.SphereGeometry(1, 16, 12), true);
    this.boxes = new MeshPool(scene, new THREE.BoxGeometry(1, 1, 1), true);
    this.glows = new MeshPool(scene, new THREE.SphereGeometry(1, 16, 12), true, THREE.AdditiveBlending);
    this.planes = new MeshPool(scene, new THREE.PlaneGeometry(1, 1), false);
  }

  /** カメラに正対する体力バー (ratio: 0..1) */
  bar(x: number, y: number, height: number, width: number, ratio: number, fill: number, camera: THREE.Camera): void {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const center = new THREE.Vector3(x - W / 2, height, y - H / 2);
    const quad = (pos: THREE.Vector3, w: number, h: number, color: number, alpha: number) => {
      const m = this.planes.next();
      m.position.copy(pos);
      m.quaternion.copy(camera.quaternion);
      m.scale.set(Math.max(0.01, w), h, 1);
      m.material.color.setHex(color);
      m.material.opacity = alpha;
      m.renderOrder = 1000 + this.barOrder++;
      applyFogClip(m.material, this.clip);
    };
    quad(center, width + 2, 5, 0x111111, 0.9);
    const r = Math.max(0, Math.min(1, ratio));
    quad(center.clone().addScaledVector(right, (-width * (1 - r)) / 2), width * r, 3.4, fill, 1);
  }

  begin(): void {
    this.barOrder = 0;
    this.spheres.begin();
    this.boxes.begin();
    this.glows.begin();
    this.planes.begin();
  }

  end(): void {
    this.spheres.end();
    this.boxes.end();
    this.glows.end();
    this.planes.end();
  }

  sphere(x: number, y: number, height: number, r: number, color: number, alpha: number, additive = false): void {
    const m = (additive ? this.glows : this.spheres).next();
    m.position.set(x - W / 2, height, y - H / 2);
    m.scale.set(r, r, r);
    m.material.color.setHex(color);
    m.material.opacity = alpha;
    applyFogClip(m.material, this.clip);
  }

  /** ゲーム座標の矩形 (x0..x1, y0..y1) を高さheightで立ち上げた箱 */
  box(x0: number, y0: number, x1: number, y1: number, height: number, color: number, alpha: number): void {
    const m = this.boxes.next();
    m.position.set((x0 + x1) / 2 - W / 2, height / 2, (y0 + y1) / 2 - H / 2);
    m.rotation.set(0, 0, 0);
    m.scale.set(Math.max(0.01, x1 - x0), height, Math.max(0.01, y1 - y0));
    m.material.color.setHex(color);
    m.material.opacity = alpha;
    applyFogClip(m.material, this.clip);
  }

  /** aからbへの棒 (弾体) */
  rod(a: Vec2, b: Vec2, height: number, thickness: number, color: number, alpha: number): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const m = this.boxes.next();
    m.position.set((a.x + b.x) / 2 - W / 2, height, (a.y + b.y) / 2 - H / 2);
    m.rotation.set(0, -Math.atan2(b.y - a.y, b.x - a.x), 0);
    m.scale.set(Math.max(0.01, len), thickness, thickness);
    m.material.color.setHex(color);
    m.material.opacity = alpha;
    applyFogClip(m.material, this.clip);
  }
}
