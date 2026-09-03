// Partition of the mesher's triangle soup into animatable parts: one per foot,
// per cell (floor slab, coves, underside gaps), per divider segment, per
// junction post, per outer-wall stretch (one cell edge) and per tray corner.
//
// The soup is first split along the partition's planes (cell lines, divider
// band edges, the wall's inner face, the corner squares, the floor height) so
// no triangle straddles two parts; then each triangle is assigned by a point
// just inside the solid behind it — a face on a boundary belongs to whatever
// it is the surface of. The parts tile the tray exactly: merged back together
// they are the surface the mesher emitted plus the split seams, so the CAD
// comparison and the volume check still hold.

import { BASE_H, CLEAR, PITCH, R_OUT, type TraySpec } from "./protocol";
import { levels } from "./layout";
import { Buf, buildTrayGeometry, type TrayGeometry } from "./trayMesher";

export type PartKind = "foot" | "cell" | "divider" | "post" | "wall" | "corner";

export interface TrayPart {
  /** `foot:c,r` · `cell:c,r` · `div:v:r:c` (between (r,c) and (r,c+1)) · `div:h:r:c` (between (r,c) and (r+1,c)) · `post:r:c` (grid corner below-right of cell (r,c)) · `wall:top|bottom:c` · `wall:left|right:r` · `corner:tl|tr|bl|br` */
  key: string;
  kind: PartKind;
  /** Cells the part belongs to: one, two for a divider, up to four for a post. */
  cells: [number, number][];
  positions: Float32Array;
  normals: Float32Array;
  edges: Float32Array;
}

export interface PartitionedTray extends TrayGeometry {
  parts: TrayPart[];
}

type V3 = [number, number, number];

/** How far inside the solid the assignment sample sits (mm). */
const INSET = 0.05;

// --- Plan lookup ---------------------------------------------------------

interface Plan {
  cols: number;
  rows: number;
  w: number;
  /** Corner square side, from the outline: the outer radius or the wall, whichever is bigger. */
  cs: number;
  floorZ: number;
  /** Divider between (r, c) and (r, c+1). */
  vert: (r: number, c: number) => boolean;
  /** Divider between (r, c) and (r+1, c). */
  horiz: (r: number, c: number) => boolean;
}

function makePlan(spec: TraySpec): Plan {
  const { cols, rows, wall } = spec;
  const region = new Int16Array(cols * rows).fill(-1);
  spec.regions.forEach((reg, i) => {
    for (let r = reg.r0; r <= reg.r1; r++) {
      for (let c = reg.c0; c <= reg.c1; c++) region[r * cols + c] = i;
    }
  });
  const id = (r: number, c: number) => region[r * cols + c];
  return {
    cols,
    rows,
    w: wall,
    cs: CLEAR + Math.max(R_OUT, wall),
    floorZ: levels(spec).floorZ,
    vert: (r, c) => r >= 0 && r < rows && c >= 0 && c < cols - 1 && id(r, c) !== id(r, c + 1),
    horiz: (r, c) => r >= 0 && r < rows - 1 && c >= 0 && c < cols && id(r, c) !== id(r + 1, c),
  };
}

// Parts are identified by a small integer while assigning (a string per
// triangle would dominate the cost) and named once at the end.
const K_FOOT = 0, K_CELL = 1, K_DIV_V = 2, K_DIV_H = 3, K_POST = 4;
const K_WALL_TOP = 5, K_WALL_BOTTOM = 6, K_WALL_LEFT = 7, K_WALL_RIGHT = 8, K_CORNER = 9;
const code = (kind: number, a: number, b: number) => (kind * 64 + a) * 64 + b;

