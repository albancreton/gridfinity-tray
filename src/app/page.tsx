"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Toolbar from "@/components/Toolbar";
import { GridState, allRegions, initialGrid, reframe } from "@/lib/grid";
import { requestExport, downloadBlob } from "@/lib/cadClient";
import { traySizeMm, type TrayParams, type TraySpec } from "@/lib/protocol";
import { buildTrayGeometry } from "@/lib/trayMesher";
import { DEFAULT_VIEW, type ViewSettings } from "@/lib/viewSettings";

const Viewer = dynamic(() => import("@/components/Viewer"), { ssr: false });

const STORAGE_KEY = "gridfinity-tray-v1";

const DEFAULT_PARAMS: TrayParams = {
  heightMm: 21,
  wall: 1.2,
  floor: 1.0,
  lip: true,
  magnets: false,
};

function loadSaved(): { grid: GridState; params: TrayParams; view: ViewSettings } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.grid?.cols || !data.params) return null;
    return {
      grid: data.grid,
      params: { ...DEFAULT_PARAMS, ...data.params },
      view: { ...DEFAULT_VIEW, ...(data.view ?? {}) },
    };
  } catch {
    return null;
  }
}

export default function Home() {
  const [grid, setGrid] = useState<GridState>(initialGrid);
  const [params, setParams] = useState<TrayParams>(DEFAULT_PARAMS);
  const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);
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
      setView(saved.view);
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ grid, params, view }));
    } catch {}
  }, [hydrated, grid, params, view]);
  const [exporting, setExporting] = useState<"stl" | "step" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const spec = useMemo<TraySpec>(
    () => ({ cols: grid.cols, rows: grid.rows, regions: allRegions(grid), ...params }),
    [grid, params],
  );
  // The preview is meshed synchronously from the layout — every change shows on
  // the next frame. The CAD kernel (a worker, loaded on first use) only builds exports.
  const geometry = useMemo(() => buildTrayGeometry(spec), [spec]);
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
    <main className="relative h-dvh bg-neutral-950 text-neutral-200">
        {/* Mounted after the restore: the Viewer frames the tray once, at mount. */}
        {hydrated && (
          <Viewer
            geometry={geometry}
            spec={spec}
            grid={grid}
            params={params}
            onResize={(frame) => setGrid((g) => reframe(g, frame))}
            onGridChange={setGrid}
            view={view}
          />
        )}
        <Toolbar
          params={params}
          onChange={setParams}
          view={view}
          onViewChange={setView}
          onExport={handleExport}
          exporting={exporting}
        />
        {exportError && (
          <p className="absolute top-16 left-3 z-10 max-w-sm text-xs break-words text-red-400">
            {exportError}
          </p>
        )}
        <p className="absolute right-3 bottom-3 text-xs tabular-nums text-neutral-500">
          {fmt(size.w)} × {fmt(size.d)} × {fmt(size.h)} mm
        </p>
    </main>
  );
}
