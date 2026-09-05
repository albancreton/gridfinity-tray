"use client";

import { NumberField } from "@base-ui/react/number-field";
import { Popover } from "@base-ui/react/popover";
import { Switch } from "@base-ui/react/switch";
import type { TrayParams } from "@/lib/protocol";
import { DEFAULT_BED, type JointKind, type SkadisParams } from "@/lib/skadis";
import type { ModelKind } from "@/lib/workerProtocol";
import type { ViewSettings } from "@/lib/viewSettings";
import type { ExportState } from "@/app/page";
import { POPUP, TRIGGER } from "./popoverStyles";

interface Props {
  /** Which generator is on screen; the Settings popover shows that model's params. */
  model: ModelKind;
  params: TrayParams;
  onChange: (next: TrayParams) => void;
  board: SkadisParams;
  onBoardChange: (next: SkadisParams) => void;
  view: ViewSettings;
  onViewChange: (next: ViewSettings) => void;
  /** The split the board's print bed implies; one entry when it prints whole. */
  boardPlan: { w: number; d: number }[];
  onExport: (kind: "stl" | "step") => void;
  exporting: ExportState;
}

function Field({
  label,
  value,
  min,
  max,
  step,
  unit,
  onValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onValue: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-300">{label}</span>
      <NumberField.Root
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => {
          if (v !== null) onValue(v);
        }}
        className="flex items-center"
      >
        <NumberField.Group className="flex items-center rounded-md border border-neutral-700 bg-neutral-800">
          <NumberField.Decrement className="w-7 self-stretch text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100">
            −
          </NumberField.Decrement>
          <NumberField.Input className="w-14 border-x border-neutral-700 bg-transparent py-1 text-center text-sm tabular-nums text-neutral-100 outline-none" />
          <NumberField.Increment className="w-7 self-stretch text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100">
            +
          </NumberField.Increment>
        </NumberField.Group>
        {unit && <span className="ml-2 w-6 text-xs text-neutral-500">{unit}</span>}
      </NumberField.Root>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChecked,
}: {
  label: string;
  checked: boolean;
  onChecked: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-300">{label}</span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onChecked}
        className="relative h-5 w-9 rounded-full bg-neutral-700 transition-colors data-[checked]:bg-sky-600"
      >
        <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-neutral-200 transition-transform data-[checked]:translate-x-[18px]" />
      </Switch.Root>
    </label>
  );
}

const JOINTS: { value: JointKind; label: string }[] = [
  { value: "jigsaw", label: "Jigsaw" },
  { value: "dovetail", label: "Dovetail" },
];

