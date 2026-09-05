// IKEA SKÅDIS pegboard: the spec, the layout and the state model, all in one
// file — this is the board's `protocol.ts` + `layout.ts` + `grid.ts`, and it is
// small because a board has no compartments. The only edit is adding or
// removing columns and rows.
//
// Plan coordinates match the tray's: x along columns, z along rows, the board's
// top-left corner pinned to the world origin, heights in mm above the bed. So
// growing from the right or the bottom never moves what is already there.
//
// Numbers below are IKEA's own drawing, cross-checked against the product:
//
//   · slot centres sit on a 20mm lattice, the outermost 20mm from the board edge
//   · a slot exists where (c + r) is odd — the four corners are EMPTY, which is
//     what the real board does; same-row slots are therefore 40mm apart with the
//     interleaved set offset 20/20
//   · slot = vertical obround, 5 wide × 15 tall, R2.5, 1mm fillet into each face
//   · board corners R8, panel 5mm thick (measured)
//
// The counts land the real boards exactly: 17×27 → 360×560, 27×27 → 560×560,
// 37×27 → 760×560.

import type { Frame } from "./grid";
import { insetRRect, type Outline, type Pair, type RRect } from "./meshKit";

/** Lattice step between neighbouring slot positions, on both axes. */
export const LATTICE = 20;
/** Distance between two slots in the same row — every other lattice column. */
export const SLOT_PITCH = 2 * LATTICE;
/** Board edge to the outermost slot centre. */
export const MARGIN = 20;

export const SLOT_W = 5;
export const SLOT_H = 15;
export const SLOT_R = SLOT_W / 2;
/** The drawing's 1mm fillet where a slot meets a face; we cut it as a chamfer. */
export const SLOT_CHAMFER = 1;
export const BOARD_R = 8;
export const DEFAULT_THICKNESS = 5;

// Odd only: the checkerboard is symmetric about both axes only for odd counts,
// and a step of 2 is what keeps the slot parity fixed when the board grows from
// the left or the top.
export const MIN_UNITS = 3;
export const MAX_UNITS = 37;
export const UNIT_STEP = 2;

export interface SkadisParams {
  /** Panel thickness in mm. 5 on the real board. */
  thickness: number;
  /** Chamfer the slot mouths (the drawing's 1mm fillet). */
  chamfer: boolean;
  /**
   * Printer bed in mm, or null to print the board whole. The cuts are derived
   * from it (`boardSplit`) rather than stored, so the bed is the only state and
   * a resize re-plans the split for free.
   */
  bed: { w: number; d: number } | null;
  /** How a seam interlocks, when the board is split. */
  joint: JointKind;
  /** Gap between a tooth and its socket, per face. */
  clearance: number;
}

/** The only thing a board's editor owns: how many lattice columns and rows. */
export interface SkadisState {
  cols: number;
  rows: number;
}

export interface SkadisSpec extends SkadisParams, SkadisState {}

export const DEFAULT_SKADIS_PARAMS: SkadisParams = {
  thickness: DEFAULT_THICKNESS,
  chamfer: true,
  bed: null,
  joint: "jigsaw",
  clearance: 0.15,
};

export function initialBoard(): SkadisState {
  return { cols: MIN_UNITS, rows: MIN_UNITS };
}

/** Nearest allowed count: odd, MIN_UNITS..MAX_UNITS. */
export function clampBoardUnits(n: number): number {
  const k = Math.round((Math.round(n) - MIN_UNITS) / UNIT_STEP);
  return Math.max(MIN_UNITS, Math.min(MAX_UNITS, MIN_UNITS + k * UNIT_STEP));
}

/** Overall size in mm — `MARGIN` past the outermost slot centre on every side. */
export function boardSizeMm(spec: SkadisSpec): { w: number; d: number; h: number } {
  return {
    w: LATTICE * (spec.cols - 1) + 2 * MARGIN,
    d: LATTICE * (spec.rows - 1) + 2 * MARGIN,
    h: spec.thickness,
  };
}

