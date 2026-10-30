import * as THREE from "three";

// コードで組み立てるデフォルメ・ローポリモデル (外部アセット不使用)。
// 正面は +Z 方向。

const lambert = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) =>
  new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

function shadowAll(g: THREE.Object3D): void {
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
}

function eyes(g: THREE.Group, headY: number, headR: number): void {
  const eye = lambert(0x111111);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.16, 6, 6), eye);
    e.position.set(s * headR * 0.38, headY + headR * 0.1, headR * 0.88);
    g.add(e);
  }
}

export interface ChampionModel {
  root: THREE.Group;
  /** 歩行アニメ用 */
  legs: THREE.Object3D[];
  /** 詠唱等で光らせるパーツ */
  weapon: THREE.Mesh;
}

/** チャンピオン風のキャラクター。hitbox半径に収まるサイズ (高さ約50) */
export function makeChampion(kind: "player" | "enemy"): ChampionModel {
  const root = new THREE.Group();
  const main = kind === "player" ? 0x3d8bff : 0x8e4ae0;
  const accent = kind === "player" ? 0xe8f4ff : 0x2a1640;
  const skin = 0xf2d2b0;

  const legs: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 12, 6), lambert(accent));
    leg.geometry.translate(0, -6, 0);
    leg.position.set(s * 5, 12, 0);
    root.add(leg);
    legs.push(leg);
  }
  const body = new THREE.Mesh(new THREE.CylinderGeometry(8, 11, 18, 8), lambert(main));
  body.position.y = 20;
  root.add(body);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(11.2, 11.2, 3, 8), lambert(accent));
  belt.position.y = 13;
  root.add(belt);

  const head = new THREE.Mesh(new THREE.SphereGeometry(11, 10, 8), lambert(skin));
  head.position.y = 39;
  root.add(head);
  eyes(root, 39, 11);

  if (kind === "player") {
    // 髪とマント
    const hair = new THREE.Mesh(new THREE.SphereGeometry(11.6, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), lambert(0x2b4f8f));
    hair.position.y = 40;
    hair.rotation.x = -0.25;
    root.add(hair);
    const cape = new THREE.Mesh(new THREE.BoxGeometry(18, 22, 2), lambert(0x2fd0ff));
    cape.position.set(0, 21, -10);
    cape.rotation.x = 0.18;
    root.add(cape);
  } else {
    // 角付きフード
    const hood = new THREE.Mesh(new THREE.ConeGeometry(13, 20, 8), lambert(0x5b2a90));
    hood.position.y = 52;
    root.add(hood);
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(2.5, 11, 5), lambert(0xeeeeee));
      horn.position.set(s * 9, 48, 0);
      horn.rotation.z = -s * 0.7;
      root.add(horn);
    }
  }

  // 武器 (player: 剣 / enemy: 杖)
  const weapon =
    kind === "player"
      ? new THREE.Mesh(new THREE.BoxGeometry(2.5, 22, 1.5), lambert(0xd8e0ea, { emissive: 0x000000 }))
      : new THREE.Mesh(new THREE.OctahedronGeometry(4.5), lambert(0xffe066, { emissive: 0x332200 }));
  weapon.position.set(13, kind === "player" ? 24 : 34, 4);
  root.add(weapon);
  if (kind === "enemy") {
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 30, 5), lambert(0x6b4a2a));
    staff.position.set(13, 18, 4);
    root.add(staff);
  }
  shadowAll(root);
  // 当たり判定 (半径18〜20) に見た目の太さを近づける
  root.scale.setScalar(1.25);
  return { root, legs, weapon };
}

/**
 * 米倉: 二刀の剣士モチーフのデフォルメ (オリジナルデザイン)。
 * 紺の着物と白い帯、長い黒髪、顔の片側に鬼の半面、右手に青い刀・左手に赤い刀。
 */
