// Procedural preview mesher: builds the tray's visible faces straight from the
// 2D layout (lib/layout.ts) in about a millisecond, on the main thread, with no
// solid booleans. The only clipping is 2D — the wall-top surface minus the
// pocket outlines — so the result is watertight, flat-shaded and carries the
// same B-rep-style edge lines the CAD kernel used to emit. The CAD worker is no
// longer in the preview path; it builds the export from the same layout module,
// and the dev-only overlay in Viewer checks the two agree.
//
// Output frame is the viewer's world: x along columns, y up (mm above the print
// bed), z along rows with row 0 at z ∈ [0, PITCH].

import polygonClipping, { type MultiPolygon, type Pair, type Polygon, type Ring } from "polygon-clipping";
import { ShapeUtils, Vector2 } from "three";
import { BASE_H, CLEAR, PITCH, type TraySpec } from "./protocol";
import {
  FOOT_RINGS,
  LIP_SOCKET,
  MAGNET_D,
  MAGNET_H,
  footCenter,
  footRing,
  hasPockets,
  insetRRect,
  levels,
  magnetCenters,
  outerOutline,
  pocketRect,
  type RRect,
} from "./layout";

export interface TrayGeometry {
  /** Non-indexed triangle soup, world frame. */
  positions: Float32Array;
  /** Flat per-face normals, one per vertex. */
  normals: Float32Array;
  /** Line segments, flat [x,y,z, x,y,z, ...] pairs. */
  edges: Float32Array;
  cols: number;
  rows: number;
  topZ: number;
}

type V3 = [number, number, number];

const ARC_SEGS = 8; // per quarter arc on the body outlines
const FOOT_SEGS = 6;
const HOLE_SEGS = 20;
const EPS = 1e-6;

// --- 2D outlines ---------------------------------------------------------

/** A rounded rectangle sampled CCW (positive area in the xz plane), open (no repeated end point). */
interface Outline {
  pts: Pair[];
  /** Indices where a straight side meets a corner arc — the B-rep tangent edges. */
  tangents: number[];
  bbox: [number, number, number, number];
}

const CORNERS: ReadonlyArray<{ cx: (rr: RRect) => number; cz: (rr: RRect) => number; a0: number }> = [
  { cx: (rr) => rr.x1 - rr.r, cz: (rr) => rr.z0 + rr.r, a0: -Math.PI / 2 },
  { cx: (rr) => rr.x1 - rr.r, cz: (rr) => rr.z1 - rr.r, a0: 0 },
  { cx: (rr) => rr.x0 + rr.r, cz: (rr) => rr.z1 - rr.r, a0: Math.PI / 2 },
  { cx: (rr) => rr.x0 + rr.r, cz: (rr) => rr.z0 + rr.r, a0: Math.PI },
];

/**
 * Every ring is sampled with this exact parameterization (same corner order,
 * same points per arc) so rings of one loft pair up index by index.
 */
function sampleRRect(rr: RRect, segs: number): Outline {
  const pts: Pair[] = [];
  const tangents: number[] = [];
  for (const c of CORNERS) {
    const cx = c.cx(rr);
    const cz = c.cz(rr);
    tangents.push(pts.length);
    for (let i = 0; i <= segs; i++) {
      const a = c.a0 + (Math.PI / 2) * (i / segs);
      pts.push([cx + rr.r * Math.cos(a), cz + rr.r * Math.sin(a)]);
    }
    tangents.push(pts.length - 1);
  }
  return { pts, tangents, bbox: [rr.x0, rr.z0, rr.x1, rr.z1] };
}

