import initOpenCascade from "replicad-opencascadejs";
import {
  setOC,
  sketchRoundedRectangle,
  makeCylinder,
  type Shape3D,
  type Sketch,
} from "replicad";
import { PITCH, BASE_H, type TraySpec, type WorkerRequest, type WorkerResponse } from "../lib/protocol";
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

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    await init();
    const tray = buildTray(req.spec);
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
