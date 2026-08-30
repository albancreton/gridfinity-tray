"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import GridEditor from "@/components/GridEditor";
import Sidebar from "@/components/Sidebar";
import { GridState, allRegions, initialGrid } from "@/lib/grid";
import { requestExport, requestMesh, downloadBlob } from "@/lib/cadClient";
import { traySizeMm, type MeshData, type TrayParams, type TraySpec } from "@/lib/protocol";

const Viewer = dynamic(() => import("@/components/Viewer"), { ssr: false });

type Status = "init" | "building" | "ready" | "error";

function useTrayMesh(spec: TraySpec) {
  const [mesh, setMesh] = useState<MeshData | null>(null);
  const [status, setStatus] = useState<Status>("init");
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(() => {
      setStatus((s) => (s === "init" ? "init" : "building"));
      requestMesh(spec)
        .then((m) => {
          if (seq.current !== id) return;
          setMesh(m);
          setStatus("ready");
          setError(null);
        })
        .catch((err: Error) => {
          if (seq.current !== id) return;
          setStatus("error");
          setError(err.message);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [spec]);

  return { mesh, status, error };
}

const STATUS_COLOR: Record<Status, string> = {
  init: "bg-neutral-500 animate-pulse",
  building: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-500",
  error: "bg-red-500",
};

const STORAGE_KEY = "gridfinity-tray-v1";

const DEFAULT_PARAMS: TrayParams = {
  heightMm: 21,
  wall: 1.2,
  floor: 1.0,
  lip: true,
  magnets: false,
};

function loadSaved(): { grid: GridState; params: TrayParams } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.grid?.cols || !data.params) return null;
    return { grid: data.grid, params: { ...DEFAULT_PARAMS, ...data.params } };
  } catch {
    return null;
  }
}

export default function Home() {
  const [grid, setGrid] = useState<GridState>(initialGrid);
  const [params, setParams] = useState<TrayParams>(DEFAULT_PARAMS);
  // Saving is gated on state (not a ref) so the effect order during the mount
  // commit can't overwrite the stored design with the defaults before the
  // restore re-render happens.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- hydration-safe localStorage restore, runs once */
    const saved = loadSaved();
    if (saved) {
      setGrid(saved.grid);
      setParams(saved.params);
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ grid, params }));
    } catch {}
  }, [hydrated, grid, params]);
  const [exporting, setExporting] = useState<"stl" | "step" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const spec = useMemo<TraySpec>(
    () => ({ cols: grid.cols, rows: grid.rows, regions: allRegions(grid), ...params }),
    [grid, params],
  );

  const { mesh, status, error } = useTrayMesh(spec);
  const size = traySizeMm(spec);
  const fmt = (v: number) => String(Number(v.toFixed(2)));

  const handleExport = async (kind: "stl" | "step") => {
    setExporting(kind);
    setExportError(null);
    try {
      const blob = await requestExport(kind, spec);
      const ext = kind === "stl" ? "stl" : "step";
      downloadBlob(blob, `gridfinity-tray-${grid.cols}x${grid.rows}-h${params.heightMm}.${ext}`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex h-dvh bg-neutral-950 text-neutral-200">
      <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-r border-neutral-800 p-4">
        <GridEditor state={grid} onChange={setGrid} />
        <hr className="border-neutral-800" />
        <Sidebar params={params} onChange={setParams} onExport={handleExport} exporting={exporting} />
        {(error || exportError) && (
          <p className="text-xs break-words text-red-400">{error ?? exportError}</p>
        )}
      </aside>
      <main className="relative flex-1">
        <Viewer mesh={mesh} cols={grid.cols} rows={grid.rows} />
        <div
          className={`absolute top-3 right-3 h-2.5 w-2.5 rounded-full ${STATUS_COLOR[status]}`}
          title={status === "error" ? (error ?? "error") : status === "init" ? "loading CAD kernel…" : status}
        />
        <p className="absolute bottom-3 left-4 text-xs tabular-nums text-neutral-500">
          {fmt(size.w)} × {fmt(size.d)} × {fmt(size.h)} mm
        </p>
        {status === "init" && (
          <p className="absolute inset-x-0 top-[45%] text-center text-sm text-neutral-500">
            Loading CAD kernel…
          </p>
        )}
      </main>
    </div>
  );
}
