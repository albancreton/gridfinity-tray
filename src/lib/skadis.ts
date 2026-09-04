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
import { insetRRect, type RRect } from "./meshKit";

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