function Choice<T extends string>({
  label,
  value,
  options,
  onValue,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onValue: (v: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-300">{label}</span>
      <div className="flex gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            className={`rounded px-2 py-0.5 text-xs ${
              value === o.value
                ? "bg-sky-600 text-white"
                : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
            }`}
            onClick={() => onValue(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What the bed bought you. A piece may be rotated onto the plate, so the fit
 * test is either way round — and if even one lattice tile is bigger than the
 * bed there is no plan to make, which is worth saying out loud.
 */
function SplitReadout({
  plan,
  bed,
}: {
  plan: { w: number; d: number }[];
  bed: { w: number; d: number };
}) {
  const n = (v: number) => String(Number(v.toFixed(1)));
  const fits = (p: { w: number; d: number }) =>
    (p.w <= bed.w && p.d <= bed.d) || (p.w <= bed.d && p.d <= bed.w);
  if (!plan.every(fits)) {
    return (
      <p className="text-xs text-amber-400">
        Too small to split onto — one lattice tile already exceeds the bed.
      </p>
    );
  }
  return (
    <p className="text-xs tabular-nums text-neutral-400">
      {plan.length === 1 ? "Prints whole · " : `${plan.length} pieces · `}
      {plan.map((p) => `${n(p.w)}×${n(p.d)}`).join(", ")}
    </p>
  );
}

const HEIGHT_PRESETS = [2, 3, 4, 6];

function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="15" cy="7" r="2.5" fill="currentColor" />
      <circle cx="9" cy="12" r="2.5" fill="currentColor" />
      <circle cx="13" cy="17" r="2.5" fill="currentColor" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4v11M7 10l5 5 5-5M4 19h16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Floating top-left controls: a Settings popover (tray params + printed look)
 * and an Export popover (STL / STEP). Replaces the former sidebar; the grid
 * itself is sized and fused directly in the 3D view.
 */
export default function Toolbar({
  model,
  params,
  onChange,
  board,
  onBoardChange,
  view,
  onViewChange,
  boardPlan,
  onExport,
  exporting,
}: Props) {
  const set = (patch: Partial<TrayParams>) => onChange({ ...params, ...patch });
  const setBoard = (patch: Partial<SkadisParams>) => onBoardChange({ ...board, ...patch });
  const setView = (patch: Partial<ViewSettings>) => onViewChange({ ...view, ...patch });
  const label = (kind: "stl" | "step") => {
    if (exporting?.kind !== kind) return kind === "stl" ? "Export STL" : "Export STEP";
    return exporting.total > 1 ? `Exporting ${exporting.done + 1}/${exporting.total}…` : "Exporting…";
  };

  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
      <Popover.Root>
        <Popover.Trigger className={TRIGGER}>
          <SlidersIcon />
          Settings
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8}>
            <Popover.Popup className={`${POPUP} w-72`}>
              <div className="flex flex-col gap-3">
                {model === "skadis" ? (
                  <>
                    <Field
                      label="Thickness"
                      value={board.thickness}
                      min={2}
                      max={12}
                      step={0.2}
                      unit="mm"
                      onValue={(v) => setBoard({ thickness: v })}
                    />
                    <Toggle
                      label="Slot edge chamfer"
                      checked={board.chamfer}
                      onChecked={(v) => setBoard({ chamfer: v })}
                    />
                    <hr className="border-neutral-800" />
                    <Toggle
                      label="Split for printing"
                      checked={board.bed !== null}
                      onChecked={(v) => setBoard({ bed: v ? DEFAULT_BED : null })}
                    />
                    {board.bed && (
                      <>
                        <Field
                          label="Bed width"
                          value={board.bed.w}
                          min={40}
                          max={1000}
                          step={10}
                          unit="mm"
                          onValue={(v) => setBoard({ bed: { w: v, d: board.bed!.d } })}
                        />
                        <Field
                          label="Bed depth"
                          value={board.bed.d}
                          min={40}
                          max={1000}
                          step={10}
                          unit="mm"
                          onValue={(v) => setBoard({ bed: { w: board.bed!.w, d: v } })}
                        />
                        <Choice
                          label="Seam joint"
                          value={board.joint}
                          options={JOINTS}
                          onValue={(v) => setBoard({ joint: v })}
                        />
                        <Field
                          label="Joint clearance"
                          value={board.clearance}
                          min={0}
                          max={0.6}
                          step={0.05}
                          unit="mm"
                          onValue={(v) => setBoard({ clearance: v })}
                        />
                        <SplitReadout plan={boardPlan} bed={board.bed} />
                        <Toggle
                          label="Separate pieces"
                          checked={view.explode}
                          onChecked={(v) => setView({ explode: v })}
                        />
                      </>
                    )}
                  </>
                ) : (
                  <>
                  <Field
                    label="Height"
                    value={params.heightMm}
                    min={7}
                    max={140}
                    step={1}
                    unit="mm"
                    onValue={(v) => set({ heightMm: v })}
                  />
                  <div className="flex justify-end gap-1.5">
                    {HEIGHT_PRESETS.map((u) => (
                      <button
                        key={u}
                        className={`rounded px-2 py-0.5 text-xs tabular-nums ${
                          params.heightMm === u * 7
                            ? "bg-sky-600 text-white"
                            : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                        }`}
                        onClick={() => set({ heightMm: u * 7 })}
                      >
                        {u}u
                      </button>
                    ))}
                  </div>
                  <Field
                    label="Wall thickness"
                    value={params.wall}
                    min={0.8}
                    max={4}
                    step={0.1}
                    unit="mm"
                    onValue={(v) => set({ wall: v })}
                  />
                  <Field
                    label="Floor thickness"
                    value={params.floor}
                    min={0}
                    max={10}
                    step={0.2}
                    unit="mm"
                    onValue={(v) => set({ floor: v })}
                  />
                  <Toggle label="Stacking lip" checked={params.lip} onChecked={(v) => set({ lip: v })} />
                  <Toggle
                    label="Magnet holes"
                    checked={params.magnets}
                    onChecked={(v) => set({ magnets: v })}
                  />
                  </>
                )}
                <hr className="border-neutral-800" />
                <Toggle
                  label="Printed look"
                  checked={view.printLook}
                  onChecked={(v) => setView({ printLook: v })}
                />
                {view.printLook && (
                  <Field
                    label="Layer height"
                    value={view.layerHeight}
                    min={0.08}
                    max={0.4}
                    step={0.04}
                    unit="mm"
                    onValue={(v) => setView({ layerHeight: v })}
                  />
                )}
                {process.env.NODE_ENV === "development" && (
                  <Toggle
                    label="CAD overlay (dev)"
                    checked={view.cadOverlay}
                    onChecked={(v) => setView({ cadOverlay: v })}
                  />
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <Popover.Root>
        <Popover.Trigger className={TRIGGER}>
          <DownloadIcon />
          Export
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8}>
            <Popover.Popup className={`${POPUP} w-52`}>
              <div className="flex flex-col gap-2">
                <button
                  className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
                  disabled={exporting !== null}
                  onClick={() => onExport("stl")}
                >
                  {label("stl")}
                </button>
                <button
                  className="rounded-md bg-neutral-700 px-3 py-2 text-sm font-medium text-neutral-100 enabled:hover:bg-neutral-600 disabled:opacity-40"
                  disabled={exporting !== null}
                  onClick={() => onExport("step")}
                >
                  {label("step")}
                </button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