/** The part owning the solid at (x, y, z). */
function partAt(P: Plan, x: number, y: number, z: number): number {
  const { cols, rows, w, cs } = P;
  const c = Math.max(0, Math.min(cols - 1, Math.floor(x / PITCH)));
  const r = Math.max(0, Math.min(rows - 1, Math.floor(z / PITCH)));
  if (y < BASE_H) return code(K_FOOT, c, r);
  // The floor slab is cell material even under the walls that stand on it.
  if (y < P.floorZ) return code(K_CELL, c, r);
  const W = PITCH * cols;
  const D = PITCH * rows;
  const left = x < cs, right = x > W - cs, top = z < cs, bottom = z > D - cs;
  if ((left || right) && (top || bottom)) return code(K_CORNER, top ? 0 : 1, left ? 0 : 1);
  if (z < CLEAR + w) return code(K_WALL_TOP, c, 0);
  if (z > D - CLEAR - w) return code(K_WALL_BOTTOM, c, 0);
  if (x < CLEAR + w) return code(K_WALL_LEFT, r, 0);
  if (x > W - CLEAR - w) return code(K_WALL_RIGHT, r, 0);
  // Interior: divider bands straddle the interior grid lines by w/2.
  const gx = Math.round(x / PITCH);
  const gz = Math.round(z / PITCH);
  const inV = gx >= 1 && gx <= cols - 1 && Math.abs(x - gx * PITCH) <= w / 2;
  const inH = gz >= 1 && gz <= rows - 1 && Math.abs(z - gz * PITCH) <= w / 2;
  if (inV && inH) {
    // Junction square at grid corner (gx, gz). A wall running straight through
    // keeps it (the upper/left segment owns it); anything else is a post.
    const up = P.vert(gz - 1, gx - 1);
    const down = P.vert(gz, gx - 1);
    const lft = P.horiz(gz - 1, gx - 1);
    const rgt = P.horiz(gz - 1, gx);
    const n = +up + +down + +lft + +rgt;
    if (n === 0) return code(K_CELL, c, r);
    if (n === 2 && up && down) return code(K_DIV_V, gz - 1, gx - 1);
    if (n === 2 && lft && rgt) return code(K_DIV_H, gz - 1, gx - 1);
    return code(K_POST, gz - 1, gx - 1);
  }
  if (inV) return P.vert(r, gx - 1) ? code(K_DIV_V, r, gx - 1) : code(K_CELL, c, r);
  if (inH) return P.horiz(gz - 1, c) ? code(K_DIV_H, gz - 1, c) : code(K_CELL, c, r);
  return code(K_CELL, c, r);
}

function describe(id: number, P: Plan): Pick<TrayPart, "key" | "kind" | "cells"> {
  const kind = Math.floor(id / 4096);
  const a = Math.floor(id / 64) % 64;
  const b = id % 64;
  switch (kind) {
    case K_FOOT:
      return { key: `foot:${a},${b}`, kind: "foot", cells: [[a, b]] };
    case K_CELL:
      return { key: `cell:${a},${b}`, kind: "cell", cells: [[a, b]] };
    case K_DIV_V:
      return { key: `div:v:${a}:${b}`, kind: "divider", cells: [[b, a], [b + 1, a]] };
    case K_DIV_H:
      return { key: `div:h:${a}:${b}`, kind: "divider", cells: [[b, a], [b, a + 1]] };
    case K_POST:
      return { key: `post:${a}:${b}`, kind: "post", cells: [[b, a], [b + 1, a], [b, a + 1], [b + 1, a + 1]] };
    case K_WALL_TOP:
      return { key: `wall:top:${a}`, kind: "wall", cells: [[a, 0]] };
    case K_WALL_BOTTOM:
      return { key: `wall:bottom:${a}`, kind: "wall", cells: [[a, P.rows - 1]] };
    case K_WALL_LEFT:
      return { key: `wall:left:${a}`, kind: "wall", cells: [[0, a]] };
    case K_WALL_RIGHT:
      return { key: `wall:right:${a}`, kind: "wall", cells: [[P.cols - 1, a]] };
    default:
      return {
        key: `corner:${a === 0 ? "t" : "b"}${b === 0 ? "l" : "r"}`,
        kind: "corner",
        cells: [[b === 0 ? 0 : P.cols - 1, a === 0 ? 0 : P.rows - 1]],
      };
  }
}

// --- Splitting -----------------------------------------------------------

/**
 * Sorted plane positions per axis (x, y, z) that no triangle may straddle.
 * `low` is the subset that matters at or below the base (the underside gaps
 * between feet only need the cell lines).
 */
function splitPlanes(P: Plan): { all: [number[], number[], number[]]; low: [number[], number[], number[]] } {
  const { cols, rows, w, cs } = P;
  const axis = (n: number, L: number) => {
    const v = [CLEAR + w, cs, L - cs, L - CLEAR - w];
    for (let i = 1; i < n; i++) v.push(i * PITCH - w / 2, i * PITCH, i * PITCH + w / 2);
    return [...new Set(v.map((x) => +x.toFixed(9)))].sort((a, b) => a - b);
  };
  const lines = (n: number) => Array.from({ length: n - 1 }, (_, i) => (i + 1) * PITCH);
  return {
    all: [axis(cols, PITCH * cols), [P.floorZ], axis(rows, PITCH * rows)],
    low: [lines(cols), [], lines(rows)],
  };
}

