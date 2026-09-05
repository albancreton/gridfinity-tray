import initOpenCascade from "replicad-opencascadejs";
import {
  setOC,
  draw,
  drawCircle,
  drawEllipse,
  drawRectangle,
  makeCompound,
  sketchRoundedRectangle,
  makeCylinder,
  type Drawing,
  type Shape3D,
  type Sketch,
} from "replicad";
import { PITCH, BASE_H, type TraySpec } from "../lib/protocol";
import type { WorkerRequest, WorkerResponse } from "../lib/workerProtocol";
import {
  BOARD_R,
  DOVETAIL,
  DOVETAIL_FLANK,
  JIGSAW,
  SLOT_CHAMFER,
  SLOT_H,
  SLOT_R,
  SLOT_W,
  TOOTH_DEPTH,
  boardPieces,
  boardSizeMm,
  boardSplit,
  hasSlot,
  latticeCentre,
  pieceBounds,
  slotCentres,
  type BoardPiece,
  type JointKind,
  type SeamSide,
  type SkadisSpec,
  type SkadisSplit,
} from "../lib/skadis";
import {
  FOOT_RINGS,
  LIP_SOCKET,
  MAGNET_D,
  MAGNET_H,
  footRing,
  hasPockets,
  levels,
  lipRing,
  magnetCenters,
  outerOutline,
  pocketRect,
  type RRect,
} from "../lib/layout";

// Every dimension comes from lib/layout.ts, shared with the preview mesher.
// The worker's frame is OCC's: XY is the bed, Z is up, and plan z (rows, growing
// screen-down) maps to y = PITCH·rows − z so row 0 ends up at the highest y.

