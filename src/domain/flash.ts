import { clampToBounds, distance, normalize, sub, type Bounds } from "./geometry";
import type { FlashRecord, Vec2 } from "./types";

/**
 * Flash先を計算する。Player -> Cursor 方向へ最大距離でClampし、さらに画面境界へClampする。
 */
export function computeFlash(
  before: Vec2,
  cursor: Vec2,
  maxDistance: number,
  bounds: Bounds,
  timestampMs: number,
): FlashRecord {
  const delta = sub(cursor, before);
  const dir = normalize(delta);
  const wanted = Math.min(distance(before, cursor), maxDistance);
  const target = { x: before.x + dir.x * wanted, y: before.y + dir.y * wanted };
  const after = clampToBounds(target, bounds);
  return {
    timestampMs,
    before: { ...before },
    cursor: { ...cursor },
    after,
    distance: distance(before, after),
    direction: dir,
  };
}