/** Index of the first plane > lo (binary search). */
function firstAbove(planes: number[], lo: number): number {
  let a = 0, b = planes.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (planes[m] <= lo + 1e-9) a = m + 1;
    else b = m;
  }
  return a;
}

/** Splits a convex polygon by the plane axis = v into the two sides (either may be empty). */
function splitPoly(poly: V3[], axis: number, v: number): [V3[], V3[]] {
  const below: V3[] = [];
  const above: V3[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const dp = p[axis] - v;
    const dq = q[axis] - v;
    if (dp <= 0) below.push(p);
    if (dp >= 0) above.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      // Interpolate from the lower-coordinate endpoint so a shared edge splits identically in both triangles.
      const [s, e] = dp < dq ? [p, q] : [q, p];
      const t = (v - s[axis]) / (e[axis] - s[axis]);
      const m: V3 = [s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1]), s[2] + t * (e[2] - s[2])];
      m[axis] = v;
      below.push(m);
      above.push(m);
    }
  }
  return [below.length >= 3 ? below : [], above.length >= 3 ? above : []];
}

interface Group {
  pos: Buf;
  nrm: Buf;
  lines: Buf;
}

/**
 * Splits `geometry` into parts. One pass over the soup; triangles that cross
 * no plane (the vast majority) are copied without any allocation, and feet —
 * always one part each — skip the plan planes altogether.
 */
export function partitionTray(spec: TraySpec, geometry: TrayGeometry): PartitionedTray {
  const P = makePlan(spec);
  const { all: planesAll, low: planesLow } = splitPlanes(P);
  const groups = new Map<number, Group>();
  // Consecutive triangles almost always share a part: remember the last one.
  let lastId = -1;
  let lastGroup: Group | null = null;
  const group = (id: number): Group => {
    if (id === lastId && lastGroup) return lastGroup;
    let g = groups.get(id);
    if (!g) {
      g = { pos: new Buf(), nrm: new Buf(), lines: new Buf() };
      groups.set(id, g);
    }
    lastId = id;
    lastGroup = g;
    return g;
  };

  const { positions: pos, normals: nrm } = geometry;
  const emit = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    nx: number, ny: number, nz: number,
  ) => {
    const g = group(
      partAt(P, (ax + bx + cx) / 3 - nx * INSET, (ay + by + cy) / 3 - ny * INSET, (az + bz + cz) / 3 - nz * INSET),
    );
    g.pos.reserve(9);
    g.pos.put3(ax, ay, az);
    g.pos.put3(bx, by, bz);
    g.pos.put3(cx, cy, cz);
    g.nrm.reserve(9);
    g.nrm.put3(nx, ny, nz);
    g.nrm.put3(nx, ny, nz);
    g.nrm.put3(nx, ny, nz);
  };

  const range: [number, number][] = [[0, 0], [0, 0], [0, 0]];
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const nx = nrm[i], ny = nrm[i + 1], nz = nrm[i + 2];
    const cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
    // A foot is one part and never crosses a cell line: copy it straight through.
    // The underside gaps (exactly at the base) only split along cell lines.
    const foot = cy < BASE_H - 1e-6;
    const planes = cy <= BASE_H + 1e-6 ? planesLow : planesAll;
    let crosses = false;
    if (!foot) {
      for (let axis = 0; axis < 3; axis++) {
        const v0 = pos[i + axis], v1 = pos[i + 3 + axis], v2 = pos[i + 6 + axis];
        const lo = Math.min(v0, v1, v2);
        const hi = Math.max(v0, v1, v2);
        const a = firstAbove(planes[axis], lo);
        let b = a;
        while (b < planes[axis].length && planes[axis][b] < hi - 1e-9) b++;
        range[axis][0] = a;
        range[axis][1] = b;
        if (b > a) crosses = true;
      }
    }
    if (!crosses) {
      emit(pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5], pos[i + 6], pos[i + 7], pos[i + 8], nx, ny, nz);
      continue;
    }
    let polys: V3[][] = [[
      [pos[i], pos[i + 1], pos[i + 2]],
      [pos[i + 3], pos[i + 4], pos[i + 5]],
      [pos[i + 6], pos[i + 7], pos[i + 8]],
    ]];
    for (let axis = 0; axis < 3; axis++) {
      for (let k = range[axis][0]; k < range[axis][1]; k++) {
        const v = planes[axis][k];
        const next: V3[][] = [];
        for (const poly of polys) {
          // Only pieces that straddle the plane are cut; the rest pass through untouched.
          let lo = Infinity, hi = -Infinity;
          for (const p of poly) {
            if (p[axis] < lo) lo = p[axis];
            if (p[axis] > hi) hi = p[axis];
          }
          if (v <= lo + 1e-9 || v >= hi - 1e-9) {
            next.push(poly);
            continue;
          }
          const [below, above] = splitPoly(poly, axis, v);
          if (below.length) next.push(below);
          if (above.length) next.push(above);
        }
        polys = next;
      }
    }
    for (const poly of polys) {
      const p0 = poly[0];
      for (let k = 1; k < poly.length - 1; k++) {
        const p1 = poly[k], p2 = poly[k + 1];
        emit(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], nx, ny, nz);
      }
    }
  }

  // Edge lines: split at the same planes, assigned by their midpoint.
  const e = geometry.edges;
  for (let i = 0; i + 5 < e.length; i += 6) {
    let segs: [V3, V3][] = [[[e[i], e[i + 1], e[i + 2]], [e[i + 3], e[i + 4], e[i + 5]]]];
    const my = (e[i + 1] + e[i + 4]) / 2;
    const foot = my < BASE_H - 1e-6;
    const planes = my <= BASE_H + 1e-6 ? planesLow : planesAll;
    for (let axis = 0; axis < 3 && !foot; axis++) {
      const lo = Math.min(e[i + axis], e[i + 3 + axis]);
      const hi = Math.max(e[i + axis], e[i + 3 + axis]);
      for (let k = firstAbove(planes[axis], lo); k < planes[axis].length && planes[axis][k] < hi - 1e-9; k++) {
        const v = planes[axis][k];
        const next: [V3, V3][] = [];
        for (const [p, q] of segs) {
          if ((p[axis] - v) * (q[axis] - v) < 0) {
            const t = (v - p[axis]) / (q[axis] - p[axis]);
            const m: V3 = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
            next.push([p, m], [m, q]);
          } else {
            next.push([p, q]);
          }
        }
        segs = next;
      }
    }
    for (const [p, q] of segs) {
      const g = group(partAt(P, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2));
      g.lines.reserve(6);
      g.lines.put3(p[0], p[1], p[2]);
      g.lines.put3(q[0], q[1], q[2]);
    }
  }

  const parts: TrayPart[] = [];
  for (const [id, g] of groups) {
    parts.push({ ...describe(id, P), positions: g.pos.result(), normals: g.nrm.result(), edges: g.lines.result() });
  }
  return { ...mergeParts(parts), cols: geometry.cols, rows: geometry.rows, topZ: geometry.topZ, parts };
}