function sampleCircle(cx: number, cz: number, r: number, segs: number): Outline {
  const pts: Pair[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return { pts, tangents: [], bbox: [cx - r, cz - r, cx + r, cz + r] };
}

/** Closed ring for polygon-clipping, consecutive duplicates removed. */
function toRing(o: Outline): Ring {
  const ring: Ring = [];
  for (const p of o.pts) {
    const last = ring[ring.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) ring.push(p);
  }
  ring.push(ring[0]);
  return ring;
}

function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

/** Exact signed distance to a rounded rectangle (negative inside). */
function sdRRect(p: Pair, rr: RRect): number {
  const hx = (rr.x1 - rr.x0) / 2 - rr.r;
  const hz = (rr.z1 - rr.z0) / 2 - rr.r;
  const dx = Math.abs(p[0] - (rr.x0 + rr.x1) / 2) - hx;
  const dz = Math.abs(p[1] - (rr.z0 + rr.z1) / 2) - hz;
  if (dx > 0 && dz > 0) return Math.hypot(dx, dz) - rr.r;
  return Math.max(dx, dz) - rr.r;
}

function pointOnOutline(p: Pair, o: Outline): boolean {
  const [bx0, bz0, bx1, bz1] = o.bbox;
  if (p[0] < bx0 - EPS || p[0] > bx1 + EPS || p[1] < bz0 - EPS || p[1] > bz1 + EPS) return false;
  const n = o.pts.length;
  for (let i = 0; i < n; i++) {
    const a = o.pts[i];
    const b = o.pts[(i + 1) % n];
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const len2 = abx * abx + abz * abz;
    let t = len2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = a[0] + t * abx - p[0];
    const ez = a[1] + t * abz - p[1];
    if (ex * ex + ez * ez < EPS * EPS) return true;
  }
  return false;
}

function edgeOnOutline(a: Pair, b: Pair, o: Outline): boolean {
  return (
    pointOnOutline(a, o) &&
    pointOnOutline(b, o) &&
    pointOnOutline([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], o)
  );
}

function bboxOverlap(a: Outline["bbox"], b: Outline["bbox"]): boolean {
  return a[0] <= b[2] + EPS && b[0] <= a[2] + EPS && a[1] <= b[3] + EPS && b[1] <= a[3] + EPS;
}

// --- Triangle sink -------------------------------------------------------

/** Growable Float32Array — a 12×12 tray is ~100k triangles, too many for number[] pushes. */
class Buf {
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

class Sink {
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

const UP: V3 = [0, 1, 0];
const DOWN: V3 = [0, -1, 0];

function lift(p: Pair, y: number): V3 {
  return [p[0], y, p[1]];
}

/** Outward horizontal direction for the directed edge a→b of a ring whose face lies to its left. */
function outward(a: Pair, b: Pair): V3 {
  return [b[1] - a[1], 0, -(b[0] - a[0])];
}

/** Exterior ring CCW, holes CW — then every ring has the face on its left. */
function normalizePolygon(poly: Polygon): Polygon {
  return poly.map((ring, i) => {
    const ccw = signedArea(ring) > 0;
    return (i === 0) === ccw ? ring : [...ring].reverse();
  });
}

function stripClose(ring: Ring): Pair[] {
  const n = ring.length;
  const a = ring[0], b = ring[n - 1];
  return n > 1 && Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS ? ring.slice(0, -1) : ring;
}

/** Triangulates a polygon with holes at per-vertex heights, normal along `want`. */
function fillPolygon(poly: Polygon, hOf: (p: Pair) => number, want: V3, out: Sink) {
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

/** Loft side between two rings sampled alike, from height ya to yb, facing away from `center`. */
function loft(a: Outline, ya: number, b: Outline, yb: number, center: Pair, out: Sink) {
  const n = a.pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mx = (a.pts[i][0] + a.pts[j][0]) / 2 - center[0];
    const mz = (a.pts[i][1] + a.pts[j][1]) / 2 - center[1];
    out.quad(lift(a.pts[i], ya), lift(a.pts[j], ya), lift(b.pts[j], yb), lift(b.pts[i], yb), [mx, 0, mz]);
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
 * Flat annulus between a sampled circle and a convex boundary around it, one
 * quad per angular step: how a foot bottom is filled around each magnet pocket
 * without a triangulator. Every boundary vertex gets its own step so the outer
 * edge follows the boundary exactly; the inner points sit on the circle's own
 * chords so they match the pocket wall built from the same samples.
 */
function ringStrip(hole: Outline, boundary: Pair[], y: number, want: V3, out: Sink) {
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

// --- Wall-top bands ------------------------------------------------------

/**
 * The wall top as a height field of the inset from the outer outline: flat at
 * topZ without a lip; with one, the socket profile — rim, 45° chamfer, vertical
 * step, second chamfer, then flat at the socket floor (which is also where the
 * interior dividers end). A band spans [insA, insB] with the height linear in
 * between; insB === null runs to the tray's center; insA === insB is a vertical
 * step. The wall thickness is also a boundary: pockets start at that inset, so
 * bands before it never need clipping and bands after it are mostly pocket.
 */
interface Band {
  insA: number;
  insB: number | null;
  hA: number;
  hB: number;
}

function topBands(lip: boolean, topZ: number, wall: number): Band[] {
  if (!lip) return [{ insA: 0, insB: null, hA: topZ, hB: topZ }];
  const prof = LIP_SOCKET.map((p) => ({ ins: p.inset, h: topZ + p.dz }));
  const bands: Band[] = [];
  // The socket starts above the rim: find where its first flank crosses topZ.
  const p0 = prof[0], p1 = prof[1];
  const t = (p0.h - topZ) / (p0.h - p1.h);
  const insCross = p0.ins + t * (p1.ins - p0.ins);
  bands.push({ insA: 0, insB: insCross, hA: topZ, hB: topZ });
  let prev = { ins: insCross, h: topZ };
  for (let i = 1; i < prof.length; i++) {
    bands.push({ insA: prev.ins, insB: prof[i].ins, hA: prev.h, hB: prof[i].h });
    prev = prof[i];
  }
  bands.push({ insA: prev.ins, insB: null, hA: prev.h, hB: prev.h });
  // Split the band the wall thickness falls into (unless it already is a boundary).
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.insB === null || Math.abs(wall - b.insA) < EPS || Math.abs(wall - b.insB) < EPS) continue;
    if (wall > b.insA && wall < b.insB) {
      const s = (wall - b.insA) / (b.insB - b.insA);
      const h = b.hA + s * (b.hB - b.hA);
      bands.splice(i, 1, { ...b, insB: wall, hB: h }, { ...b, insA: wall, hA: h });
      break;
    }
  }
  return bands;
}

// --- Builder -------------------------------------------------------------

interface Pocket {
  rr: RRect;
  o: Outline;
  poly: Polygon;
}

export function buildTrayGeometry(spec: TraySpec): TrayGeometry {
  const { cols, rows, lip, wall } = spec;
  const lv = levels(spec);
  const { topZ } = lv;
  const out = new Sink();

  const outer = outerOutline(cols, rows);
  const outerO = sampleRRect(outer, ARC_SEGS);

  // Pockets, indexed by cell for O(1) "which pocket owns this point" lookups.
  const pockets: Pocket[] = [];
  const cellPocket = new Int16Array(cols * rows).fill(-1);
  if (hasPockets(lv)) {
    for (const reg of spec.regions) {
      const rr = pocketRect(spec, reg);
      if (!rr) continue;
      const o = sampleRRect(rr, ARC_SEGS);
      const idx = pockets.push({ rr, o, poly: [toRing(o)] }) - 1;
      for (let r = reg.r0; r <= reg.r1; r++) {
        for (let c = reg.c0; c <= reg.c1; c++) cellPocket[r * cols + c] = idx;
      }
    }
  }
  const pocketAt = (p: Pair): Pocket | null => {
    const c = Math.floor(p[0] / PITCH);
    const r = Math.floor(p[1] / PITCH);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
    const i = cellPocket[r * cols + c];
    return i >= 0 ? pockets[i] : null;
  };

  const bands = topBands(lip, topZ, wall);
  // A floor thicker than the height allows would put the pocket floor above the
  // divider tops; keep the preview well-formed (the CAD kernel makes a stepped
  // floor here — a configuration nobody wants anyway).
  const floorZ = Math.min(lv.floorZ, bands[bands.length - 1].hB - 0.25);

  const insOf = (p: Pair) => -sdRRect(p, outer);
  const bandHeight = (b: Band, p: Pair) => {
    if (b.insB === null || b.insB === b.insA) return b.hA;
    const t = Math.max(0, Math.min(1, (insOf(p) - b.insA) / (b.insB - b.insA)));
    return b.hA + t * (b.hB - b.hA);
  };
  /** Height of the wall top at a plan point (for lines that must meet it). */
  const topHeightAt = (p: Pair) => {
    const ins = insOf(p);
    for (const b of bands) {
      if (b.insB === null || ins <= b.insB + EPS) return bandHeight(b, p);
    }
    return bands[bands.length - 1].hB;
  };

  const isoRings = bands.map((b) => (b.insB === null ? null : sampleRRect(insetRRect(outer, b.insB), ARC_SEGS)));

  /** Pocket outline vertices strictly inside the segment a→b, in order along it. */
  const pocketVerticesOn = (a: Pair, b: Pair): Pair[] => {
    const bbox: Outline["bbox"] = [
      Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]),
    ];
    const abx = b[0] - a[0], abz = b[1] - a[1];
    const len2 = abx * abx + abz * abz;
    const found: { t: number; p: Pair }[] = [];
    for (const pk of pockets) {
      if (!bboxOverlap(pk.o.bbox, bbox)) continue;
      for (const v of pk.o.pts) {
        const t = ((v[0] - a[0]) * abx + (v[1] - a[1]) * abz) / len2;
        if (t <= EPS || t >= 1 - EPS) continue;
        const ex = a[0] + t * abx - v[0], ez = a[1] + t * abz - v[1];
        if (ex * ex + ez * ez < EPS * EPS) found.push({ t, p: v });
      }
    }
    return found.sort((u, v) => u.t - v.t).map((f) => f.p);
  };

  /** Emit one clipped top-surface polygon of band `k`, plus the walls hanging off its edges. */
  const emitTopPolygon = (poly: Polygon, k: number) => {
    const band = bands[k];
    const next = bands[k + 1];
    const hOf = (p: Pair) => bandHeight(band, p);
    const norm = normalizePolygon(poly);
    fillPolygon(norm, hOf, UP, out);
    const iso = isoRings[k];
    const stepBelow = next && next.insB === next.insA ? next : null;
    const handleEdge = (a: Pair, b: Pair) => {
      if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) return;
      const ha = hOf(a), hb = hOf(b);
      const pk = pocketAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      if (pk && edgeOnOutline(a, b, pk.o)) {
        // Pocket wall, from the (possibly sloped) top edge down to the floor.
        out.quad(lift(a, ha), lift(b, hb), lift(b, floorZ), lift(a, floorZ), outward(a, b));
        out.line(lift(a, ha), lift(b, hb));
      } else if (k === 0 && edgeOnOutline(a, b, outerO)) {
        out.quad(lift(a, ha), lift(b, hb), lift(b, BASE_H), lift(a, BASE_H), outward(a, b));
        out.line(lift(a, ha), lift(b, hb));
      } else if (iso && edgeOnOutline(a, b, iso)) {
        // A pocket side can run along this ring (its inset equals the wall
        // thickness): the clipper leaves the touching edge whole, so split it at
        // the pocket's corner points and classify each piece on its own.
        const splits = pocketVerticesOn(a, b);
        if (splits.length > 0) {
          let prev = a;
          for (const p of splits) {
            handleEdge(prev, p);
            prev = p;
          }
          handleEdge(prev, b);
          return;
        }
        out.line(lift(a, ha), lift(b, hb));
        if (stepBelow) {
          out.quad(lift(a, ha), lift(b, hb), lift(b, stepBelow.hB), lift(a, stepBelow.hB), outward(a, b));
          out.line(lift(a, stepBelow.hB), lift(b, stepBelow.hB));
        }
      }
    };
    for (const ring of norm) {
      for (let i = 0; i < ring.length - 1; i++) handleEdge(ring[i], ring[i + 1]);
    }
  };

  const difference = (subject: Polygon, clips: Polygon[]): MultiPolygon => {
    if (clips.length === 0) return [subject];
    try {
      return polygonClipping.difference(subject, ...clips);
    } catch {
      return [subject];
    }
  };

  for (let k = 0; k < bands.length; k++) {
    const band = bands[k];
    if (band.insB === band.insA) continue; // step: emitted by the band above
    // Pockets begin at inset `wall`: bands ending there or before are solid.
    const mayHitPockets = band.insB === null || band.insB > wall + EPS;
    const inner = isoRings[k];
    if (inner === null) {
      // Flat center: everything inside the last ring (or the whole outline),
      // minus pockets. Pockets wholly inside are plain holes; only the ones
      // crossing the ring need the clipper.
      const ringO = k === 0 ? outerO : isoRings[k - 1]!;
      const ringRR = k === 0 ? outer : insetRRect(outer, bands[k - 1].insB!);
      const holes: Polygon[] = [];
      const crossing: Polygon[] = [];
      for (const pk of pockets) {
        (pk.o.pts.every((p) => sdRRect(p, ringRR) < -EPS) ? holes : crossing).push(pk.poly);
      }
      const subject: Polygon = [toRing(ringO), ...holes.map((h) => h[0])];
      for (const poly of difference(subject, crossing)) emitTopPolygon(poly, k);
      continue;
    }
    // Annulus between two concentric rings, as quads clipped one by one.
    const outerRing = k === 0 ? outerO : isoRings[k - 1]!;
    const n = outerRing.pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = outerRing.pts[i], b = outerRing.pts[j], c = inner.pts[j], d = inner.pts[i];
      const ring: Ring = [a, b, c, d, a];
      if (Math.abs(signedArea(ring)) < 1e-9) continue;
      if (!mayHitPockets) {
        emitTopPolygon([ring], k);
        continue;
      }
      const bbox: Outline["bbox"] = [
        Math.min(a[0], b[0], c[0], d[0]), Math.min(a[1], b[1], c[1], d[1]),
        Math.max(a[0], b[0], c[0], d[0]), Math.max(a[1], b[1], c[1], d[1]),
      ];
      const near = pockets.filter((p) => bboxOverlap(p.o.bbox, bbox));
      // Both convex: a quad whose corners all sit inside (or on) one pocket is pocket.
      if (near.some((pk) => [a, b, c, d].every((p) => sdRRect(p, pk.rr) <= EPS))) continue;
      for (const poly of difference([ring], near.map((p) => p.poly))) emitTopPolygon(poly, k);
    }
  }

  // Outer wall: corner tangent lines and the seam with the feet.
  for (const t of outerO.tangents) {
    const p = outerO.pts[t];
    out.line(lift(p, BASE_H), lift(p, topZ));
  }
  out.ringLines(outerO, BASE_H);

  // Lip socket: tangent lines down the profile at each outer corner, ending where
  // the (concentric) pocket corner takes over, or at the socket floor.
  if (lip) {
    const endIns = Math.min(wall, bands[bands.length - 1].insA);
    for (const t of outerO.tangents) {
      let prev = lift(outerO.pts[t], topZ);
      for (let k = 0; k < bands.length - 1; k++) {
        const b = bands[k];
        if (b.insB === null || b.insB === b.insA) continue;
        if (endIns <= b.insA + EPS) break;
        const ins = Math.min(b.insB, endIns);
        const p = sampleRRect(insetRRect(outer, ins), ARC_SEGS).pts[t];
        const cur = lift(p, bandHeight(b, p));
        out.line(prev, cur);
        prev = cur;
        if (ins < b.insB - EPS) break;
        const next = bands[k + 1];
        if (next.insB === next.insA) {
          const low = lift(p, next.hB);
          out.line(cur, low);
          prev = low;
        }
      }
    }
  }

  // Pocket floors, floor outlines and corner tangents up to the wall top.
  for (const pk of pockets) {
    out.fan(pk.o, floorZ, UP);
    out.ringLines(pk.o, floorZ);
    for (const t of pk.o.tangents) {
      const p = pk.o.pts[t];
      out.line(lift(p, floorZ), lift(p, topHeightAt(p)));
    }
  }

  // Body underside: the 0.5mm gaps between feet (their tops are flush with it).
  // A strip along each column seam, strips between those along each row seam,
  // and — in the feet loop below — the little fan at every foot corner that
  // isn't a tray corner, between the rounded corner and the seams. Together
  // they tile the outline minus the feet exactly, with no clipping.
  const rectDown = (x0: number, z0: number, x1: number, z1: number) =>
    out.quad([x0, BASE_H, z0], [x1, BASE_H, z0], [x1, BASE_H, z1], [x0, BASE_H, z1], DOWN);
  for (let c = 1; c < cols; c++) rectDown(PITCH * c - CLEAR, outer.z0, PITCH * c + CLEAR, outer.z1);
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rectDown(PITCH * c + CLEAR, PITCH * r - CLEAR, PITCH * (c + 1) - CLEAR, PITCH * r + CLEAR);
    }
  }

  // Feet: ruled lofts, bottom cap (with magnet pockets), underside corner fans, edge lines.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const center = footCenter(c, r);
      const cp: Pair = [center.x, center.z];
      const rings = FOOT_RINGS.map((fr) => sampleRRect(footRing(c, r, fr), FOOT_SEGS));
      for (let k = 0; k < rings.length - 1; k++) {
        loft(rings[k], FOOT_RINGS[k].z, rings[k + 1], FOOT_RINGS[k + 1].z, cp, out);
        out.ringLines(rings[k], FOOT_RINGS[k].z);
        for (const t of rings[k].tangents) {
          out.line(lift(rings[k].pts[t], FOOT_RINGS[k].z), lift(rings[k + 1].pts[t], FOOT_RINGS[k + 1].z));
        }
      }
      // The top ring is the seam with the body; along the outer outline it is
      // already drawn once as the body's own bottom edge.
      const top = rings[rings.length - 1];
      out.ringLines(top, BASE_H, (a, b) => edgeOnOutline(a, b, outerO));
      const topRR = footRing(c, r, FOOT_RINGS[FOOT_RINGS.length - 1]);
      for (let k = 0; k < 4; k++) {
        const trayCorner =
          (k === 0 && c === cols - 1 && r === 0) ||
          (k === 1 && c === cols - 1 && r === rows - 1) ||
          (k === 2 && c === 0 && r === rows - 1) ||
          (k === 3 && c === 0 && r === 0);
        if (trayCorner) continue;
        const sq = CORNERS[k];
        const cornerPt = lift(
          [sq.cx(topRR) + (k < 2 ? topRR.r : -topRR.r), sq.cz(topRR) + (k === 1 || k === 2 ? topRR.r : -topRR.r)],
          BASE_H,
        );
        for (let i = top.tangents[2 * k]; i < top.tangents[2 * k + 1]; i++) {
          out.tri(cornerPt, lift(top.pts[i], BASE_H), lift(top.pts[i + 1], BASE_H), DOWN);
        }
      }

      const bottom = rings[0];
      if (!spec.magnets) {
        out.fan(bottom, 0, DOWN);
        continue;
      }
      // One quadrant of the bottom per magnet pocket: foot center, the two
      // mid-edge points and the rounded corner between them, filled around the hole.
      const half = FOOT_RINGS[0].size / 2;
      for (const m of magnetCenters(c, r)) {
        const sx = m.x > center.x ? 1 : -1;
        const sz = m.z > center.z ? 1 : -1;
        const k = sx > 0 ? (sz < 0 ? 0 : 1) : sz > 0 ? 2 : 3;
        const arc = bottom.pts.slice(bottom.tangents[2 * k], bottom.tangents[2 * k + 1] + 1);
        const onZ: Pair = [center.x, center.z + sz * half];
        const onX: Pair = [center.x + sx * half, center.z];
        const d2 = (p: Pair, q: Pair) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
        if (d2(arc[0], onZ) > d2(arc[0], onX)) arc.reverse();
        const hole = sampleCircle(m.x, m.z, MAGNET_D / 2, HOLE_SEGS);
        ringStrip(hole, [cp, onZ, ...arc, onX], 0, DOWN, out);
        const n = hole.pts.length;
        for (let i = 0; i < n; i++) {
          const a = hole.pts[i], b = hole.pts[(i + 1) % n];
          out.quad(lift(a, 0), lift(b, 0), lift(b, MAGNET_H), lift(a, MAGNET_H), [
            m.x - (a[0] + b[0]) / 2, 0, m.z - (a[1] + b[1]) / 2,
          ]);
        }
        out.fan(hole, MAGNET_H, DOWN);
        out.ringLines(hole, 0);
        out.ringLines(hole, MAGNET_H);
      }
    }
  }

  return {
    positions: out.pos.result(),
    normals: out.nrm.result(),
    edges: out.lines.result(),
    cols,
    rows,
    topZ,
  };
}

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


if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  // Dev hook: time the mesher or compare it with `__cad.requestMesh` from the console.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__buildTray = buildTrayGeometry;
}
