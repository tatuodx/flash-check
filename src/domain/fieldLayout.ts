import { GAME_CONFIG } from "../config/balance";
import type { Vec2 } from "./types";

// フィールド配置のうち、視界判定に関わるもの (描画と採点の両方が参照する)。

const { riverPath, vision, height } = GAME_CONFIG.world;

/** レーン上下を流れる川の中心線 */
export function riverX(y: number): number {
  return riverPath.centerX + riverPath.amplitude * Math.sin((y - height / 2) / riverPath.period);
}

export interface Brush {
  id: string;
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/** 上下の川のブッシュ */
export const BRUSHES: readonly Brush[] = vision.brushes;

export function brushAt(p: Vec2): Brush | null {
  for (const b of BRUSHES) {
    const dx = (p.x - b.x) / b.rx;
    const dy = (p.y - b.y) / b.ry;
    if (dx * dx + dy * dy <= 1) return b;
  }
  return null;
}

export function inShade(p: Vec2): boolean {
  return p.y < vision.shadeTop || p.y > vision.shadeBottom;
}

/**
 * viewer (Player) から点pが見えるか。
 * - ブッシュ内は、自分が同じブッシュに入っている場合のみ見える (陰より優先)
 * - それ以外の陰は常に視界なし (自分が入っても見えない)
 */
export function isVisible(p: Vec2, viewer: Vec2): boolean {
  const b = brushAt(p);
  if (b) return brushAt(viewer)?.id === b.id;
  return !inShade(p);
}
