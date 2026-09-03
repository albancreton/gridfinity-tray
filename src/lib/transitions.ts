// How one tray layout turns into the next, for the viewer's animations: which
// cells appear or vanish after a resize (and in what order), which divider walls
// a fuse removes or a split adds. Pure — the viewer only plays these back.

import { CLEAR, PITCH, type TrayParams } from "./protocol";
import { type Frame, type GridState, regionAt } from "./grid";
import { levels, pocketRect } from "./layout";
import type { TrayGeometry } from "./trayMesher";

// Deliberately unhurried: the user wants to watch these happen. Below ~450ms a
// reveal reads as a flash; 520ms still felt quick.
/** One cell printing in (or un-printing). */
export const CELL_REVEAL_MS = 1300;
/** Between consecutive cells; shrinks when many cells move at once. */
export const CELL_STAGGER_MS = 180;
export const PART_EXPLODE_MS = 2000;
export const PART_LAND_MS = 1000;
export const PART_STAGGER_MS = 120;

/**
 * Per-cell reveal schedule for one tray mesh: a delay in ms per cell (row-major
 * in that mesh's own grid), negative for cells that don't animate. "in": animated
 * cells print from the bed up, the rest are shown. "out": animated cells
 * un-print, the rest are hidden.
 */
export interface CellAnim {
  start: number;
  duration: number;
  delays: Float32Array;
  mode: "in" | "out";
}

/** Axis-aligned box (mm, world frame) standing in for a divider wall segment. */
export interface PartBox {
  key: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

export interface PartGroup {
  boxes: PartBox[];
  /** explode: burst up and away, fading. land: drop in from above, one after another. */
  mode: "explode" | "land";
  /** Plan center the explosion radiates from. */
  center: [number, number];
  /** Per part: total flight (explode) or fall time (land), ms. */
  duration: number;
  /** Between consecutive parts (land), ms. */
  stagger: number;
}

/** World-space box above `minY` whose contents the main mesh hides (a split's new dividers until their stand-ins land). */
export interface HideBox {
  min: [number, number];
  max: [number, number];
  minY: number;
}

export interface Snapshot {
  grid: GridState;
  geometry: TrayGeometry;
  params: TrayParams;
}

export interface Transition {
  start: number;
  /** When everything has settled; the viewer drops the transition then. */
  end: number;
  /** Cells of the new tray printing in. */
  appear: CellAnim | null;
  /** The previous geometry, placed in the new world, with its removed cells un-printing. */
  retire: { geometry: TrayGeometry; grid: GridState; offset: [number, number, number]; anim: CellAnim } | null;
  parts: PartGroup[];
  hide: HideBox | null;
}

function regionKey(g: GridState, r: number, c: number): string {
  const reg = regionAt(g, r, c);
  return `${reg.r0},${reg.c0},${reg.r1},${reg.c1}`;
}

function sameGrid(a: GridState, b: GridState): boolean {
  if (a.cols !== b.cols || a.rows !== b.rows || a.merges.length !== b.merges.length) return false;
  for (let r = 0; r < a.rows; r++) {
    for (let c = 0; c < a.cols; c++) if (regionKey(a, r, c) !== regionKey(b, r, c)) return false;
  }
  return true;
}

/**
 * Every interior divider of a grid as a box, one per cell edge that separates two
 * compartments. Ends reach into the outer wall at the tray edge and into the
 * junction post where a perpendicular divider meets, and butt flush against a
 * continuing one — so a run of boxes reads as one wall and hides inside solids.
 */
export function dividerBoxes(grid: GridState, params: TrayParams): PartBox[] {
  const { cols, rows } = grid;
  const lv = levels(params);
  const half = params.wall / 2;
  const y0 = lv.floorZ - 0.3;
  const y1 = lv.dividerTop;
  const keys: string[][] = [];
  for (let r = 0; r < rows; r++) {
    keys.push([]);
    for (let c = 0; c < cols; c++) keys[r].push(regionKey(grid, r, c));
  }
  // Divider between (r, c) and (r, c+1) / between (r, c) and (r+1, c).
  const vert = (r: number, c: number) =>
    r >= 0 && r < rows && c >= 0 && c < cols - 1 && keys[r][c] !== keys[r][c + 1];
  const horiz = (r: number, c: number) =>
    r >= 0 && r < rows - 1 && c >= 0 && c < cols && keys[r][c] !== keys[r + 1][c];
  const out: PartBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (!vert(r, c)) continue;
      const x = PITCH * (c + 1);
      const z0 = r === 0 ? CLEAR + half : vert(r - 1, c) ? PITCH * r : PITCH * r - half;
      const z1 =
        r === rows - 1 ? PITCH * rows - CLEAR - half : vert(r + 1, c) ? PITCH * (r + 1) : PITCH * (r + 1) + half;
      out.push({ key: `v${r}:${c}`, x0: x - half, x1: x + half, z0, z1, y0, y1 });
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (!horiz(r, c)) continue;
      const z = PITCH * (r + 1);
      const x0 = c === 0 ? CLEAR + half : horiz(r, c - 1) ? PITCH * c : PITCH * c - half;
      const x1 =
        c === cols - 1 ? PITCH * cols - CLEAR - half : horiz(r, c + 1) ? PITCH * (c + 1) : PITCH * (c + 1) + half;
      out.push({ key: `h${r}:${c}`, x0, x1, z0: z - half, z1: z + half, y0, y1 });
    }
  }
  return out;
}

