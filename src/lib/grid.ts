import type { Region } from "./protocol";

export const MAX_UNITS = 12;

/**
 * Grid editor state. `merges` only holds regions bigger than one cell;
 * every cell not covered by a merge is implicitly its own 1x1 compartment.
 * Merges never overlap and are always rectangular.
 */
export interface GridState {
  cols: number;
  rows: number;
  merges: Region[];
}

export function initialGrid(): GridState {
  return { cols: 1, rows: 1, merges: [] };
}

export function clampUnits(n: number): number {
  return Math.max(1, Math.min(MAX_UNITS, Math.round(n)));
}

function intersects(a: Region, b: Region): boolean {
  return a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;
}

function contains(outer: Region, inner: Region): boolean {
  return (
    outer.r0 <= inner.r0 && outer.c0 <= inner.c0 && outer.r1 >= inner.r1 && outer.c1 >= inner.c1
  );
}

export function regionArea(r: Region): number {
  return (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
}

/** The merge covering a cell, or the cell itself as a 1×1 region. */
export function regionAt(state: GridState, r: number, c: number): Region {
  for (const m of state.merges) {
    if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m;
  }
  return { r0: r, c0: c, r1: r, c1: c };
}

export function boundingRect(a: Region, b: Region): Region {
  return {
    r0: Math.min(a.r0, b.r0),
    c0: Math.min(a.c0, b.c0),
    r1: Math.max(a.r1, b.r1),
    c1: Math.max(a.c1, b.c1),
  };
}

/** More than one cell selected and not already exactly one merge. */
export function canFuseSelection(state: GridState, sel: Region): boolean {
  return (
    regionArea(sel) > 1 &&
    !state.merges.some(
      (m) => m.r0 === sel.r0 && m.c0 === sel.c0 && m.r1 === sel.r1 && m.c1 === sel.c1,
    )
  );
}

export function canSplitSelection(state: GridState, sel: Region): boolean {
  return state.merges.some((m) => intersects(m, sel));
}

export function normalizeRect(r0: number, c0: number, r1: number, c1: number): Region {
  return {
    r0: Math.min(r0, r1),
    c0: Math.min(c0, c1),
    r1: Math.max(r0, r1),
    c1: Math.max(c0, c1),
  };
}

/** Grow a selection rectangle until it fully covers every merge it touches (spreadsheet behavior). */
export function expandSelection(state: GridState, rect: Region): Region {
  let cur = rect;
  for (;;) {
    let grown = cur;
    for (const m of state.merges) {
      if (intersects(grown, m)) {
        grown = {
          r0: Math.min(grown.r0, m.r0),
          c0: Math.min(grown.c0, m.c0),
          r1: Math.max(grown.r1, m.r1),
          c1: Math.max(grown.c1, m.c1),
        };
      }
    }
    if (
      grown.r0 === cur.r0 &&
      grown.c0 === cur.c0 &&
      grown.r1 === cur.r1 &&
      grown.c1 === cur.c1
    ) {
      return grown;
    }
    cur = grown;
  }
}

export function fuse(state: GridState, selection: Region): GridState {
  const rect = expandSelection(state, selection);
  if (regionArea(rect) < 2) return state;
  const merges = state.merges.filter((m) => !contains(rect, m));
  return { ...state, merges: [...merges, rect] };
}

export function split(state: GridState, selection: Region): GridState {
  return { ...state, merges: state.merges.filter((m) => !intersects(m, selection)) };
}

/** Resize the grid, clipping merges that cross the new bounds. */
export function resize(state: GridState, cols: number, rows: number): GridState {
  const c = clampUnits(cols);
  const r = clampUnits(rows);
  const merges = state.merges
    .filter((m) => m.c0 < c && m.r0 < r)
    .map((m) => ({ ...m, c1: Math.min(m.c1, c - 1), r1: Math.min(m.r1, r - 1) }))
    .filter((m) => regionArea(m) > 1);
  return { cols: c, rows: r, merges };
}

/** All compartments (merges + implicit 1x1 cells) in row-major order. */
export function allRegions(state: GridState): Region[] {
  const covered: boolean[] = new Array(state.rows * state.cols).fill(false);
  for (const m of state.merges) {
    for (let r = m.r0; r <= m.r1; r++) {
      for (let c = m.c0; c <= m.c1; c++) covered[r * state.cols + c] = true;
    }
  }
  const regions: Region[] = [];
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (!covered[r * state.cols + c]) regions.push({ r0: r, c0: c, r1: r, c1: c });
    }
  }
  regions.push(...state.merges);
  regions.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
  return regions;
}

/** A, B, ... Z, AA, AB ... */
export function regionLabel(index: number): string {
  let label = "";
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