export function boardOutline(cols: number, rows: number): RRect {
  const w = LATTICE * (cols - 1) + 2 * MARGIN;
  const d = LATTICE * (rows - 1) + 2 * MARGIN;
  return { x0: 0, z0: 0, x1: w, z1: d, r: BOARD_R };
}

/** Centre of lattice position (c, r), whether or not it carries a slot. */
export function latticeCentre(c: number, r: number): { x: number; z: number } {
  return { x: MARGIN + LATTICE * c, z: MARGIN + LATTICE * r };
}

/** The checkerboard: corners empty, so the outer rows and columns are the sparse ones. */
export function hasSlot(c: number, r: number): boolean {
  return (c + r) % 2 !== 0;
}

export function slotCentres(cols: number, rows: number): { x: number; z: number; c: number; r: number }[] {
  const out: { x: number; z: number; c: number; r: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!hasSlot(c, r)) continue;
      const { x, z } = latticeCentre(c, r);
      out.push({ x, z, c, r });
    }
  }
  return out;
}

/**
 * One slot as a rounded rectangle — with r = half the width it is the drawing's
 * obround. `grow` widens it on every side, which is how the chamfered mouth is
 * built (grow = SLOT_CHAMFER at the face, 0 one chamfer deeper).
 */
export function slotRRect(x: number, z: number, grow = 0): RRect {
  return insetRRect({ x0: x - SLOT_W / 2, z0: z - SLOT_H / 2, x1: x + SLOT_W / 2, z1: z + SLOT_H / 2, r: SLOT_R }, -grow);
}

/**
 * The square of board a lattice position owns: the tiles pave the outline
 * inset by half a lattice step, which is exactly what the border band leaves.
 */
export function latticeTile(c: number, r: number): { x0: number; z0: number; x1: number; z1: number } {
  const { x, z } = latticeCentre(c, r);
  const h = LATTICE / 2;
  return { x0: x - h, z0: z - h, x1: x + h, z1: z + h };
}

/** The plain rectangle the tiles pave; the border band fills what is left. */
export function tileField(cols: number, rows: number): RRect {
  return insetRRect(boardOutline(cols, rows), MARGIN - LATTICE / 2);
}

/**
 * Re-outline the board to `frame`, given in the current board's lattice units —
 * so `c0 < 0` adds columns on the left, `c1 > cols` on the right. Mirrors
 * `grid.ts` `reframe`, minus the merges — there is nothing to carry across,
 * only the count. The
 * step of 2 keeps the slot parity fixed, so a left/top grow doesn't restripe
 * the board.
 */
export function reframeBoard(frame: Frame): SkadisState {
  return {
    cols: clampBoardUnits(frame.c1 - Math.round(frame.c0)),
    rows: clampBoardUnits(frame.r1 - Math.round(frame.r0)),
  };
}

// ---------------------------------------------------------------------------
// Splitting a board across several prints
// ---------------------------------------------------------------------------
//
// A big board only rejoins into a correct lattice if the cut lands exactly on a
// 20mm tile boundary — `MARGIN - LATTICE/2 + LATTICE·k`, which is the very unit
// boundary the resize handles already snap to. Each piece then keeps a 10mm
// margin at the seam against the usual 20mm at a real edge, so the pitch across
// the join is exact and no slot is ever bisected. (Halving a 15-column board
// gives 170 + 150, not 160 + 160: 160 is a slot centre column.)
//
// The joint rides the checkerboard. Across a seam the two facing tiles always
// have opposite parity, so at every row exactly one side has a slot — and the
// rule is that **the slotted tile grows the tooth, the empty tile opposite takes
// the notch**. That keeps the full 7.5mm of solid between a slot and the seam (a
// notch there would leave 2.5mm), and it means no tile ever carries a slot and a
// notch at once, which is what lets the mesher keep paving exactly one hole per
// tile. Ownership is purely local — `hasSlot` of the piece's own adjacent tile —
// so neighbours agree without consulting each other.