export function makeYonekura(): ChampionModel {
  const root = new THREE.Group();
  const navy = 0x2b3558;
  const legs: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4.6, 12, 6), lambert(0x1f2238));
    leg.geometry.translate(0, -6, 0);
    leg.position.set(s * 5, 12, 0);
    root.add(leg);
    legs.push(leg);
  }
  const body = new THREE.Mesh(new THREE.CylinderGeometry(8, 11.5, 18, 8), lambert(navy));
  body.position.y = 20;
  const sash = new THREE.Mesh(new THREE.CylinderGeometry(11.8, 11.8, 3.5, 8), lambert(0xe8e8e8));
  sash.position.y = 14;
  // 着物の襟 (白いV字)
  const collar = new THREE.Mesh(new THREE.ConeGeometry(5, 9, 3), lambert(0xe8e8e8));
  collar.rotation.x = Math.PI;
  collar.position.set(0, 26, 7.5);
  root.add(body, sash, collar);

  const head = new THREE.Mesh(new THREE.SphereGeometry(11, 10, 8), lambert(0xf2d2b0));
  head.position.y = 39;
  root.add(head);
  eyes(root, 39, 11);
  // 長い黒髪: 頭頂 + 背中まで垂れる束
  const hair = new THREE.Mesh(new THREE.SphereGeometry(11.8, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), lambert(0x15151c));
  hair.position.y = 40;
  hair.rotation.x = -0.2;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 2, 26, 6), lambert(0x15151c));
  tail.position.set(0, 26, -10);
  tail.rotation.x = 0.25;
  root.add(hair, tail);
  // 鬼の半面 (顔の左側) と赤い角
  const mask = new THREE.Mesh(new THREE.SphereGeometry(11.4, 10, 8, Math.PI * 0.05, Math.PI * 0.55, Math.PI * 0.2, Math.PI * 0.55), lambert(0xf5f5f0));
  mask.position.y = 39;
  mask.rotation.y = -Math.PI * 0.05;
  const horn = new THREE.Mesh(new THREE.ConeGeometry(2.2, 9, 5), lambert(0xd8343a));
  horn.position.set(7, 50, 3);
  horn.rotation.z = -0.5;
  root.add(mask, horn);

  // 二刀: 右手の青い刀 (詠唱時に光らせる) と左手の赤い刀
  const blue = new THREE.Mesh(new THREE.BoxGeometry(2.2, 26, 1.2), lambert(0x6ec6ff, { emissive: 0x0a2233 }));
  blue.position.set(14, 26, 5);
  blue.rotation.z = -0.35;
  const red = new THREE.Mesh(new THREE.BoxGeometry(2.2, 24, 1.2), lambert(0xff5a5a, { emissive: 0x330a0a }));
  red.position.set(-14, 22, 4);
  red.rotation.z = 0.5;
  for (const [blade, x] of [
    [blue, 13],
    [red, -13],
  ] as const) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(5, 1.5, 3), lambert(0xc9a227));
    guard.position.set(x, blade.position.y - 13, blade.position.z);
    root.add(guard);
  }
  root.add(blue, red);
  shadowAll(root);
  root.scale.setScalar(1.25);
  return { root, legs, weapon: blue };
}

/**
 * アリ: 九尾の狐モチーフのデフォルメ (オリジナルデザイン)。
 * 白金色の髪と狐耳、赤と白の衣、背中に扇状に広がる5本の尾、右手に浮かぶ桃色の玉 (weapon)
 */
export function makeTamamo(): ChampionModel {
  const root = new THREE.Group();
  const legs: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 12, 6), lambert(0xf3ece4));
    leg.geometry.translate(0, -6, 0);
    leg.position.set(s * 4.5, 12, 0);
    root.add(leg);
    legs.push(leg);
  }
  // 赤い上衣と白い裾
  const skirt = new THREE.Mesh(new THREE.ConeGeometry(12, 12, 8), lambert(0xf6f1ea));
  skirt.position.y = 14;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(7, 9.5, 13, 8), lambert(0xc8283c));
  body.position.y = 24;
  const obi = new THREE.Mesh(new THREE.CylinderGeometry(9.6, 9.6, 2.6, 8), lambert(0xf2c14e));
  obi.position.y = 19;
  root.add(skirt, body, obi);

  const head = new THREE.Mesh(new THREE.SphereGeometry(10.5, 10, 8), lambert(0xf6dcc4));
  head.position.y = 39;
  root.add(head);
  eyes(root, 39, 10.5);
  // 白金色の髪 (頭頂 + 背中へ流れる束) と狐耳
  const gold = 0xf0dca0;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(11.2, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), lambert(gold));
  hair.position.y = 40;
  hair.rotation.x = -0.2;
  const back = new THREE.Mesh(new THREE.BoxGeometry(16, 20, 4), lambert(gold));
  back.position.set(0, 32, -8);
  root.add(hair, back);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(3.6, 9, 4), lambert(gold));
    ear.position.set(s * 6.5, 51, -1);
    ear.rotation.z = -s * 0.3;
    const inner = new THREE.Mesh(new THREE.ConeGeometry(1.8, 5, 4), lambert(0xff9db8));
    inner.position.set(s * 6.6, 50.5, 0.6);
    inner.rotation.z = -s * 0.3;
    root.add(ear, inner);
  }
  // 扇状に広がる5本の尾 (先端は白)
  for (let i = 0; i < 5; i++) {
    const a = (i - 2) * 0.42;
    const tail = new THREE.Group();
    const fur = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 1.6, 18, 6), lambert(gold));
    fur.position.y = 9;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(3.4, 6, 6), lambert(0xffffff));
    tip.position.y = 21;
    tail.add(fur, tip);
    tail.position.set(0, 16, -8);
    tail.rotation.set(-0.9, 0, a);
    root.add(tail);
  }
  // 右手に浮かぶ桃色の玉 (詠唱で光る)
  const orb = new THREE.Mesh(new THREE.SphereGeometry(4.2, 10, 8), lambert(0xff7eb6, { emissive: 0x330a1c }));
  orb.position.set(13, 26, 6);
  root.add(orb);
  shadowAll(root);
  root.scale.setScalar(1.25);
  return { root, legs, weapon: orb };
}

