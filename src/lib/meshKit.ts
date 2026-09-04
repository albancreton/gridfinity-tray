// Model-agnostic mesh primitives, shared by every procedural mesher
// (lib/trayMesher.ts, lib/boardMesher.ts). Nothing here knows about gridfinity
// or SKÅDIS — it is the vocabulary the meshers are written in: a rounded
// rectangle, one canonical way to sample it, a growable triangle sink, and the
// handful of fills (fan, strip, loft, annulus, earcut) that cover every flat
// face and side wall we emit.
//
// Output frame is the viewer's world: x along columns, y up (mm above the print
// bed), z along rows.

import { type Pair, type Polygon, type Ring } from "polygon-clipping";
import { ShapeUtils, Vector2 } from "three";

export type V3 = [number, number, number];
export type { Pair, Polygon, Ring };

export const EPS = 1e-6;
export const UP: V3 = [0, 1, 0];
export const DOWN: V3 = [0, -1, 0];

/** A triangle soup with flat per-vertex normals and B-rep-style edge lines. */
export interface MeshSoup {
  /** Non-indexed triangle soup, world frame. */
  positions: Float32Array;
  /** Flat per-face normals, one per vertex. */
  normals: Float32Array;
  /** Line segments, flat [x,y,z, x,y,z, ...] pairs. */
  edges: Float32Array;
}

// --- Rounded rectangles --------------------------------------------------

/** Axis-aligned rounded rectangle in plan coordinates (x along columns, z along rows). */
export interface RRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  r: number;
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

export interface Outline {
  pts: Pair[];
  /** Indices where a straight side meets a corner arc — the B-rep tangent edges. */
  tangents: number[];
  bbox: [number, number, number, number];
}

/** The canonical corner order `sampleRRect` walks: +x-z, +x+z, -x+z, -x-z. */
export const CORNERS: ReadonlyArray<{ cx: (rr: RRect) => number; cz: (rr: RRect) => number; a0: number }> = [
  { cx: (rr) => rr.x1 - rr.r, cz: (rr) => rr.z0 + rr.r, a0: -Math.PI / 2 },
  { cx: (rr) => rr.x1 - rr.r, cz: (rr) => rr.z1 - rr.r, a0: 0 },
  { cx: (rr) => rr.x0 + rr.r, cz: (rr) => rr.z1 - rr.r, a0: Math.PI / 2 },
  { cx: (rr) => rr.x0 + rr.r, cz: (rr) => rr.z0 + rr.r, a0: Math.PI },
];

/**
 * Every ring is sampled with this exact parameterization (same corner order,
 * same points per arc) so rings of one loft pair up index by index.
 * `segs = 0` gives the four corner points alone — what a square rectangle wants.
 */
export function sampleRRect(rr: RRect, segs: number): Outline {
  const pts: Pair[] = [];
  const tangents: number[] = [];
  const span = segs || 1; // segs = 0 emits one point per corner, at angle a0
  for (const c of CORNERS) {
    const cx = c.cx(rr);
    const cz = c.cz(rr);
    tangents.push(pts.length);
    for (let i = 0; i <= segs; i++) {
      const a = c.a0 + (Math.PI / 2) * (i / span);
      pts.push([cx + rr.r * Math.cos(a), cz + rr.r * Math.sin(a)]);
    }
    tangents.push(pts.length - 1);
  }
  return { pts, tangents, bbox: [rr.x0, rr.z0, rr.x1, rr.z1] };
}