/** How a seam interlocks. Both are 2D prisms, so both print with no overhang. */
export type JointKind = "jigsaw" | "dovetail";

/** How far a tooth reaches into its neighbour. 5 leaves 7.5mm of solid to the slot. */
export const TOOTH_DEPTH = 5;
/**
 * Oval-headed tab, `dc + ax = TOOTH_DEPTH`: head 9 across, neck 5.6, undercut
 * 1.7 per side. The head is a full ellipse whose centre sits `dc` past the seam,
 * so the seam line cuts it at a chord narrower than the head — that chord is the
 * undercut, and it is why the CAD can fuse (or cut) the whole ellipse without
 * clipping: everything behind the seam is inside the plate already.
 */
export const JIGSAW = { ax: 2.8, az: 4.5, dc: TOOTH_DEPTH - 2.8 };
/** Straight-flanked dovetail: 7 wide at the seam, 11 at the tip. */
export const DOVETAIL = { root: 3.5, tip: 5.5 };
/** A trapezoid's flanks offset perpendicular to themselves, not sideways. */
export const DOVETAIL_FLANK = Math.hypot(TOOTH_DEPTH, DOVETAIL.tip - DOVETAIL.root) / TOOTH_DEPTH;
const TOOTH_SEGS = 20;

/**
 * One tooth as offsets from its centre on the seam line: `[out, along]`, where
 * `out` runs into the neighbouring piece and `along` runs down the seam,
 * ordered ascending. `grow` offsets it on every face, which is how the socket is
 * cut — the male tooth is nominal and the female socket is grown by the
 * clearance, so the fit is tuned from one number.
 */
export function toothProfile(joint: JointKind, grow = 0): Pair[] {
  if (joint === "dovetail") {
    const root = DOVETAIL.root + grow * DOVETAIL_FLANK;
    const tip = DOVETAIL.tip + grow * DOVETAIL_FLANK;
    const d = TOOTH_DEPTH + grow;
    return [
      [0, -root],
      [d, -tip],
      [d, tip],
      [0, root],
    ];
  }
  // The head is an ellipse whose centre sits `dc` past the seam, so the seam line
  // cuts it at a chord narrower than the head — that chord is the undercut.
  const ax = JIGSAW.ax + grow;
  const az = JIGSAW.az + grow;
  const t1 = Math.acos(-JIGSAW.dc / ax);
  return Array.from({ length: TOOTH_SEGS + 1 }, (_, i) => {
    const t = -t1 + (2 * t1 * i) / TOOTH_SEGS;
    return [JIGSAW.dc + ax * Math.cos(t), az * Math.sin(t)] as Pair;
  });
}

/** A neutral starting bed when splitting is switched on; most hobby printers clear it. */
export const DEFAULT_BED = { w: 220, d: 220 };

/** Where a board is cut, and how the seams interlock. Derived from the print bed. */
export interface SkadisSplit {
  /** Interior cuts in lattice units, ascending: a cut at `k` separates column `k-1` from `k`. */
  cutsC: number[];
  cutsR: number[];
  joint: JointKind;
  /** Gap between a tooth and its socket, per face. */
  clearance: number;
}

/** One printable piece: an inclusive lattice range plus which of its sides are cuts. */
export interface BoardPiece {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
  /** Position in the grid of pieces, for names and the exploded view. */
  ci: number;
  ri: number;
  seamX0: boolean;
  seamX1: boolean;
  seamZ0: boolean;
  seamZ1: boolean;
}

/** `count` lattice units in `groups` contiguous runs, as equal as they divide. */
function evenCuts(count: number, groups: number): number[] {
  const base = Math.floor(count / groups);
  const extra = count % groups;
  const cuts: number[] = [];
  let at = 0;
  for (let i = 0; i < groups - 1; i++) {
    at += base + (i < extra ? 1 : 0);
    cuts.push(at);
  }
  return cuts;
}