/** The parts' surfaces concatenated — what the tray looks like with nothing animating. */
export function mergeParts(parts: TrayPart[]): Pick<TrayGeometry, "positions" | "normals" | "edges"> {
  let np = 0, ne = 0;
  for (const p of parts) {
    np += p.positions.length;
    ne += p.edges.length;
  }
  const positions = new Float32Array(np);
  const normals = new Float32Array(np);
  const edges = new Float32Array(ne);
  let ip = 0, ie = 0;
  for (const p of parts) {
    positions.set(p.positions, ip);
    normals.set(p.normals, ip);
    ip += p.positions.length;
    edges.set(p.edges, ie);
    ie += p.edges.length;
  }
  return { positions, normals, edges };
}

/**
 * Meshes the tray — the geometry the viewer renders — and partitions it lazily:
 * `parts` is computed on first access, which only a transition does. The resize
 * preview (built at every drag snap) therefore pays for the mesh alone, and the
 * merged arrays are the mesher's own soup, fewer triangles than the split parts.
 * Memoized on the spec (a handful of recent results), so the commit after a
 * drag reuses the preview's build; same spec ⇒ same object, which the viewer's
 * identity checks rely on.
 */
const recent = new Map<string, PartitionedTray>();
const RECENT_MAX = 8;

export function buildTrayParts(spec: TraySpec): PartitionedTray {
  const key = JSON.stringify([spec.cols, spec.rows, spec.heightMm, spec.wall, spec.floor, spec.lip, spec.magnets, spec.regions]);
  const hit = recent.get(key);
  if (hit) {
    recent.delete(key);
    recent.set(key, hit);
    return hit;
  }
  const raw = buildTrayGeometry(spec);
  let parts: TrayPart[] | null = null;
  const built: PartitionedTray = {
    ...raw,
    get parts() {
      if (!parts) parts = partitionTray(spec, raw).parts;
      return parts;
    },
  };
  recent.set(key, built);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
  return built;
}

if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__buildTrayParts = buildTrayParts;
}
