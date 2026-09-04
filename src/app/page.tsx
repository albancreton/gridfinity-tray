"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import ModelSwitcher from "@/components/ModelSwitcher";
import Toolbar from "@/components/Toolbar";
import { GridState, allRegions, initialGrid, reframe } from "@/lib/grid";
import { requestExport, downloadBlob } from "@/lib/cadClient";
import { traySizeMm, type TrayParams, type TraySpec } from "@/lib/protocol";
import {
  DEFAULT_SKADIS_PARAMS,
  boardSizeMm,
  initialBoard,
  reframeBoard,
  type SkadisParams,
  type SkadisSpec,
  type SkadisState,
} from "@/lib/skadis";
import { buildTrayParts } from "@/lib/trayParts";
import { DEFAULT_VIEW, type ViewSettings } from "@/lib/viewSettings";
import type { Job, ModelKind } from "@/lib/workerProtocol";

const Viewer = dynamic(() => import("@/components/Viewer"), { ssr: false });
const BoardViewer = dynamic(() => import("@/components/BoardViewer"), { ssr: false });

const STORAGE_KEY = "gridfinity-tray-v1";

const DEFAULT_PARAMS: TrayParams = {
  heightMm: 21,
  wall: 1.2,
  floor: 1.0,
  lip: true,
  magnets: false,
};

interface Saved {
  model: ModelKind;
  grid: GridState;
  params: TrayParams;
  board: SkadisState;
  boardParams: SkadisParams;
  view: ViewSettings;
}

/** Defaults are spread over whatever is stored, so a design saved before the
 *  board existed restores untouched. */
function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.grid?.cols || !data.params) return null;
    return {
      model: data.model === "skadis" ? "skadis" : "tray",
      grid: data.grid,
      params: { ...DEFAULT_PARAMS, ...data.params },
      board: { ...initialBoard(), ...(data.board ?? {}) },
      boardParams: { ...DEFAULT_SKADIS_PARAMS, ...(data.boardParams ?? {}) },
      view: { ...DEFAULT_VIEW, ...(data.view ?? {}) },
    };
  } catch {
    return null;
  }
}

export default function Home() {
  const [model, setModel] = useState<ModelKind>("tray");
  const [grid, setGrid] = useState<GridState>(initialGrid);
  const [params, setParams] = useState<TrayParams>(DEFAULT_PARAMS);
  const [board, setBoard] = useState<SkadisState>(initialBoard);
  const [boardParams, setBoardParams] = useState<SkadisParams>(DEFAULT_SKADIS_PARAMS);
  const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);
  // Saving is gated on state (not a ref) so the effect order during the mount
  // commit can't overwrite the stored design with the defaults before the
  // restore re-render happens.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- hydration-safe localStorage restore, runs once */
    const saved = loadSaved();
    if (saved) {
      setModel(saved.model);
      setGrid(saved.grid);
      setParams(saved.params);
      setBoard(saved.board);
      setBoardParams(saved.boardParams);
      setView(saved.view);
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ model, grid, params, board, boardParams, view }),
      );
    } catch {}
  }, [hydrated, model, grid, params, board, boardParams, view]);
  const [exporting, setExporting] = useState<"stl" | "step" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const spec = useMemo<TraySpec>(
    () => ({ cols: grid.cols, rows: grid.rows, regions: allRegions(grid), ...params }),
    [grid, params],
  );
  const boardSpec = useMemo<SkadisSpec>(
    () => ({ ...board, ...boardParams }),
    [board, boardParams],
  );
  // The preview is meshed synchronously from the layout and partitioned into
  // animatable parts — every change shows on the next frame. The CAD kernel (a
  // worker, loaded on first use) only builds exports.
  const geometry = useMemo(() => buildTrayParts(spec), [spec]);
  const size = model === "skadis" ? boardSizeMm(boardSpec) : traySizeMm(spec);
  const fmt = (v: number) => String(Number(v.toFixed(2)));

  const handleExport = async (kind: "stl" | "step") => {
    setExporting(kind);
    setExportError(null);
    try {
      const job: Job =
        model === "skadis" ? { model: "skadis", spec: boardSpec } : { model: "tray", spec };
      const blob = await requestExport(kind, job);
      const ext = kind === "stl" ? "stl" : "step";
      const name =
        model === "skadis"
          ? `skadis-board-${board.cols}x${board.rows}`
          : `gridfinity-tray-${grid.cols}x${grid.rows}-h${params.heightMm}`;
      downloadBlob(blob, `${name}.${ext}`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

  return (
    <main className="relative h-dvh bg-neutral-950 text-neutral-200">
      {/* Mounted after the restore, so the one-time camera pose frames the
          saved design. Switching models remounts the canvas, which reframes. */}
      {hydrated &&
        (model === "skadis" ? (
          <BoardViewer
            spec={boardSpec}
            onResize={(frame) => setBoard(reframeBoard(frame))}
            view={view}
          />
        ) : (
          <Viewer
            geometry={geometry}
            spec={spec}
            grid={grid}
            params={params}
            onResize={(frame) => setGrid((g) => reframe(g, frame))}
            onGridChange={setGrid}
            view={view}
          />
        ))}
      <Toolbar
        model={model}
        params={params}
        onChange={setParams}
        board={boardParams}
        onBoardChange={setBoardParams}
        view={view}
        onViewChange={setView}
        onExport={handleExport}
        exporting={exporting}
      />
      <ModelSwitcher model={model} onChange={setModel} />
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