/** The pieces a set of cuts produces, in reading order. */
export function boardPieces(cols: number, rows: number, split: SkadisSplit): BoardPiece[] {
  const cs = [0, ...split.cutsC.filter((k) => k > 0 && k < cols), cols];
  const rs = [0, ...split.cutsR.filter((k) => k > 0 && k < rows), rows];
  const out: BoardPiece[] = [];
  for (let j = 0; j + 1 < rs.length; j++) {
    for (let i = 0; i + 1 < cs.length; i++) {
      out.push({
        c0: cs[i],
        c1: cs[i + 1] - 1,
        r0: rs[j],
        r1: rs[j + 1] - 1,
        ci: i,
        ri: j,
        seamX0: i > 0,
        seamX1: i + 2 < cs.length,
        seamZ0: j > 0,
        seamZ1: j + 2 < rs.length,
      });
    }
  }
  return out;
}

/** A piece's own outline extents: `MARGIN` past a real edge, `LATTICE/2` past a seam. */
export function pieceBounds(p: BoardPiece): { x0: number; z0: number; x1: number; z1: number } {
  const a = latticeCentre(p.c0, p.r0);
  const b = latticeCentre(p.c1, p.r1);
  const m = (seam: boolean) => (seam ? LATTICE / 2 : MARGIN);
  return {
    x0: a.x - m(p.seamX0),
    z0: a.z - m(p.seamZ0),
    x1: b.x + m(p.seamX1),
    z1: b.z + m(p.seamZ1),
  };
}

export function pieceSizeMm(p: BoardPiece): { w: number; d: number } {
  const b = pieceBounds(p);
  return { w: b.x1 - b.x0, d: b.z1 - b.z0 };
}

/**
 * What the piece actually occupies on the print bed: its outline plus the teeth,
 * which reach `TOOTH_DEPTH` past every seam edge. This — not `pieceSizeMm` — is
 * what the bed has to clear, and what a slicer will report.
 */
export function pieceFootprintMm(p: BoardPiece): { w: number; d: number } {
  const s = pieceSizeMm(p);
  return {
    w: s.w + (p.seamX0 ? TOOTH_DEPTH : 0) + (p.seamX1 ? TOOTH_DEPTH : 0),
    d: s.d + (p.seamZ0 ? TOOTH_DEPTH : 0) + (p.seamZ1 ? TOOTH_DEPTH : 0),
  };
}

/** The 20mm tiles a piece owns — always its lattice range grown by half a step. */
export function pieceTileField(p: BoardPiece): RRect {
  const a = latticeCentre(p.c0, p.r0);
  const b = latticeCentre(p.c1, p.r1);
  const h = LATTICE / 2;
  return { x0: a.x - h, z0: a.z - h, x1: b.x + h, z1: b.z + h, r: 0 };
}

const fits = (w: number, d: number, bed: { w: number; d: number }) =>
  (w <= bed.w && d <= bed.d) || (w <= bed.d && d <= bed.w);

/**
 * The bed extent of each run when `count` lattice units are cut into `groups`: a
 * run spans `20·n`, plus another 10 where it ends on a real edge and
 * `TOOTH_DEPTH` where it ends on a seam, because the teeth stand proud of the
 * outline. Per axis only, because a piece's width depends on the column grouping
 * alone — which is what keeps the search below cheap.
 */
function runExtents(count: number, groups: number): number[] {
  const base = Math.floor(count / groups);
  const extra = count % groups;
  const end = (edge: boolean) => (edge ? MARGIN - LATTICE / 2 : TOOTH_DEPTH);
  return Array.from({ length: groups }, (_, i) => {
    const n = base + (i < extra ? 1 : 0);
    return LATTICE * n + end(i === 0) + end(i === groups - 1);
  });
}

/**
 * Fewest pieces that fit the bed, cut on lattice boundaries and as equal as the
 * lattice allows; each piece may be rotated onto the plate. Returns no cuts when
 * the board already fits — or when even a single lattice tile doesn't, which the
 * UI warns about rather than silently producing an unprintable plan.
 */