/**
 * クリッツブランク: 蒸気で動くグラブ使いのロボのデフォルメ (オリジナルデザイン)。
 * 銅色の丸い胴、小さなドーム頭にティールのバイザー、背中に2本の煙突、
 * 大きな両腕。右の拳 (weapon) がQで飛んでいく
 */
export function makeKritz(): ChampionModel & { stacks: THREE.Object3D[] } {
  const root = new THREE.Group();
  const copper = 0xc8782e;
  const dark = 0x4a3426;
  const legs: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.4, 10, 6), lambert(dark));
    leg.geometry.translate(0, -5, 0);
    leg.position.set(s * 6, 10, 0);
    root.add(leg);
    legs.push(leg);
  }
  // 丸い胴と、胸のリベット付きの帯
  const body = new THREE.Mesh(new THREE.SphereGeometry(13, 10, 8), lambert(copper));
  body.scale.set(1.1, 0.95, 1);
  body.position.y = 22;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(13.6, 13.6, 3, 10), lambert(0x8a5222));
  band.position.y = 20;
  const core = new THREE.Mesh(new THREE.CircleGeometry(3.4, 8), new THREE.MeshBasicMaterial({ color: 0x5ff2e0 }));
  core.position.set(0, 24, 13.3);
  root.add(body, band, core);
  // 小さなドーム頭とティールのバイザー
  const head = new THREE.Mesh(new THREE.SphereGeometry(7.5, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.6), lambert(0xd99a52));
  head.position.y = 33;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(10, 2.4, 2), new THREE.MeshBasicMaterial({ color: 0x5ff2e0 }));
  visor.position.set(0, 35, 6.6);
  root.add(head, visor);
  // 背中の煙突 (W中は蒸気を噴く)
  const stacks: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.2, 14, 6), lambert(0x6b6157));
    stack.position.set(s * 5.5, 36, -9);
    root.add(stack);
    stacks.push(stack);
  }
  // 大きな腕: 肩の球 + 前腕 + 拳。右の拳がQで飛ぶ
  let fist: THREE.Mesh | null = null;
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 6), lambert(0x8a5222));
    shoulder.position.set(s * 15, 27, 0);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 14, 6), lambert(copper));
    arm.position.set(s * 17, 18, 2);
    arm.rotation.z = s * 0.15;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(9, 8, 9), lambert(0xe0a040, { emissive: 0x000000 }));
    hand.position.set(s * 18, 9, 4);
    root.add(shoulder, arm, hand);
    if (s === 1) fist = hand;
  }
  shadowAll(root);
  root.scale.setScalar(1.3);
  return { root, legs, weapon: fist!, stacks };
}

/** ミニオン。小 (高さ約22) と砲台 (大きめの車体に砲身) */
export function makeMinion(team: "ally" | "enemy", kind: "melee" | "cannon" = "melee"): THREE.Group {
  const g = new THREE.Group();
  const main = team === "ally" ? 0x4f86d9 : 0x8a5cc4;
  if (kind === "cannon") {
    const body = new THREE.Mesh(new THREE.BoxGeometry(20, 11, 24), lambert(main));
    body.position.y = 9;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(7, 9, 8, 6), lambert(0x8c8a80));
    top.position.y = 18;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.6, 16, 8), lambert(0x4a4a4a));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 19, 10);
    g.add(body, top, barrel);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3, 8), lambert(0x3b2a1e));
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * 11, 4, sz * 8);
        g.add(wheel);
      }
    }
  } else {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(5, 6.5, 9, 6), lambert(main));
    body.position.y = 6;
    const head = new THREE.Mesh(new THREE.SphereGeometry(5.5, 8, 6), lambert(0xd9c7a8));
    head.position.y = 15;
    const helmet = new THREE.Mesh(new THREE.ConeGeometry(6, 7, 6), lambert(main));
    helmet.position.y = 20;
    const sword = new THREE.Mesh(new THREE.BoxGeometry(1.5, 10, 1), lambert(0xd8e0ea));
    sword.position.set(7, 9, 3);
    g.add(body, head, helmet, sword);
    eyes(g, 15, 5.5);
  }
  shadowAll(g);
  return g;
}

/** タワー (装飾のみ) */
export function makeTower(color: number): THREE.Group {
  const g = new THREE.Group();
  const stone = lambert(0x9a978c);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(24, 28, 10, 6), stone);
  base.position.y = 5;
  const column = new THREE.Mesh(new THREE.CylinderGeometry(12, 17, 38, 6), stone);
  column.position.y = 29;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(18, 13, 8, 6), lambert(color));
  cap.position.y = 50;
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(8), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.6 }));
  crystal.name = "crystal";
  crystal.position.y = 62;
  g.add(base, column, cap, crystal);
  shadowAll(g);
  return g;
}
