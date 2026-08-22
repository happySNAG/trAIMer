export interface Vec2 {
  x: number;
  y: number;
}

export interface Viewport {
  widthPx: number;
  heightPx: number;
}

export const DEFAULT_VIEWPORT: Viewport = { widthPx: 1280, heightPx: 720 };

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function vecAdd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vecSub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vecScale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function vecLen(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function vecDist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function angleBetween(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}