export function planSplit(
  cols: number,
  rows: number,
  bed: { w: number; d: number },
): { cutsC: number[]; cutsR: number[] } {
  let best: { m: number; n: number } | null = null;
  for (let m = 1; m <= cols; m++) {
    const ws = runExtents(cols, m);
    for (let n = 1; n <= rows; n++) {
      if (best && m * n >= best.m * best.n) continue;
      const ds = runExtents(rows, n);
      if (ws.every((w) => ds.every((d) => fits(w, d, bed)))) best = { m, n };
    }
  }
  return best
    ? { cutsC: evenCuts(cols, best.m), cutsR: evenCuts(rows, best.n) }
    : { cutsC: [], cutsR: [] };
}

/** The split a spec implies: derived from the print bed, so the bed stays the only state. */
export function boardSplit(spec: SkadisSpec): SkadisSplit {
  const base = { joint: spec.joint, clearance: spec.clearance };
  if (!spec.bed) return { cutsC: [], cutsR: [], ...base };
  return { ...planSplit(spec.cols, spec.rows, spec.bed), ...base };
}

/** A piece's outline, plus the vertices that carry a real vertical edge line. */
export interface PieceOutline extends Outline {
  /** Point indices where the wall has a hard edge: arc tangents, square corners, tooth corners. */
  verts: number[];
}

const range = (a: number, b: number) =>
  a <= b
    ? Array.from({ length: b - a + 1 }, (_, i) => a + i)
    : Array.from({ length: a - b + 1 }, (_, i) => a - i);

/** Which of a tile's four sides lie on one of its piece's seams. */
export function tileSeams(p: BoardPiece, c: number, r: number) {
  return {
    x0: p.seamX0 && c === p.c0,
    x1: p.seamX1 && c === p.c1,
    z0: p.seamZ0 && r === p.r0,
    z1: p.seamZ1 && r === p.r1,
  };
}

export type SeamSide = "x0" | "x1" | "z0" | "z1";

/**
 * Where a tooth profile point lands in plan: `out` runs outward from the piece
 * and `along` down the seam, in the direction `pieceOutline` walks that side.
 * One mapping shared by the outline, the sockets and the tooth faces, so the
 * wall and the cap it closes are built from identical floats.
 */
export function seamPlace(
  p: BoardPiece,
  side: SeamSide,
  c: number,
  r: number,
): (out: number, along: number) => Pair {
  const b = pieceBounds(p);
  const { x, z } = latticeCentre(c, r);
  if (side === "x1") return (out, a) => [b.x1 + out, z + a];
  if (side === "z1") return (out, a) => [x - a, b.z1 + out];
  if (side === "x0") return (out, a) => [b.x0 - out, z - a];
  return (out, a) => [x + a, b.z0 - out];
}

/** The plan polygon of the tooth tile `(c, r)` grows on `side` — a closed ring. */
export function toothPolygon(
  p: BoardPiece,
  split: SkadisSplit,
  side: SeamSide,
  c: number,
  r: number,
): Pair[] {
  const place = seamPlace(p, side, c, r);
  const ring = toothProfile(split.joint, 0).map(([out, a]) => place(out, a));
  return [...ring, ring[0]];
}

/**
 * A piece's plan outline, walked in `sampleRRect`'s order — right side +z,
 * bottom −x, left −z, top +x — so `outward()` gives the true outward normal even
 * where a tooth or socket makes the outline non-convex, and the loft and edge
 * helpers behave exactly as they do for a whole board.
 *
 * Corners are R8 only where two real edges meet; a seam corner is square. Pass
 * `withTeeth = false` for the plain outline the border band strips against.
 */
