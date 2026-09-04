// How a model's unit grid maps to world millimetres — the adapter that lets
// one set of resize handles (components/viewer/handles.tsx) drive both the
// gridfinity tray and the SKÅDIS board. Pure data and arithmetic, no React.

/**
 * How a model's unit grid maps to world millimetres.
 *
 * A footprint is a `Frame` in unit coordinates, end-exclusive, and the shape on
 * screen always spans `0..cols × 0..rows`. Unit boundary `u` sits at
 * `origin + pitch·u`; the shape's own edge is `pad` beyond the outermost one —
 * zero for the tray, half a lattice step for the board, whose outline reaches
 * 20mm past its outermost slot centre.
 */
export interface GridMetrics {
  /** mm between unit boundaries (tray 42, board 20). */
  pitch: number;
  /** World coord of the boundary before unit 0 (tray 0, board 10). */
  origin: number;
  /** mm the shape overhangs its outermost unit boundary (tray 0, board 10). */
  pad: number;
  /** Allowed unit counts: `min`, `min + step`, … up to `max`. */
  min: number;
  max: number;
  step: number;
}

/** World coord of the unit boundary before unit `u`. */
export const at = (m: GridMetrics, u: number) => m.origin + m.pitch * u;
/** World coord of the shape's low edge when its footprint starts at `u`. */
export const lo = (m: GridMetrics, u: number) => at(m, u) - m.pad;
/** World coord of the shape's high edge when its footprint ends at `u`. */
export const hi = (m: GridMetrics, u: number) => at(m, u) + m.pad;
/** Nearest unit boundary to a world coord. */
export const unitAt = (m: GridMetrics, mm: number) => Math.round((mm - m.origin) / m.pitch);
/** Nearest allowed count. */
export function clampCount(m: GridMetrics, n: number): number {
  const k = Math.round((Math.round(n) - m.min) / m.step);
  return Math.max(m.min, Math.min(m.max, m.min + k * m.step));
}