function centroid(boxes: PartBox[]): [number, number] {
  let x = 0, z = 0;
  for (const b of boxes) {
    x += (b.x0 + b.x1) / 2;
    z += (b.z0 + b.z1) / 2;
  }
  return [x / boxes.length, z / boxes.length];
}

interface CellOrder {
  index: number;
  /** Chebyshev distance to the footprint the cell joins or leaves (≥ 1). */
  dist: number;
  /** Position along the moving edge, for a diagonal ripple. */
  along: number;
}

/** Delays for a wave of cells: nearest-first when growing, farthest-first when shrinking. */
function schedule(
  cells: CellOrder[],
  count: number,
  reverse: boolean,
  scale: number,
): { delays: Float32Array; last: number } {
  const delays = new Float32Array(count).fill(-1);
  if (cells.length === 0) return { delays, last: 0 };
  const step = Math.min(CELL_STAGGER_MS, 2400 / cells.length) * scale;
  const maxD = Math.max(...cells.map((c) => c.dist));
  let last = 0;
  for (const c of cells) {
    const d = (reverse ? maxD - c.dist : c.dist - 1) + 0.35 * c.along;
    delays[c.index] = step * d;
    last = Math.max(last, delays[c.index]);
  }
  return { delays, last };
}

/**
 * The transition from `prev` to `next`, or null when nothing animates. `frame`
 * is the resize that produced `next` (in `prev`'s grid units), needed to know
 * where the old cells sit in the new world; without it a same-size change is a
 * fuse/split and its divider walls become rigid stand-ins.
 */
