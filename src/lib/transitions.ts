// How one tray layout turns into the next, for the viewer's animations. Both
// trays come partitioned into parts (lib/trayParts); the diff is by part key,
// after mapping the old keys into the new world. Parts only the new tray has
// enter, parts only the old tray had leave; each side is grouped into entities
// — a cell with everything that belongs to it, or a lone wall segment — and
// given a preset from lib/animPresets. Pure: the viewer only plays this back.

import { PITCH, type TrayParams } from "./protocol";
import { type Frame, type GridState, regionAt } from "./grid";
import type { PartKind, PartitionedTray, TrayPart } from "./trayParts";
import { PRESET_MS, slowFactor, type PresetName } from "./animPresets";

/** Between consecutive cells of a resize wave; shrinks when many cells move at once. */
export const CELL_STAGGER_MS = 180;
/** Between consecutive walls landing after a split. */
export const LAND_STAGGER_MS = 120;
/**
 * How far a leaving cell's start slides off the wave, as a fraction of its own
 * delay: 0.5 means anywhere in ±50% of it. The wave keeps its shape (a cell
 * twice as late jitters twice as widely) but stops marching in lockstep.
 */
export const CELL_DELAY_CHAOS = 0.9;

export interface EntityAnim {
  id: string;
  /** Part keys merged into the entity's mesh. */
  keys: string[];
  preset: PresetName;
  /** ms after the transition start. */
  delay: number;
  /** Unit plan direction away from the change's center (zero when there is none). */
  dir: [number, number];
  /** Stable number in [0, 1) for deterministic variation. */
  seed: number;
}

export interface Transition {
  start: number;
  /** ms from the moment playback starts (the second frame after the scene is up) until everything has settled. */
  duration: number;
  /** Entities of the new tray; the static mesh omits their parts while they play. */
  enter: EntityAnim[];
  /** Entities of the old tray, rendered from `leaveTray` at `leaveOffset`. */
  leave: EntityAnim[];
  leaveTray: PartitionedTray;
  leaveGrid: GridState;
  /** Where the old tray sits in the new world (a left/top resize shifts the origin). */
  leaveOffset: [number, number, number];
}

