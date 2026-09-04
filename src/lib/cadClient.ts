import type { Job, MeshData, WorkerRequest, WorkerResponse } from "./workerProtocol";

type Pending = {
  resolve: (res: WorkerResponse) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/cad.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const p = pending.get(event.data.id);
      if (p) {
        pending.delete(event.data.id);
        p.resolve(event.data);
      }
    };
  }
  return worker;
}

function request(type: WorkerRequest["type"], job: Job): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    getWorker().postMessage({ id, type, ...job } as WorkerRequest);
  });
}

export async function requestMesh(job: Job): Promise<MeshData> {
  const res = await request("mesh", job);
  if (!res.ok) throw new Error(res.error);
  if (res.type !== "mesh") throw new Error("unexpected response");
  return res.mesh;
}

export async function requestExport(kind: "stl" | "step", job: Job): Promise<Blob> {
  const res = await request(kind, job);
  if (!res.ok) throw new Error(res.error);
  if (res.type === "mesh") throw new Error("unexpected response");
  return new Blob([res.file], { type: "application/octet-stream" });
}

if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__cad = { requestMesh, requestExport };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
