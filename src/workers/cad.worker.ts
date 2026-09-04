import initOpenCascade from "replicad-opencascadejs";
import {
  setOC,
  drawCircle,
  drawRectangle,
  drawRoundedRectangle,
  makeCompound,
  sketchRoundedRectangle,
  makeCylinder,
  type Shape3D,
  type Sketch,
} from "replicad";
import { PITCH, BASE_H, type TraySpec } from "../lib/protocol";
import type { WorkerRequest, WorkerResponse } from "../lib/workerProtocol";
import {
  BOARD_R,
  SLOT_CHAMFER,
  SLOT_H,
  SLOT_R,
  SLOT_W,
  boardSizeMm,
  slotCentres,
  type SkadisSpec,
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
export function buildBoard(spec: SkadisSpec): Shape3D {
  const { w, d, h } = boardSizeMm(spec);
  const plate = (
    drawRoundedRectangle(w, d, BOARD_R).translate(w / 2, d / 2).sketchOnPlane("XY") as Sketch
  ).extrude(h) as Shape3D;

  const e = 0.01; // overshoot past each face, so the cut leaves no skin
  const c = spec.chamfer ? Math.min(SLOT_CHAMFER, h / 2 - e) : 0;
  const bore = slotDrawing(0);
  const mouth = c > 0 ? slotDrawing(c + e) : bore;

  const tools = slotCentres(spec.cols, spec.rows).map((s) => {
    const at = (dr: typeof bore, z: number) =>
      dr.translate(s.x, d - s.z).sketchOnPlane("XY", z) as Sketch;
    if (c === 0) return at(bore, -e).extrude(h + 2 * e) as Shape3D;
    return at(mouth, -e).loftWith([at(bore, c), at(bore, h - c), at(mouth, h + e)], {
      ruled: true,
    }) as Shape3D;
  });
  return tools.length > 0 ? plate.cut(makeCompound(tools) as Shape3D) : plate;
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    await init();
    const tray = req.model === "skadis" ? buildBoard(req.spec) : buildTray(req.spec);
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
