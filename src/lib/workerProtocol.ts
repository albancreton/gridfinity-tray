// The wire between the UI and the CAD worker. It carries a `Job` — which model
// to build and its spec — so the two generators share one worker, one WASM
// instance and one request queue.

import type { TraySpec } from "./protocol";
import type { SkadisSpec } from "./skadis";

/** Which generator the app is showing, and which builder the worker runs. */
export type ModelKind = "tray" | "skadis";

/** What to build. The `model` tag picks the builder in the worker. */
export type Job = { model: "tray"; spec: TraySpec } | { model: "skadis"; spec: SkadisSpec };

export interface MeshData {
  vertices: Float32Array;
  triangles: Uint32Array;
  /** Edge polylines, flat [x,y,z,x,y,z,...] pairs forming line segments. */
  edges: Float32Array;
}

export type WorkerRequest = { id: number; type: "mesh" | "stl" | "step" } & Job;

export type WorkerResponse =
  | { id: number; ok: true; type: "mesh"; mesh: MeshData }
  | { id: number; ok: true; type: "stl" | "step"; file: ArrayBuffer }
  | { id: number; ok: false; error: string };
