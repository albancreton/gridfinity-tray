// Procedural preview mesher for a SKÅDIS board — the board's answer to
// lib/trayMesher.ts, and much smaller: a flat panel has no height field and no
// booleans to resolve. Everything here is analytic, because the board's faces
// pave a regular lattice:
//
//   · the outline inset by half a lattice step is exactly the union of the
//     lattice tiles, so the rounded border is one annulus and the interior is
//     one 20mm tile per lattice position
//   · a tile is a quad when it has no slot, and an annulus around the slot when
//     it does — the slot always fits inside its tile, chamfer included
//   · slot walls and the board's own edge are lofts between rings sampled by
//     the one `sampleRRect`, so the rings pair up index by index
//
// Tile seams are joins inside a flat face, so they carry no edge line; the B-rep
// edges are the board outline, each slot mouth, the chamfer rings and the
// tangent seams where a straight side meets a corner arc.
//
// Output frame is the viewer's world: x along columns, y up (mm above the bed),
// z along rows, the board's top-left corner at the origin.

import {
  DOWN,
  EPS,
  Sink,
  UP,
  lift,
  loft,
  ringStrip,
  sampleRRect,
  type MeshSoup,
  type Outline,
  type Pair,
} from "./meshKit";
import {
  SLOT_CHAMFER,
  boardOutline,
  hasSlot,
  latticeCentre,
  latticeTile,
  slotRRect,
  tileField,
  type SkadisSpec,
} from "./skadis";

export interface BoardGeometry extends MeshSoup {
  cols: number;
  rows: number;
  /** Top face height in mm — the board's `topZ`, for whatever the viewer hangs off it. */
  topZ: number;
}

const BOARD_SEGS = 8; // per quarter arc on the board outline (R8)
const SLOT_SEGS = 6; // per quarter arc on a slot (R2.5 — a much smaller arc)

/**
 * Tangent indices that carry a real vertical seam: where a straight side of
 * non-zero length meets a corner arc. A slot is an obround, so its short sides
 * are degenerate — the two arcs there continue each other smoothly and a seam
 * would be a line drawn across a flat face.
 */
function seams(o: Outline): number[] {
  const idx: number[] = [];
  const n = o.tangents.length;
  for (let k = 0; k < n / 2; k++) {
    const end = o.tangents[2 * k + 1];
    const start = o.tangents[(2 * k + 2) % n];
    const a = o.pts[end];
    const b = o.pts[start];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > EPS) idx.push(end, start);
  }
  return idx;
}

export function buildBoardGeometry(spec: SkadisSpec): BoardGeometry {
  const { cols, rows } = spec;
  const h = Math.max(spec.thickness, 0.4);
  // The chamfer can never eat more than half the panel, however thin it gets.
  const ch = spec.chamfer ? Math.min(SLOT_CHAMFER, h / 2 - 0.01) : 0;
  const out = new Sink();

  const outline = boardOutline(cols, rows);
  const outerO = sampleRRect(outline, BOARD_SEGS);
  const centre: Pair = [(outline.x0 + outline.x1) / 2, (outline.z0 + outline.z1) / 2];

  // Border band: between the rounded outline and the plain rectangle the tiles
  // pave. `tileField` is the outline inset by half a lattice step, whose corner
  // radius has gone to zero — so four points describe it exactly.
  const fieldO = sampleRRect(tileField(cols, rows), 0);
  ringStrip(fieldO, outerO.pts, h, UP, out);
  ringStrip(fieldO, outerO.pts, 0, DOWN, out);

  // Board edge, its two face outlines and the tangent seams down the corners.
  loft(outerO, 0, outerO, h, centre, out);
  out.ringLines(outerO, 0);
  out.ringLines(outerO, h);
  for (const t of seams(outerO)) out.line(lift(outerO.pts[t], 0), lift(outerO.pts[t], h));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = latticeTile(c, r);
      const corners: Pair[] = [
        [t.x0, t.z0],
        [t.x1, t.z0],
        [t.x1, t.z1],
        [t.x0, t.z1],
      ];
      if (!hasSlot(c, r)) {
        out.quad(lift(corners[0], h), lift(corners[1], h), lift(corners[2], h), lift(corners[3], h), UP);
        out.quad(lift(corners[0], 0), lift(corners[1], 0), lift(corners[2], 0), lift(corners[3], 0), DOWN);
        continue;
      }

      const { x, z } = latticeCentre(c, r);
      const sc: Pair = [x, z];
      // The mouth is what shows on a face: the bore grown by the chamfer.
      const mouth = sampleRRect(slotRRect(x, z, ch), SLOT_SEGS);
      ringStrip(mouth, corners, h, UP, out);
      ringStrip(mouth, corners, 0, DOWN, out);
      out.ringLines(mouth, h);
      out.ringLines(mouth, 0);

      if (ch > 0) {
        const bore = sampleRRect(slotRRect(x, z, 0), SLOT_SEGS);
        loft(mouth, h, bore, h - ch, sc, out, true);
        loft(bore, h - ch, bore, ch, sc, out, true);
        loft(bore, ch, mouth, 0, sc, out, true);
        out.ringLines(bore, h - ch);
        out.ringLines(bore, ch);
        for (const i of seams(bore)) {
          const p = bore.pts[i];
          const m = mouth.pts[i];
          out.line(lift(m, h), lift(p, h - ch));
          out.line(lift(p, h - ch), lift(p, ch));
          out.line(lift(p, ch), lift(m, 0));
        }
      } else {
        loft(mouth, h, mouth, 0, sc, out, true);
        for (const i of seams(mouth)) out.line(lift(mouth.pts[i], 0), lift(mouth.pts[i], h));
      }
    }
  }

  return {
    positions: out.pos.result(),
    normals: out.nrm.result(),
    edges: out.lines.result(),
    cols,
    rows,
    topZ: h,
  };
}

if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  // Dev hook: time the mesher or compare it with `__cad.requestMesh` from the console.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__buildBoard = buildBoardGeometry;
}