export function pieceOutline(
  p: BoardPiece,
  split: SkadisSplit,
  arcSegs: number,
  withTeeth = true,
): PieceOutline {
  const b = pieceBounds(p);
  const pts: Pair[] = [];
  const tangents: number[] = [];
  const verts: number[] = [];
  const corner = (real: boolean, at: Pair, centre: Pair, a0: number) => {
    if (!real) {
      tangents.push(pts.length, pts.length);
      verts.push(pts.length);
      pts.push(at);
      return;
    }
    tangents.push(pts.length);
    verts.push(pts.length);
    for (let i = 0; i <= arcSegs; i++) {
      const a = a0 + (Math.PI / 2) * (i / (arcSegs || 1));
      pts.push([centre[0] + BOARD_R * Math.cos(a), centre[1] + BOARD_R * Math.sin(a)]);
    }
    tangents.push(pts.length - 1);
    verts.push(pts.length - 1);
  };

  const side = (seamSide: SeamSide, seam: boolean, items: number[]) => {
    if (!seam || !withTeeth) return;
    for (const i of items) {
      const [c, r] = seamSide === "x0" || seamSide === "x1" ? [horiz(seamSide), i] : [i, vert(seamSide)];
      // Local rule: this piece grows the tooth exactly where its own tile has the
      // slot; the neighbour's tile has the opposite parity, so the two agree.
      const own = hasSlot(c, r);
      const place = seamPlace(p, seamSide, c, r);
      const first = pts.length;
      for (const [out, along] of toothProfile(split.joint, own ? 0 : split.clearance)) {
        pts.push(place((own ? 1 : -1) * out, along));
      }
      verts.push(first, pts.length - 1);
      if (split.joint === "dovetail") verts.push(first + 1, first + 2);
    }
  };
  const horiz = (s: SeamSide) => (s === "x0" ? p.c0 : p.c1);
  const vert = (s: SeamSide) => (s === "z0" ? p.r0 : p.r1);

  const R = BOARD_R;
  corner(!p.seamX1 && !p.seamZ0, [b.x1, b.z0], [b.x1 - R, b.z0 + R], -Math.PI / 2);
  side("x1", p.seamX1, range(p.r0, p.r1));
  corner(!p.seamX1 && !p.seamZ1, [b.x1, b.z1], [b.x1 - R, b.z1 - R], 0);
  side("z1", p.seamZ1, range(p.c1, p.c0));
  corner(!p.seamX0 && !p.seamZ1, [b.x0, b.z1], [b.x0 + R, b.z1 - R], Math.PI / 2);
  side("x0", p.seamX0, range(p.r1, p.r0));
  corner(!p.seamX0 && !p.seamZ0, [b.x0, b.z0], [b.x0 + R, b.z0 + R], Math.PI);
  side("z0", p.seamZ0, range(p.c0, p.c1));

  return { pts, tangents, verts: [...new Set(verts)], bbox: [b.x0, b.z0, b.x1, b.z1] };
}

/**
 * A tile's plan boundary, walked in the same order as `pieceOutline`. A tile on
 * a seam is notched wherever the neighbour owns the tooth — which, by the parity
 * rule, is only ever an empty tile, so a slotted tile is always the plain square
 * the annulus paving expects.
 */
export function tilePolygon(p: BoardPiece, split: SkadisSplit, c: number, r: number): Pair[] {
  const t = latticeTile(c, r);
  const seam = tileSeams(p, c, r);
  const notch = hasSlot(c, r) ? null : toothProfile(split.joint, split.clearance);
  const pts: Pair[] = [];
  const cut = (on: boolean, side: SeamSide) => {
    if (!on || !notch) return;
    const place = seamPlace(p, side, c, r);
    for (const [out, along] of notch) pts.push(place(-out, along));
  };
  pts.push([t.x1, t.z0]);
  cut(seam.x1, "x1");
  pts.push([t.x1, t.z1]);
  cut(seam.z1, "z1");
  pts.push([t.x0, t.z1]);
  cut(seam.x0, "x0");
  pts.push([t.x0, t.z0]);
  cut(seam.z0, "z0");
  return pts;
}

/** Does this tile's boundary differ from its plain 20mm square? */
export function tileIsNotched(p: BoardPiece, c: number, r: number): boolean {
  if (hasSlot(c, r)) return false;
  const s = tileSeams(p, c, r);
  return s.x0 || s.x1 || s.z0 || s.z1;
}
