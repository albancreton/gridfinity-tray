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
// A split board meshes as one piece per print (`boardPieces`), all in the same
// board coordinates so the printed-look shader and the ghost read across the
// seams. Splitting costs the paving almost nothing, because the joint rides the
// checkerboard: the tooth always grows from the tile that has the slot, so a
// notched tile is always an empty one. Slotted tiles keep the annulus paving
// untouched, empty notched tiles fall back to earcut, and each tooth is one
// extra prism outside the tile field. See lib/skadis.ts for the rule.
//
// Tile seams are joins inside a flat face, so they carry no edge line; the B-rep
// edges are the piece outline, each slot mouth, the chamfer rings and the
// tangent seams where a straight side meets a corner arc.
//
// Output frame is the viewer's world: x along columns, y up (mm above the bed),
// z along rows, the board's top-left corner at the origin.

import {
  DOWN,
  EPS,
  Sink,
  UP,
  fillPolygon,
  lift,
  loft,
  normalizePolygon,
  ringStrip,
  sampleRRect,
  wallLoft,
  type MeshSoup,
  type Outline,
  type Pair,
} from "./meshKit";
import {
  SLOT_CHAMFER,
  boardPieces,
  boardSplit,
  hasSlot,
  latticeCentre,
  latticeTile,
  pieceOutline,
  pieceSizeMm,
  pieceTileField,
  slotRRect,
  tileIsNotched,
  tilePolygon,
  tileSeams,
  toothPolygon,
  type BoardPiece,
  type SeamSide,
  type SkadisSpec,
  type SkadisSplit,
} from "./skadis";

/** One printable piece, meshed in board coordinates. */
export interface PieceGeometry extends MeshSoup {
  piece: BoardPiece;
  /** Footprint in mm — what the export names and the size readout quote. */
  size: { w: number; d: number };
}

export interface BoardGeometry {
  cols: number;
  rows: number;
  /** Top face height in mm — the board's `topZ`, for whatever the viewer hangs off it. */
  topZ: number;
  /** One entry when the board prints whole; `boardPieces` order otherwise. */
  pieces: PieceGeometry[];
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

/** The seam sides a tile sits on — where it grows a tooth, or takes a notch. */
function seamSides(p: BoardPiece, c: number, r: number): SeamSide[] {
  const s = tileSeams(p, c, r);
  const out: SeamSide[] = [];
  if (s.x1) out.push("x1");
  if (s.z1) out.push("z1");
  if (s.x0) out.push("x0");
  if (s.z0) out.push("z0");
  return out;
}

/** Both faces of one flat plan polygon. */
function cap(ring: Pair[], h: number, out: Sink) {
  const poly = normalizePolygon([ring]);
  fillPolygon(poly, () => h, UP, out);
  fillPolygon(poly, () => 0, DOWN, out);
}

function buildPiece(p: BoardPiece, split: SkadisSplit, h: number, ch: number): PieceGeometry {
  const out = new Sink();
  const outline = pieceOutline(p, split, BOARD_SEGS);

  // Border band: the 10mm of plate between the outermost tiles and a real edge.
  // A seam edge sits on the tile field itself, so the band is zero-width there —
  // strip against the tooth-less outline and those quads collapse away.
  if (!p.seamX0 || !p.seamX1 || !p.seamZ0 || !p.seamZ1) {
    const field = sampleRRect(pieceTileField(p), 0);
    const band = pieceOutline(p, split, BOARD_SEGS, false);
    ringStrip(field, band.pts, h, UP, out);
    ringStrip(field, band.pts, 0, DOWN, out);
  }

  // The piece's own wall. `loft` takes its normals from a centre point, which a
  // seam's teeth and sockets make wrong, so every segment carries its own.
  wallLoft(outline, 0, h, out);
  out.ringLines(outline, 0);
  out.ringLines(outline, h);
  for (const i of outline.verts) out.line(lift(outline.pts[i], 0), lift(outline.pts[i], h));

  for (let r = p.r0; r <= p.r1; r++) {
    for (let c = p.c0; c <= p.c1; c++) {
      const sides = seamSides(p, c, r);
      if (!hasSlot(c, r)) {
        if (tileIsNotched(p, c, r)) {
          const ring = tilePolygon(p, split, c, r);
          cap([...ring, ring[0]], h, out);
        } else {
          const t = latticeTile(c, r);
          const q: Pair[] = [
            [t.x0, t.z0],
            [t.x1, t.z0],
            [t.x1, t.z1],
            [t.x0, t.z1],
          ];
          out.quad(lift(q[0], h), lift(q[1], h), lift(q[2], h), lift(q[3], h), UP);
          out.quad(lift(q[0], 0), lift(q[1], 0), lift(q[2], 0), lift(q[3], 0), DOWN);
        }
        continue;
      }

      // A slotted tile is always the plain square, whatever the seams around it
      // do — the parity rule hands it teeth, never notches.
      const t = latticeTile(c, r);
      const corners: Pair[] = [
        [t.x0, t.z0],
        [t.x1, t.z0],
        [t.x1, t.z1],
        [t.x0, t.z1],
      ];
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
          const pt = bore.pts[i];
          const m = mouth.pts[i];
          out.line(lift(m, h), lift(pt, h - ch));
          out.line(lift(pt, h - ch), lift(pt, ch));
          out.line(lift(pt, ch), lift(m, 0));
        }
      } else {
        loft(mouth, h, mouth, 0, sc, out, true);
        for (const i of seams(mouth)) out.line(lift(mouth.pts[i], 0), lift(mouth.pts[i], h));
      }

      // Its teeth: prisms outside the tile field, so the paving above is untouched.
      for (const side of sides) cap(toothPolygon(p, split, side, c, r), h, out);
    }
  }

  return {
    positions: out.pos.result(),
    normals: out.nrm.result(),
    edges: out.lines.result(),
    piece: p,
    size: pieceSizeMm(p),
  };
}

export function buildBoardGeometry(spec: SkadisSpec): BoardGeometry {
  const h = Math.max(spec.thickness, 0.4);
  // The chamfer can never eat more than half the panel, however thin it gets.
  const ch = spec.chamfer ? Math.min(SLOT_CHAMFER, h / 2 - 0.01) : 0;
  const split = boardSplit(spec);
  return {
    cols: spec.cols,
    rows: spec.rows,
    topZ: h,
    pieces: boardPieces(spec.cols, spec.rows, split).map((p) => buildPiece(p, split, h, ch)),
  };
}

if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  // Dev hook: time the mesher or compare it with `__cad.requestMesh` from the console.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__buildBoard = buildBoardGeometry;
}