export function sampleCircle(cx: number, cz: number, r: number, segs: number): Outline {
  const pts: Pair[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return { pts, tangents: [], bbox: [cx - r, cz - r, cx + r, cz + r] };
}

/** Closed ring for polygon-clipping, consecutive duplicates removed. */
export function toRing(o: Outline): Ring {
  const ring: Ring = [];
  for (const p of o.pts) {
    const last = ring[ring.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) ring.push(p);
  }
  ring.push(ring[0]);
  return ring;
}

export function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

// --- Triangle sink -------------------------------------------------------

/** Growable Float32Array — a 12×12 tray is ~100k triangles, too many for number[] pushes. */
export class Buf {
  data = new Float32Array(1 << 15);
  len = 0;

  reserve(n: number) {
    if (this.len + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }

  put3(x: number, y: number, z: number) {
    this.data[this.len++] = x;
    this.data[this.len++] = y;
    this.data[this.len++] = z;
  }

  result(): Float32Array {
    return this.data.slice(0, this.len);
  }
}

export class Sink {
  pos = new Buf();
  nrm = new Buf();
  lines = new Buf();

  /** Pushes a triangle wound so its normal points along `want` (only the sign matters). */
  tri(a: V3, b: V3, c: V3, want: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len2 = nx * nx + ny * ny + nz * nz;
    if (len2 < 1e-24) return; // degenerate
    const inv = 1 / Math.sqrt(len2);
    nx *= inv; ny *= inv; nz *= inv;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      const t = b;
      b = c;
      c = t;
      nx = -nx; ny = -ny; nz = -nz;
    }
    this.pos.reserve(9);
    this.pos.put3(a[0], a[1], a[2]);
    this.pos.put3(b[0], b[1], b[2]);
    this.pos.put3(c[0], c[1], c[2]);
    this.nrm.reserve(9);
    this.nrm.put3(nx, ny, nz);
    this.nrm.put3(nx, ny, nz);
    this.nrm.put3(nx, ny, nz);
  }

  quad(a: V3, b: V3, c: V3, d: V3, want: V3) {
    this.tri(a, b, c, want);
    this.tri(a, c, d, want);
  }

  line(a: V3, b: V3) {
    this.lines.reserve(6);
    this.lines.put3(a[0], a[1], a[2]);
    this.lines.put3(b[0], b[1], b[2]);
  }

  /** Flat fill of a convex outline (no earcut needed). */
  fan(o: Outline, y: number, want: V3) {
    const p0 = lift(o.pts[0], y);
    for (let i = 1; i < o.pts.length - 1; i++) {
      this.tri(p0, lift(o.pts[i], y), lift(o.pts[i + 1], y), want);
    }
  }

  /** Closed polyline at height `y`. */
  ringLines(o: Outline, y: number, skip?: (a: Pair, b: Pair) => boolean) {
    const n = o.pts.length;
    for (let i = 0; i < n; i++) {
      const a = o.pts[i];
      const b = o.pts[(i + 1) % n];
      if (skip?.(a, b)) continue;
      this.line([a[0], y, a[1]], [b[0], y, b[1]]);
    }
  }
}

export function lift(p: Pair, y: number): V3 {
  return [p[0], y, p[1]];
}

/** Outward horizontal direction for the directed edge a→b of a ring whose face lies to its left. */
export function outward(a: Pair, b: Pair): V3 {
  return [b[1] - a[1], 0, -(b[0] - a[0])];
}

/** Exterior ring CCW, holes CW — then every ring has the face on its left. */
export function normalizePolygon(poly: Polygon): Polygon {
  return poly.map((ring, i) => {
    const ccw = signedArea(ring) > 0;
    return (i === 0) === ccw ? ring : [...ring].reverse();
  });
}

export function stripClose(ring: Ring): Pair[] {
  const n = ring.length;
  const a = ring[0], b = ring[n - 1];
  return n > 1 && Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS ? ring.slice(0, -1) : ring;
}

/** Triangulates a polygon with holes at per-vertex heights, normal along `want`. */
export function fillPolygon(poly: Polygon, hOf: (p: Pair) => number, want: V3, out: Sink) {
  const rings = poly.map(stripClose).filter((r) => r.length >= 3);
  if (rings.length === 0) return;
  const contour = rings[0].map((p) => new Vector2(p[0], p[1]));
  const holes = rings.slice(1).map((r) => r.map((p) => new Vector2(p[0], p[1])));
  const all: Pair[] = rings.flat();
  let tris: number[][];
  try {
    tris = ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  for (const [i, j, k] of tris) {
    out.tri(lift(all[i], hOf(all[i])), lift(all[j], hOf(all[j])), lift(all[k], hOf(all[k])), want);
  }
}

/**
 * Loft side between two rings sampled alike, from height ya to yb, facing away
 * from `center` — or toward it with `inward`, which is what the wall of a hole
 * wants (its material faces the void).
 */
export function loft(
  a: Outline,
  ya: number,
  b: Outline,
  yb: number,
  center: Pair,
  out: Sink,
  inward = false,
) {
  const n = a.pts.length;
  const s = inward ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mx = (a.pts[i][0] + a.pts[j][0]) / 2 - center[0];
    const mz = (a.pts[i][1] + a.pts[j][1]) / 2 - center[1];
    out.quad(lift(a.pts[i], ya), lift(a.pts[j], ya), lift(b.pts[j], yb), lift(b.pts[i], yb), [
      s * mx,
      0,
      s * mz,
    ]);
  }
}

/** First hit of the ray from `origin` at angle `a` on a closed polygon (any orientation). */
function rayHit(origin: Pair, a: number, poly: Pair[]): Pair {
  const dx = Math.cos(a), dz = Math.sin(a);
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const ex = q[0] - p[0], ez = q[1] - p[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = p[0] - origin[0], wz = p[1] - origin[1];
    const t = (wx * ez - wz * ex) / den;
    const s = (wx * dz - wz * dx) / den;
    if (s >= -1e-9 && s <= 1 + 1e-9 && t > 0 && t < best) best = t;
  }
  return [origin[0] + dx * best, origin[1] + dz * best];
}

/**
 * Flat annulus between a sampled hole and a boundary around it, one quad per
 * angular step: how a foot bottom is filled around each magnet pocket, and a
 * board tile around its slot, without a triangulator. Every vertex of either
 * ring gets its own step so both edges follow their polygon exactly; the inner
 * points sit on the hole's own chords so they match the wall built from the
 * same samples. Both rings must be star-shaped from the hole's bbox center.
 */
export function ringStrip(hole: Outline, boundary: Pair[], y: number, want: V3, out: Sink) {
  const center: Pair = [(hole.bbox[0] + hole.bbox[2]) / 2, (hole.bbox[1] + hole.bbox[3]) / 2];
  const angles: number[] = [];
  for (const pts of [hole.pts, boundary]) {
    for (const v of pts) {
      let a = Math.atan2(v[1] - center[1], v[0] - center[0]);
      if (a < 0) a += 2 * Math.PI;
      angles.push(a);
    }
  }
  angles.sort((a, b) => a - b);
  const n = angles.length;
  for (let i = 0; i < n; i++) {
    const a0 = angles[i];
    const a1 = i + 1 < n ? angles[i + 1] : angles[0] + 2 * Math.PI;
    if (a1 - a0 < 1e-9) continue;
    const i0 = rayHit(center, a0, hole.pts), i1 = rayHit(center, a1, hole.pts);
    const o0 = rayHit(center, a0, boundary), o1 = rayHit(center, a1, boundary);
    out.quad(lift(i0, y), lift(i1, y), lift(o1, y), lift(o0, y), want);
  }
}

// --- Checks --------------------------------------------------------------

/** Signed volume of a closed triangle soup (mm³); a sanity check for winding and agreement with the CAD. */
export function meshVolume(positions: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function meshBounds(positions: ArrayLike<number>): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}