export function makeTransition(prev: Snapshot, next: Snapshot, frame: Frame | null, now: number): Transition | null {
  if (prev.grid === next.grid || sameGrid(prev.grid, next.grid)) return null;
  const t: Transition = { start: now, end: now, appear: null, retire: null, parts: [], hide: null };
  const og = prev.grid;
  const ng = next.grid;
  // Dev hook: `window.__animSlow = 6` stretches every transition 6× for inspection.
  const slow =
    typeof window !== "undefined" && process.env.NODE_ENV === "development"
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Number((window as any).__animSlow) || 1
      : 1;
  const CELL_REVEAL = CELL_REVEAL_MS * slow;
  const PART_EXPLODE = PART_EXPLODE_MS * slow;
  const PART_LAND = PART_LAND_MS * slow;
  const PART_STAGGER = PART_STAGGER_MS * slow;

  if (frame) {
    // New cell (c, r) was old cell (c + frame.c0, r + frame.r0).
    const appearing: CellOrder[] = [];
    for (let r = 0; r < ng.rows; r++) {
      for (let c = 0; c < ng.cols; c++) {
        const oc = c + frame.c0, or = r + frame.r0;
        const dx = oc < 0 ? -oc : oc >= og.cols ? oc - og.cols + 1 : 0;
        const dz = or < 0 ? -or : or >= og.rows ? or - og.rows + 1 : 0;
        if (dx === 0 && dz === 0) continue;
        appearing.push({ index: r * ng.cols + c, dist: Math.max(dx, dz), along: dx > 0 ? r : c });
      }
    }
    const leaving: CellOrder[] = [];
    for (let r = 0; r < og.rows; r++) {
      for (let c = 0; c < og.cols; c++) {
        const dx = c < frame.c0 ? frame.c0 - c : c >= frame.c1 ? c - frame.c1 + 1 : 0;
        const dz = r < frame.r0 ? frame.r0 - r : r >= frame.r1 ? r - frame.r1 + 1 : 0;
        if (dx === 0 && dz === 0) continue;
        leaving.push({ index: r * og.cols + c, dist: Math.max(dx, dz), along: dx > 0 ? r : c });
      }
    }
    if (appearing.length > 0) {
      const s = schedule(appearing, ng.cols * ng.rows, false, slow);
      t.appear = { start: now, duration: CELL_REVEAL, delays: s.delays, mode: "in" };
      t.end = Math.max(t.end, now + s.last + CELL_REVEAL);
    }
    if (leaving.length > 0) {
      const s = schedule(leaving, og.cols * og.rows, true, slow);
      t.retire = {
        geometry: prev.geometry,
        grid: og,
        offset: [-frame.c0 * PITCH, 0, -frame.r0 * PITCH],
        anim: { start: now, duration: CELL_REVEAL, delays: s.delays, mode: "out" },
      };
      t.end = Math.max(t.end, now + s.last + CELL_REVEAL);
    }
  } else if (og.cols === ng.cols && og.rows === ng.rows) {
    const before = dividerBoxes(og, next.params);
    const after = dividerBoxes(ng, next.params);
    const beforeKeys = new Set(before.map((b) => b.key));
    const afterKeys = new Set(after.map((b) => b.key));
    const removed = before.filter((b) => !afterKeys.has(b.key));
    const added = after.filter((b) => !beforeKeys.has(b.key));
    if (removed.length > 0) {
      t.parts.push({ boxes: removed, mode: "explode", center: centroid(removed), duration: PART_EXPLODE, stagger: 0 });
      t.end = Math.max(t.end, now + PART_EXPLODE);
    }
    if (added.length > 0) {
      t.parts.push({ boxes: added, mode: "land", center: centroid(added), duration: PART_LAND, stagger: PART_STAGGER });
      t.end = Math.max(t.end, now + PART_LAND + PART_STAGGER * (added.length - 1));
      // Hide the real new dividers until the stand-ins have landed: everything
      // above the floor inside the split compartments (their walls excluded).
      const lv = levels(next.params);
      const box = { min: [Infinity, Infinity] as [number, number], max: [-Infinity, -Infinity] as [number, number] };
      const seen = new Set<string>();
      for (let r = 0; r < og.rows; r++) {
        for (let c = 0; c < og.cols; c++) {
          const k = regionKey(og, r, c);
          if (k === regionKey(ng, r, c) || seen.has(k)) continue;
          seen.add(k);
          const rr = pocketRect({ cols: og.cols, rows: og.rows, wall: next.params.wall }, regionAt(og, r, c));
          if (!rr) continue;
          box.min[0] = Math.min(box.min[0], rr.x0 + 0.05);
          box.min[1] = Math.min(box.min[1], rr.z0 + 0.05);
          box.max[0] = Math.max(box.max[0], rr.x1 - 0.05);
          box.max[1] = Math.max(box.max[1], rr.z1 - 0.05);
        }
      }
      if (seen.size > 0) t.hide = { min: box.min, max: box.max, minY: lv.floorZ + 0.05 };
    }
  }

  if (!t.appear && !t.retire && t.parts.length === 0) return null;
  t.end += 30;
  return t;
}