export interface Snapshot {
  grid: GridState;
  geometry: PartitionedTray;
  params: TrayParams;
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
 * The key an old part would have in the new tray, or null when the feature it
 * names no longer exists there (an outer wall that turned into a divider, a
 * corner that moved). Cells shift by the frame's origin; edge features survive
 * only if their edge is still the tray's edge.
 */
function remapKey(key: string, f: Frame, og: GridState): string | null {
  const [kind, ...rest] = key.split(":");
  const dc = -f.c0, dr = -f.r0;
  switch (kind) {
    case "foot":
    case "cell": {
      const [c, r] = rest[0].split(",").map(Number);
      return `${kind}:${c + dc},${r + dr}`;
    }
    case "div":
      return `div:${rest[0]}:${Number(rest[1]) + dr}:${Number(rest[2]) + dc}`;
    case "post":
      return `post:${Number(rest[0]) + dr}:${Number(rest[1]) + dc}`;
    case "wall": {
      const i = Number(rest[1]);
      switch (rest[0]) {
        case "top":
          return f.r0 === 0 ? `wall:top:${i + dc}` : null;
        case "bottom":
          return f.r1 === og.rows ? `wall:bottom:${i + dc}` : null;
        case "left":
          return f.c0 === 0 ? `wall:left:${i + dr}` : null;
        default:
          return f.c1 === og.cols ? `wall:right:${i + dr}` : null;
      }
    }
    default: {
      const t = rest[0][0] === "t", l = rest[0][1] === "l";
      const rowOk = t ? f.r0 === 0 : f.r1 === og.rows;
      const colOk = l ? f.c0 === 0 : f.c1 === og.cols;
      return rowOk && colOk ? key : null;
    }
  }
}

/** Plan center of a part (bounding box middle of its vertices). */
function partCenter(p: TrayPart): [number, number] {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.positions.length; i += 3) {
    const x = p.positions[i], z = p.positions[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [(x0 + x1) / 2, (z0 + z1) / 2];
}

interface CellOrder {
  key: string;
  /** Chebyshev distance to the footprint the cell joins or leaves (≥ 1). */
  dist: number;
  /** Position along the moving edge, for a diagonal ripple. */
  along: number;
}

/**
 * Delays for a wave of cells: nearest-first when growing, farthest-first when
 * shrinking, each start scattered by `chaos` × its own delay. `rand` returns
 * [0, 1) per cell — it is seeded off the transition's timestamp rather than
 * Math.random() because this runs during render.
 */
function schedule(
  cells: CellOrder[],
  reverse: boolean,
  scale: number,
  chaos: number,
  rand: (i: number) => number,
): Map<string, number> {
  const delays = new Map<string, number>();
  if (cells.length === 0) return delays;
  const step = Math.min(CELL_STAGGER_MS, 2400 / cells.length) * scale;
  const maxD = Math.max(...cells.map((c) => c.dist));
  cells.forEach((c, i) => {
    const d = step * ((reverse ? maxD - c.dist : c.dist - 1) + 0.35 * c.along);
    delays.set(c.key, d * (1 + chaos * (rand(i) * 2 - 1)));
  });
  return delays;
}

const hash = (i: number) => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** Groups parts into entities: one per animating cell (claiming every part that touches it), then one per leftover part. */
function entities(
  parts: TrayPart[],
  cellDelays: Map<string, number>,
  cellPreset: PresetName,
  lonePreset: (kind: PartKind) => PresetName,
  loneStagger: number,
  idPrefix: string,
): EntityAnim[] {
  const claimed = new Set<string>();
  const out: EntityAnim[] = [];
  for (const [cell, delay] of cellDelays) {
    const [c, r] = cell.split(",").map(Number);
    const keys = parts
      .filter((p) => !claimed.has(p.key) && p.cells.some(([pc, pr]) => pc === c && pr === r))
      .map((p) => p.key);
    keys.forEach((k) => claimed.add(k));
    if (keys.length) out.push({ id: `${idPrefix}cell:${cell}`, keys, preset: cellPreset, delay, dir: [0, 0], seed: 0 });
  }
  let landed = 0;
  for (const p of parts) {
    if (claimed.has(p.key)) continue;
    const preset = lonePreset(p.kind);
    out.push({ id: `${idPrefix}${p.key}`, keys: [p.key], preset, delay: preset === "land" ? landed++ * loneStagger : 0, dir: [0, 0], seed: 0 });
  }
  return out;
}

/**
 * The transition from `prev` to `next`, or null when nothing animates. `frame`
 * is the resize that produced `next` (in `prev`'s grid units) and says where the
 * old cells sit in the new world; without it the change is a fuse/split.
 */
export function makeTransition(prev: Snapshot, next: Snapshot, frame: Frame | null, now: number): Transition | null {
  if (prev.grid === next.grid || sameGrid(prev.grid, next.grid)) return null;
  const slow = slowFactor();
  const og = prev.grid, ng = next.grid;
  const f: Frame = frame ?? { c0: 0, r0: 0, c1: og.cols, r1: og.rows };

  // Diff by key: old parts whose remapped key exists in the new tray survive.
  const newByKey = new Map(next.geometry.parts.map((p) => [p.key, p]));
  const survived = new Set<string>();
  const leavingParts: TrayPart[] = [];
  for (const p of prev.geometry.parts) {
    const k = remapKey(p.key, f, og);
    if (k && newByKey.has(k)) survived.add(k);
    else leavingParts.push(p);
  }
  const enteringParts = next.geometry.parts.filter((p) => !survived.has(p.key));
  if (enteringParts.length === 0 && leavingParts.length === 0) return null;

  // Cells joining and leaving (a resize); fuse/split have none.
  const appearing: CellOrder[] = [];
  const leaving: CellOrder[] = [];
  if (frame) {
    for (let r = 0; r < ng.rows; r++) {
      for (let c = 0; c < ng.cols; c++) {
        const oc = c + f.c0, or = r + f.r0;
        const dx = oc < 0 ? -oc : oc >= og.cols ? oc - og.cols + 1 : 0;
        const dz = or < 0 ? -or : or >= og.rows ? or - og.rows + 1 : 0;
        if (dx || dz) appearing.push({ key: `${c},${r}`, dist: Math.max(dx, dz), along: dx > 0 ? r : c });
      }
    }
    for (let r = 0; r < og.rows; r++) {
      for (let c = 0; c < og.cols; c++) {
        const dx = c < f.c0 ? f.c0 - c : c >= f.c1 ? c - f.c1 + 1 : 0;
        const dz = r < f.r0 ? f.r0 - r : r >= f.r1 ? r - f.r1 + 1 : 0;
        if (dx || dz) leaving.push({ key: `${c},${r}`, dist: Math.max(dx, dz), along: dx > 0 ? r : c });
      }
    }
  }

  const rand = (i: number) => hash(i + now);
  const enter = entities(
    enteringParts,
    schedule(appearing, false, slow, 0, rand),
    "cellIn",
    (kind) => (kind === "divider" || kind === "post" ? "land" : "fadeIn"),
    LAND_STAGGER_MS * slow,
    "",
  );
  const leave = entities(
    leavingParts,
    schedule(leaving, true, slow, CELL_DELAY_CHAOS, rand),
    "cellOut",
    (kind) => (kind === "divider" || kind === "post" ? "explode" : "fadeOut"),
    0,
    "old:",
  );

  // Directions radiate from the center of everything that changed.
  const leaveOffset: [number, number, number] = [-f.c0 * PITCH, 0, -f.r0 * PITCH];
  const oldByKey = new Map(prev.geometry.parts.map((p) => [p.key, p]));
  const centerOf = (e: EntityAnim, byKey: Map<string, TrayPart>, off: [number, number]): [number, number] => {
    let x = 0, z = 0, n = 0;
    for (const k of e.keys) {
      const p = byKey.get(k);
      if (!p) continue;
      const [cx, cz] = partCenter(p);
      x += cx + off[0];
      z += cz + off[1];
      n++;
    }
    return n ? [x / n, z / n] : [0, 0];
  };
  const centers = [
    ...enter.map((e) => centerOf(e, newByKey, [0, 0])),
    ...leave.map((e) => centerOf(e, oldByKey, [leaveOffset[0], leaveOffset[2]])),
  ];
  const cx = centers.reduce((s, c) => s + c[0], 0) / centers.length;
  const cz = centers.reduce((s, c) => s + c[1], 0) / centers.length;
  [...enter, ...leave].forEach((e, i) => {
    const [ex, ez] = centers[i];
    const len = Math.hypot(ex - cx, ez - cz);
    const a = hash(i) * Math.PI * 2;
    e.dir = len > 1e-6 ? [(ex - cx) / len, (ez - cz) / len] : [Math.cos(a), Math.sin(a)];
    e.seed = hash(i + 1);
  });

  let duration = 0;
  for (const e of [...enter, ...leave]) duration = Math.max(duration, e.delay + PRESET_MS[e.preset] * slow);
  return { start: now, duration: duration + 30, enter, leave, leaveTray: prev.geometry, leaveGrid: prev.grid, leaveOffset };
}
