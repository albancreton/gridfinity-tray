// Pure tray layout, shared by the CAD worker (export), the procedural preview
// mesher and the tray shader's uniform setup — the single source of truth for
// every dimension. Change a number here, never in one consumer.
//
// Plan coordinates: x along columns, z along rows, row 0 at z ∈ [0, PITCH] —
// the viewer's world xz. Heights are mm above the print bed. The worker maps
// plan z to its own y (see cad.worker.ts).

import { BASE_H, CLEAR, LIP_H, PITCH, R_OUT, type Region, type TraySpec } from "./protocol";

/** Axis-aligned rounded rectangle in plan coordinates. */
export interface RRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  r: number;
}

export interface Levels {
  /** Top of the outer wall (rim), lip included. */
  topZ: number;
  /** Pocket floor. */
  floorZ: number;
  /** Top of the interior dividers: the stacking-lip socket cuts them down to this. */
  dividerTop: number;
}

export function levels(spec: Pick<TraySpec, "heightMm" | "lip" | "floor">): Levels {
  const topZ = Math.max(spec.heightMm, BASE_H + 1) + (spec.lip ? LIP_H : 0);
  const floorZ = Math.min(BASE_H + Math.max(spec.floor, 0), topZ - 0.5);
  const dividerTop = spec.lip ? topZ - LIP_SOCKET_DEPTH : topZ;
  return { topZ, floorZ, dividerTop };
}

/** Outer outline of the tray: the grid footprint minus the 0.25mm clearance. */
export function outerOutline(cols: number, rows: number): RRect {
  return { x0: CLEAR, z0: CLEAR, x1: PITCH * cols - CLEAR, z1: PITCH * rows - CLEAR, r: R_OUT };
}

/** `rr` shrunk by `inset` on every side; the corner stays concentric. */
export function insetRRect(rr: RRect, inset: number): RRect {
  return {
    x0: rr.x0 + inset,
    z0: rr.z0 + inset,
    x1: rr.x1 - inset,
    z1: rr.z1 - inset,
    r: Math.max(0, rr.r - inset),
  };
}

/**
 * Compartment pocket for a region: outer walls are `wall` thick past the
 * clearance, interior dividers straddle the grid line by wall/2. Null when
 * the pocket would be degenerate (the worker skips those too).
 */
export function pocketRect(
  spec: Pick<TraySpec, "cols" | "rows" | "wall">,
  reg: Region,
): RRect | null {
  const { cols, rows, wall } = spec;
  const edge = CLEAR + wall;
  const half = wall / 2;
  const x0 = PITCH * reg.c0 + (reg.c0 === 0 ? edge : half);
  const x1 = PITCH * (reg.c1 + 1) - (reg.c1 === cols - 1 ? edge : half);
  const z0 = PITCH * reg.r0 + (reg.r0 === 0 ? edge : half);
  const z1 = PITCH * (reg.r1 + 1) - (reg.r1 === rows - 1 ? edge : half);
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 1 || d < 1) return null;
  const r = Math.max(0.4, Math.min(R_OUT - wall, w / 2 - 0.1, d / 2 - 0.1));
  return { x0, z0, x1, z1, r };
}

/** Whether the pockets are cut at all (the worker skips them when there is no room). */
export function hasPockets(lv: Levels): boolean {
  return lv.floorZ < lv.topZ - 0.25;
}

// --- Feet (one per unit cell, z 0 → BASE_H) ---

export const FOOT_TOP = PITCH - 2 * CLEAR; // 41.5, per unit

/** Ruled loft, bottom to top: 0.8 chamfer / 1.8 straight / 2.15 chamfer. `size` is the square's side. */
export const FOOT_RINGS: ReadonlyArray<{ size: number; z: number; r: number }> = [
  { size: FOOT_TOP - 5.9, z: 0, r: 0.8 },
  { size: FOOT_TOP - 4.3, z: 0.8, r: 1.6 },
  { size: FOOT_TOP - 4.3, z: 2.6, r: 1.6 },
  { size: FOOT_TOP, z: BASE_H, r: R_OUT },
];

export function footCenter(c: number, r: number): { x: number; z: number } {
  return { x: PITCH * c + PITCH / 2, z: PITCH * r + PITCH / 2 };
}

export function footRing(c: number, r: number, ring: { size: number; r: number }): RRect {
  const { x, z } = footCenter(c, r);
  const h = ring.size / 2;
  return { x0: x - h, z0: z - h, x1: x + h, z1: z + h, r: ring.r };
}

export const MAGNET_D = 6.5;
export const MAGNET_H = 2.4;
export const MAGNET_SPREAD = 13; // from the foot center, on both axes

/** The four magnet pocket centers under the foot of cell (c, r). */
export function magnetCenters(c: number, r: number): { x: number; z: number }[] {
  const { x, z } = footCenter(c, r);
  const out: { x: number; z: number }[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      out.push({ x: x + sx * MAGNET_SPREAD, z: z + sz * MAGNET_SPREAD });
    }
  }
  return out;
}

// --- Stacking lip ---

/**
 * Socket cut into the top rim so another bin's feet can sit in it: a ruled
 * loft of rounded rectangles, each an `inset` from the outer outline (the
 * corner radius follows, `R_OUT − inset`, so every ring is concentric with the
 * outer corner) at height `topZ + dz`. v1 approximation of the rev-6 profile:
 * a mirrored foot with clearance; stacked bins sit ~0.25mm proud of spec.
 * Top to bottom.
 */
export const LIP_SOCKET: ReadonlyArray<{ inset: number; dz: number }> = [
  { inset: -0.25, dz: 0.5 },
  { inset: 2.0, dz: -1.75 },
  { inset: 2.0, dz: -3.55 },
  { inset: 2.8, dz: -4.35 },
];

/** How far below the rim the socket floor sits — interior dividers are cut to this. */
export const LIP_SOCKET_DEPTH = -LIP_SOCKET[LIP_SOCKET.length - 1].dz;

export function lipRing(outer: RRect, ring: { inset: number }): RRect {
  return insetRRect(outer, ring.inset);
}
