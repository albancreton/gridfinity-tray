// Shared types between the UI and the CAD worker.

// --- Gridfinity spec constants (mm), shared so the UI can derive sizes
// without asking the worker ---
export const PITCH = 42;
export const CLEAR = 0.25; // gap to the 42mm grid on each side
export const BASE_H = 4.75; // gridfinity base foot section
export const LIP_H = 4.4; // stacking lip added above the nominal height
export const R_OUT = 3.75; // outer corner radius of the tray outline

/** Inclusive cell-coordinate rectangle: rows r0..r1, cols c0..c1. */
export interface Region {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface TrayParams {
  /** Total height in mm, from the bottom of the feet to the top of the wall (stacking lip excluded). */
  heightMm: number;
  /** Outer wall thickness in mm. Internal dividers use the same value. */
  wall: number;
  /** Floor thickness in mm, added on top of the 4.75mm gridfinity base section. */
  floor: number;
  /** Stacking lip on the top rim so another bin can stack on this tray. */
  lip: boolean;
  /** 6.5mm magnet pockets under each foot. */
  magnets: boolean;
}

export interface TraySpec extends TrayParams {
  cols: number;
  rows: number;
  /** Every compartment as a rectangle, covering the whole grid (1x1 cells included). */
  regions: Region[];
}

/** Overall bounding size of the tray in mm, matching the worker's geometry exactly. */
export function traySizeMm(spec: Pick<TraySpec, "cols" | "rows" | "heightMm" | "lip">): {
  w: number;
  d: number;
  h: number;
} {
  return {
    w: PITCH * spec.cols - 2 * CLEAR,
    d: PITCH * spec.rows - 2 * CLEAR,
    h: Math.max(spec.heightMm, BASE_H + 1) + (spec.lip ? LIP_H : 0),
  };
}

export interface MeshData {
  vertices: Float32Array;
  triangles: Uint32Array;
  /** Edge polylines, flat [x,y,z,x,y,z,...] pairs forming line segments. */
  edges: Float32Array;
}

export type WorkerRequest =
  | { id: number; type: "mesh"; spec: TraySpec }
  | { id: number; type: "stl" | "step"; spec: TraySpec };

export type WorkerResponse =
  | { id: number; ok: true; type: "mesh"; mesh: MeshData }
  | { id: number; ok: true; type: "stl" | "step"; file: ArrayBuffer }
  | { id: number; ok: false; error: string };
