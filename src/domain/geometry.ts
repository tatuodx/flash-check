import type { Vec2 } from "./types";

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

export function rotate(a: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function fromAngle(rad: number): Vec2 {
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** 点pと線分abの最短距離 */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq === 0) return distance(p, a);
  const t = clamp(dot(sub(p, a), ab) / lenSq, 0, 1);
  return distance(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/**
 * Player円とCapsule (線分ab, 半径r) の安全余裕。
 * 負の値は交差 (被弾) を意味する。
 */
export function capsuleClearance(p: Vec2, playerRadius: number, a: Vec2, b: Vec2, r: number): number {
  return distanceToSegment(p, a, b) - (r + playerRadius);
}

/** Player円とCircle AoEの安全余裕。Player hitbox全体がAoE外なら >= 0 */
export function circleClearance(p: Vec2, playerRadius: number, center: Vec2, r: number): number {
  return distance(p, center) - (r + playerRadius);
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function clampToBounds(p: Vec2, b: Bounds): Vec2 {
  return { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY) };
}

export function inBounds(p: Vec2, b: Bounds): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}
