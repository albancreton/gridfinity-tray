import initOpenCascade from "replicad-opencascadejs";
import {
  setOC,
  sketchRoundedRectangle,
  makeCylinder,
  type Shape3D,
  type Sketch,
} from "replicad";
import {
  PITCH,
  CLEAR,
  BASE_H,
  LIP_H,
  type TraySpec,
  type WorkerRequest,
  type WorkerResponse,
} from "../lib/protocol";

// --- Gridfinity spec constants (mm) ---
const R_OUT = 3.75; // outer corner radius
// Base foot profile, bottom to top: 0.8 chamfer, 1.8 straight, 2.15 chamfer (total BASE_H)
const FOOT_TOP = PITCH - 2 * CLEAR; // 41.5, per unit
const MAGNET_D = 6.5;
const MAGNET_H = 2.4;
const MAGNET_SPREAD = 13; // from foot center

let ocReady: Promise<void> | null = null;
function init(): Promise<void> {
  if (!ocReady) {
    ocReady = initOpenCascade({
      locateFile: () => "/replicad_single.wasm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).then((oc: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setOC(oc as any);
    });
  }
  return ocReady;
}

function rect(w: number, d: number, r: number, cx: number, cy: number, z: number): Sketch {
  return sketchRoundedRectangle(w, d, Math.max(0.01, r), { plane: "XY", origin: [cx, cy, z] });
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

/** One gridfinity foot under a unit cell, z 0 -> BASE_H. */
function foot(cx: number, cy: number): Shape3D {
  const bottom = rect(FOOT_TOP - 5.9, FOOT_TOP - 5.9, 0.8, cx, cy, 0);
  return bottom.loftWith(
    [
      rect(FOOT_TOP - 4.3, FOOT_TOP - 4.3, 1.6, cx, cy, 0.8),
      rect(FOOT_TOP - 4.3, FOOT_TOP - 4.3, 1.6, cx, cy, 2.6),
      rect(FOOT_TOP, FOOT_TOP, R_OUT, cx, cy, BASE_H),
    ],
    { ruled: true },
  );
}

export function buildTray(spec: TraySpec): Shape3D {
  const { cols, rows, wall } = spec;
  const W = PITCH * cols - 2 * CLEAR;
  const D = PITCH * rows - 2 * CLEAR;
  const cx = (PITCH * cols) / 2;
  const cy = (PITCH * rows) / 2;
  const topZ = Math.max(spec.heightMm, BASE_H + 1) + (spec.lip ? LIP_H : 0);
  const floorZ = Math.min(BASE_H + Math.max(spec.floor, 0), topZ - 0.5);

  // Body wall + one foot per unit cell (feet stay per-unit even under fused compartments)
  const parts: Shape3D[] = [rect(W, D, R_OUT, cx, cy, BASE_H).extrude(topZ - BASE_H)];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      parts.push(foot(PITCH * c + PITCH / 2, PITCH * (rows - 1 - r) + PITCH / 2));
    }
  }
  let tray = fuseAll(parts);

  // Compartment pockets. Grid row 0 is the top of the 2D editor -> highest Y in 3D.
  const pockets: Shape3D[] = [];
  for (const reg of spec.regions) {
    const x0 = PITCH * reg.c0 + (reg.c0 === 0 ? CLEAR + wall : wall / 2);
    const x1 = PITCH * (reg.c1 + 1) - (reg.c1 === cols - 1 ? CLEAR + wall : wall / 2);
    const y1 = PITCH * (rows - reg.r0) - (reg.r0 === 0 ? CLEAR + wall : wall / 2);
    const y0 = PITCH * (rows - 1 - reg.r1) + (reg.r1 === rows - 1 ? CLEAR + wall : wall / 2);
    const w = x1 - x0;
    const d = y1 - y0;
    if (w < 1 || d < 1 || floorZ >= topZ - 0.25) continue;
    const r = Math.max(0.4, Math.min(R_OUT - wall, w / 2 - 0.1, d / 2 - 0.1));
    pockets.push(
      rect(w, d, r, x0 + w / 2, y0 + d / 2, floorZ).extrude(topZ - floorZ + 1),
    );
  }
  if (pockets.length > 0) tray = tray.cut(fuseAll(pockets));

  // Stacking lip: cut a socket (mirror of the foot profile + clearance) into the top rim.
  if (spec.lip) {
    const socket = rect(W + 0.5, D + 0.5, R_OUT + 0.25, cx, cy, topZ + 0.5).loftWith(
      [
        rect(W - 4.0, D - 4.0, 1.75, cx, cy, topZ - 1.75),
        rect(W - 4.0, D - 4.0, 1.75, cx, cy, topZ - 3.55),
        rect(W - 5.6, D - 5.6, 0.95, cx, cy, topZ - 4.35),
      ],
      { ruled: true },
    );
    tray = tray.cut(socket);
  }

  if (spec.magnets) {
    const holes: Shape3D[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const fx = PITCH * c + PITCH / 2;
        const fy = PITCH * r + PITCH / 2;
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            holes.push(
              makeCylinder(MAGNET_D / 2, MAGNET_H + 0.01, [
                fx + sx * MAGNET_SPREAD,
                fy + sy * MAGNET_SPREAD,
                -0.005,
              ]),
            );
          }
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
