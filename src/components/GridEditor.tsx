"use client";

import { useCallback, useRef, useState } from "react";
import type { Region } from "@/lib/protocol";
import {
  GridState,
  MAX_UNITS,
  allRegions,
  boundingRect,
  canFuseSelection,
  canSplitSelection,
  expandSelection,
  fuse,
  normalizeRect,
  regionArea,
  regionAt,
  regionLabel,
  resize,
  split,
} from "@/lib/grid";

const GAP = 4;
const PANEL = 288; // inner width available for the grid

interface Props {
  state: GridState;
  onChange: (next: GridState) => void;
}

export default function GridEditor({ state, onChange }: Props) {
  const [selection, setSelection] = useState<Region | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragAnchor = useRef<Region | null>(null);
  const resizeStart = useRef<{
    x: number;
    y: number;
    cols: number;
    rows: number;
    axis: "x" | "y" | "xy";
  } | null>(null);

  const cell = Math.max(18, Math.min(40, Math.floor((PANEL - (state.cols - 1) * GAP) / state.cols)));
  const stride = cell + GAP;

  const cellFromEvent = useCallback(
    (e: React.PointerEvent): { r: number; c: number } | null => {
      const el = gridRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const c = Math.max(0, Math.min(state.cols - 1, Math.floor((e.clientX - rect.left) / stride)));
      const r = Math.max(0, Math.min(state.rows - 1, Math.floor((e.clientY - rect.top) / stride)));
      return { r, c };
    },
    [state.cols, state.rows, stride],
  );

  const onGridPointerDown = (e: React.PointerEvent) => {
    const pos = cellFromEvent(e);
    if (!pos) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    const anchor = regionAt(state, pos.r, pos.c);
    dragAnchor.current = anchor;
    setSelection(expandSelection(state, anchor));
  };

  const onGridPointerMove = (e: React.PointerEvent) => {
    if (!dragAnchor.current) return;
    const pos = cellFromEvent(e);
    if (!pos) return;
    const rect = boundingRect(dragAnchor.current, normalizeRect(pos.r, pos.c, pos.r, pos.c));
    setSelection(expandSelection(state, rect));
  };

  const onGridPointerUp = () => {
    dragAnchor.current = null;
  };

  const startResize = (axis: "x" | "y" | "xy", e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    resizeStart.current = { x: e.clientX, y: e.clientY, cols: state.cols, rows: state.rows, axis };
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    const dc = s.axis === "y" ? 0 : Math.round((e.clientX - s.x) / stride);
    const dr = s.axis === "x" ? 0 : Math.round((e.clientY - s.y) / stride);
    const next = resize(state, s.cols + dc, s.rows + dr);
    if (next.cols !== state.cols || next.rows !== state.rows) {
      onChange(next);
      setSelection(null);
    }
  };

  const endResize = () => {
    resizeStart.current = null;
  };

  const regions = allRegions(state);
  // A resize from the 3D handles can shrink the grid under a live selection;
  // treat any selection that no longer fits as cleared.
  const sel =
    selection && selection.c1 < state.cols && selection.r1 < state.rows ? selection : null;
  const canFuse = sel !== null && canFuseSelection(state, sel);
  const canSplit = sel !== null && canSplitSelection(state, sel);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white enabled:hover:bg-sky-500 disabled:opacity-30"
          disabled={!canFuse}
          onClick={() => {
            if (sel) onChange(fuse(state, sel));
          }}
        >
          Fuse
        </button>
        <button
          className="rounded-md bg-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-100 enabled:hover:bg-neutral-600 disabled:opacity-30"
          disabled={!canSplit}
          onClick={() => {
            if (sel) {
              onChange(split(state, sel));
              setSelection(null);
            }
          }}
        >
          Split
        </button>
        <span className="ml-auto text-sm tabular-nums text-neutral-400">
          {state.cols} × {state.rows}
        </span>
      </div>

      <div
        className="relative select-none self-start touch-none"
        style={{ paddingRight: 14, paddingBottom: 14 }}
      >
        <div
          ref={gridRef}
          className="grid cursor-crosshair"
          style={{
            gap: GAP,
            gridTemplateColumns: `repeat(${state.cols}, ${cell}px)`,
            gridTemplateRows: `repeat(${state.rows}, ${cell}px)`,
          }}
          onPointerDown={onGridPointerDown}
          onPointerMove={onGridPointerMove}
          onPointerUp={onGridPointerUp}
        >
          {regions.map((reg, i) => {
            const merged = regionArea(reg) > 1;
            return (
              <div
                key={`${reg.r0}-${reg.c0}`}
                className="flex items-center justify-center rounded-md text-xs font-semibold"
                style={{
                  gridColumn: `${reg.c0 + 1} / ${reg.c1 + 2}`,
                  gridRow: `${reg.r0 + 1} / ${reg.r1 + 2}`,
                  background: merged ? `hsl(${(i * 57) % 360} 42% 34%)` : "#27272a",
                  color: merged ? "#f4f4f5" : "#8a8a93",
                }}
              >
                {regionLabel(i)}
              </div>
            );
          })}
          {sel && (
            <div
              className="pointer-events-none rounded-md border-2 border-sky-400 bg-sky-400/15"
              style={{
                gridColumn: `${sel.c0 + 1} / ${sel.c1 + 2}`,
                gridRow: `${sel.r0 + 1} / ${sel.r1 + 2}`,
                margin: -2,
              }}
            />
          )}
        </div>

        {/* resize handles */}
        <div
          className="absolute top-0 right-0 flex w-[12px] cursor-ew-resize items-center justify-center rounded-sm hover:bg-neutral-800"
          style={{ height: `calc(100% - 14px)` }}
          onPointerDown={(e) => startResize("x", e)}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          title="Drag to add / remove columns"
        >
          <div className="h-6 w-[3px] rounded-full bg-neutral-600" />
        </div>
        <div
          className="absolute bottom-0 left-0 flex h-[12px] cursor-ns-resize items-center justify-center rounded-sm hover:bg-neutral-800"
          style={{ width: `calc(100% - 14px)` }}
          onPointerDown={(e) => startResize("y", e)}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          title="Drag to add / remove rows"
        >
          <div className="h-[3px] w-6 rounded-full bg-neutral-600" />
        </div>
        <div
          className="absolute right-0 bottom-0 h-[12px] w-[12px] cursor-nwse-resize rounded-sm bg-neutral-700 hover:bg-neutral-500"
          onPointerDown={(e) => startResize("xy", e)}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          title="Drag to resize the grid"
        />
      </div>

      <p className="text-xs leading-relaxed text-neutral-500">
        Drag the edges to size the tray (max {MAX_UNITS} × {MAX_UNITS}). Drag across cells to
        select, then fuse them into one compartment.
      </p>
    </div>
  );
}