let ocReady: Promise<void> | null = null;
function init(): Promise<void> {
  if (!ocReady) {
    ocReady = initOpenCascade({
      // public/ is served from the base path, which is "" everywhere except on
      // GitHub Pages; NEXT_PUBLIC_* is inlined into this worker bundle at build time.
      locateFile: () => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/replicad_single.wasm`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).then((oc: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setOC(oc as any);
    });
  }
  return ocReady;
}

/** A plan rounded rectangle as a sketch at height z. */
function rectSketch(rr: RRect, rows: number, z: number): Sketch {
  const w = rr.x1 - rr.x0;
  const d = rr.z1 - rr.z0;
  const cx = (rr.x0 + rr.x1) / 2;
  const cy = PITCH * rows - (rr.z0 + rr.z1) / 2;
  return sketchRoundedRectangle(w, d, Math.max(0.01, rr.r), { plane: "XY", origin: [cx, cy, z] });
}

function fuseAll(shapes: Shape3D[]): Shape3D {
  let current = shapes;
  while (current.length > 1) {
    const next: Shape3D[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? current[i].fuse(current[i + 1]) : current[i]);
    }
    current = next;
  }
  return current[0];
}

/** One gridfinity foot under unit cell (c, r), z 0 -> BASE_H. */
function foot(c: number, r: number, rows: number): Shape3D {
  const [bottom, ...rest] = FOOT_RINGS;
  return rectSketch(footRing(c, r, bottom), rows, bottom.z).loftWith(
    rest.map((ring) => rectSketch(footRing(c, r, ring), rows, ring.z)),
    { ruled: true },
  );
}

export function buildTray(spec: TraySpec): Shape3D {
  const { cols, rows } = spec;
  const lv = levels(spec);
  const outer = outerOutline(cols, rows);

  // Body wall + one foot per unit cell (feet stay per-unit even under fused compartments)
  const parts: Shape3D[] = [rectSketch(outer, rows, BASE_H).extrude(lv.topZ - BASE_H)];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) parts.push(foot(c, r, rows));
  }
  let tray = fuseAll(parts);

  // Compartment pockets
  if (hasPockets(lv)) {
    const pockets: Shape3D[] = [];
    for (const reg of spec.regions) {
      const rr = pocketRect(spec, reg);
      if (!rr) continue;
      pockets.push(rectSketch(rr, rows, lv.floorZ).extrude(lv.topZ - lv.floorZ + 1));
    }
    if (pockets.length > 0) tray = tray.cut(fuseAll(pockets));
  }

  // Stacking lip: cut the socket loft into the top rim.
  if (spec.lip) {
    const [first, ...rest] = LIP_SOCKET;
    const socket = rectSketch(lipRing(outer, first), rows, lv.topZ + first.dz).loftWith(
      rest.map((ring) => rectSketch(lipRing(outer, ring), rows, lv.topZ + ring.dz)),
      { ruled: true },
    );
    tray = tray.cut(socket);
  }

  if (spec.magnets) {
    const holes: Shape3D[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (const m of magnetCenters(c, r)) {
          holes.push(
            makeCylinder(MAGNET_D / 2, MAGNET_H + 0.01, [m.x, PITCH * rows - m.z, -0.005]),
          );
        }
      }
    }
    tray = tray.cut(fuseAll(holes));
  }

  return tray;
}

/**
 * One slot as a 2D drawing centred on the origin, grown by `grow` on every side
 * (`grow = SLOT_CHAMFER` is the mouth, 0 the bore). `drawRoundedRectangle(5, 15,
 * 2.5)` can't express it — the short sides have zero length and the pen has no
 * preceding curve to run its tangent arc off — so build the obround from its
 * straight part plus the two end circles.
 */
function slotDrawing(grow: number) {
  const straight = SLOT_H - SLOT_W; // unchanged by the offset: both ends grow alike
  return drawRectangle(SLOT_W + 2 * grow, straight)
    .fuse(drawCircle(SLOT_R + grow).translate(0, straight / 2))
    .fuse(drawCircle(SLOT_R + grow).translate(0, -straight / 2));
}

/**
 * A SKÅDIS board: one extruded plate minus one cut tool per slot, the tool
 * lofted mouth → bore → bore → mouth so the 1mm chamfer comes out of the same
 * operation. The outermost rings sit a hair past each face at `c + e`, so the
 * 45° flank continues through the surface and the mouth is exactly `c` wide
 * there.
 *
 * The tools are cut as **one compound**, not fused first: they are disjoint, so
 * the fuse only costs time (measured on a 17×27 board, 229 slots — 5s with a
 * compound against 8.5s via `fuseAll`). Both beat chamfering the finished solid
 * with `.chamfer()` by a wide margin: that took 55s on the same board, because
 * OpenCASCADE prices chamfers per edge and there are four per slot.
 *
 * Same frame mapping as the tray: plan x → OCC x, plan z → OCC y = d − z.
 */
/**
 * One tooth as a 2D drawing pointing +x from the origin, `grow` bigger on every
 * face (that is the socket). Neither shape needs clipping to the seam line: the
 * part behind it is inside the plate, so fusing or cutting the whole thing lands
 * the same solid — and it keeps the arc exact instead of sampled.
 */
function toothDrawing(joint: JointKind, grow: number): Drawing {
  if (joint === "dovetail") {
    const root = DOVETAIL.root + grow * DOVETAIL_FLANK;
    const tip = DOVETAIL.tip + grow * DOVETAIL_FLANK;
    const d = TOOTH_DEPTH + grow;
    return draw([0, -root]).lineTo([d, -tip]).lineTo([d, tip]).lineTo([0, root]).close();
  }
  return drawEllipse(JIGSAW.ax + grow, JIGSAW.az + grow).translate(JIGSAW.dc, 0);
}

/** The sliver an R8 corner removes: the corner square minus its quarter disc. */
function cornerTool(sx: number, sy: number, ax: number, ay: number): Drawing {
  const r = BOARD_R;
  return drawRectangle(r, r)
    .translate(sx, sy)
    .cut(drawCircle(r).translate(ax, ay));
}

/**
 * A piece's plan outline as one 2D drawing in the worker's XY frame: the plain
 * rectangle, minus a corner sliver where two real edges meet (a seam corner
 * stays square), plus the teeth it owns and minus the sockets it doesn't. Doing
 * the joint in 2D and extruding once is far cheaper than 3D booleans, and the
 * ownership rule is local — `hasSlot` of the piece's own adjacent tile.
 */
function pieceDrawing(split: SkadisSplit, p: BoardPiece, d: number): Drawing {
  const b = pieceBounds(p);
  const y = (z: number) => d - z; // plan z -> OCC y
  const r = BOARD_R / 2;
  let dr = drawRectangle(b.x1 - b.x0, b.z1 - b.z0).translate(
    (b.x0 + b.x1) / 2,
    y((b.z0 + b.z1) / 2),
  );

  const round: [boolean, number, number, number, number][] = [
    [!p.seamX1 && !p.seamZ0, b.x1 - r, y(b.z0 + r), b.x1 - BOARD_R, y(b.z0 + BOARD_R)],
    [!p.seamX1 && !p.seamZ1, b.x1 - r, y(b.z1 - r), b.x1 - BOARD_R, y(b.z1 - BOARD_R)],
    [!p.seamX0 && !p.seamZ1, b.x0 + r, y(b.z1 - r), b.x0 + BOARD_R, y(b.z1 - BOARD_R)],
    [!p.seamX0 && !p.seamZ0, b.x0 + r, y(b.z0 + r), b.x0 + BOARD_R, y(b.z0 + BOARD_R)],
  ];
  for (const [real, sx, sy, ax, ay] of round) if (real) dr = dr.cut(cornerTool(sx, sy, ax, ay));

  // Outward direction of each seam, as an OCC rotation of the canonical +x tooth.
  const sides: [SeamSide, boolean, number, () => { c: number; r: number }[]][] = [
    ["x1", p.seamX1, 0, () => rows(p).map((r2) => ({ c: p.c1, r: r2 }))],
    ["x0", p.seamX0, 180, () => rows(p).map((r2) => ({ c: p.c0, r: r2 }))],
    ["z1", p.seamZ1, -90, () => cols(p).map((c2) => ({ c: c2, r: p.r1 }))],
    ["z0", p.seamZ0, 90, () => cols(p).map((c2) => ({ c: c2, r: p.r0 }))],
  ];
  for (const [side, on, angle, tiles] of sides) {
    if (!on) continue;
    for (const { c, r: rr } of tiles()) {
      const own = hasSlot(c, rr);
      const centre = latticeCentre(c, rr);
      const at: [number, number] =
        side === "x1"
          ? [b.x1, y(centre.z)]
          : side === "x0"
            ? [b.x0, y(centre.z)]
            : side === "z1"
              ? [centre.x, y(b.z1)]
              : [centre.x, y(b.z0)];
      // A tooth points out of the piece; a socket is the same profile pointing
      // back into it, which is the half-turn the mesher writes as `-out`.
      const tool = toothDrawing(split.joint, own ? 0 : split.clearance)
        .rotate(own ? angle : angle + 180)
        .translate(at[0], at[1]);
      dr = own ? dr.fuse(tool) : dr.cut(tool);
    }
  }
  return dr;
}

const rows = (p: BoardPiece) =>
  Array.from({ length: p.r1 - p.r0 + 1 }, (_, i) => p.r0 + i);
const cols = (p: BoardPiece) =>
  Array.from({ length: p.c1 - p.c0 + 1 }, (_, i) => p.c0 + i);

/**
 * A SKÅDIS board: one extruded plate per printable piece, minus one cut tool per
 * slot, the tool lofted mouth -> bore -> bore -> mouth so the 1mm chamfer comes
 * out of the same operation. The outermost rings sit a hair past each face at
 * `c + e`, so the 45 degree flank continues through the surface and the mouth is
 * exactly `c` wide there.
 *
 * The tools are cut as **one compound**, not fused first: they are disjoint, so
 * the fuse only costs time (measured on a 17x27 board, 229 slots — 5s with a
 * compound against 8.5s via `fuseAll`). Both beat chamfering the finished solid
 * with `.chamfer()` by a wide margin: that took 55s on the same board, because
 * OpenCASCADE prices chamfers per edge and there are four per slot.
 *
 * `which` selects one piece; without it every piece comes back as one compound,
 * which is what a STEP export wants. Pieces stay in the assembled frame, so a
 * multi-piece STEP opens as the board it builds.
 *
 * Same frame mapping as the tray: plan x -> OCC x, plan z -> OCC y = d - z.
 */
export function buildBoard(spec: SkadisSpec, which?: number): Shape3D {
  const { d, h } = boardSizeMm(spec);
  const split = boardSplit(spec);
  const all = boardPieces(spec.cols, spec.rows, split);
  const wanted = which === undefined ? all : [all[which]];

  const e = 0.01; // overshoot past each face, so the cut leaves no skin
  const c = spec.chamfer ? Math.min(SLOT_CHAMFER, h / 2 - e) : 0;
  const bore = slotDrawing(0);
  const mouth = c > 0 ? slotDrawing(c + e) : bore;

  const solids = wanted.map((p) => {
    const plate = (pieceDrawing(split, p, d).sketchOnPlane("XY") as Sketch).extrude(h) as Shape3D;
    const tools = slotCentres(spec.cols, spec.rows)
      .filter((s) => s.c >= p.c0 && s.c <= p.c1 && s.r >= p.r0 && s.r <= p.r1)
      .map((s) => {
        const at = (dr: typeof bore, z: number) =>
          dr.translate(s.x, d - s.z).sketchOnPlane("XY", z) as Sketch;
        if (c === 0) return at(bore, -e).extrude(h + 2 * e) as Shape3D;
        return at(mouth, -e).loftWith([at(bore, c), at(bore, h - c), at(mouth, h + e)], {
          ruled: true,
        }) as Shape3D;
      });
    return tools.length > 0 ? plate.cut(makeCompound(tools) as Shape3D) : plate;
  });
  return solids.length === 1 ? solids[0] : (makeCompound(solids) as Shape3D);
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    await init();
    const tray =
      req.model === "skadis" ? buildBoard(req.spec, req.piece) : buildTray(req.spec);
    if (req.type === "mesh") {
      const m = tray.mesh({ tolerance: 0.05, angularTolerance: 20 });
      const e = tray.meshEdges({ tolerance: 0.05, angularTolerance: 20 });
      return {
        id: req.id,
        ok: true,
        type: "mesh",
        mesh: {
          vertices: new Float32Array(m.vertices),
          triangles: new Uint32Array(m.triangles),
          edges: new Float32Array(e.lines),
        },
      };
    }
    const blob =
      req.type === "stl" ? tray.blobSTL({ tolerance: 0.02, binary: true }) : tray.blobSTEP();
    return { id: req.id, ok: true, type: req.type, file: await blob.arrayBuffer() };
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const res = await handle(event.data);
  const transfer: Transferable[] = [];
  if (res.ok && res.type === "mesh") {
    transfer.push(res.mesh.vertices.buffer, res.mesh.triangles.buffer, res.mesh.edges.buffer);
  } else if (res.ok) {
    transfer.push(res.file);
  }
  (self as unknown as Worker).postMessage(res, transfer);
};
