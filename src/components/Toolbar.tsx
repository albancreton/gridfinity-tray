"use client";

import { NumberField } from "@base-ui/react/number-field";
import { Popover } from "@base-ui/react/popover";
import { Switch } from "@base-ui/react/switch";
import type { TrayParams } from "@/lib/protocol";
import type { ViewSettings } from "@/lib/viewSettings";

interface Props {
  params: TrayParams;
  onChange: (next: TrayParams) => void;
  view: ViewSettings;
  onViewChange: (next: ViewSettings) => void;
  onExport: (kind: "stl" | "step") => void;
  exporting: "stl" | "step" | null;
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

const HEIGHT_PRESETS = [2, 3, 4, 6];

const TRIGGER =
  "flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900/90 px-3.5 py-2 text-sm font-medium text-neutral-200 shadow-lg shadow-black/30 backdrop-blur transition-colors hover:bg-neutral-800 hover:text-white data-[popup-open]:bg-neutral-800 data-[popup-open]:text-white";

const POPUP =
  "origin-[var(--transform-origin)] rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 shadow-xl shadow-black/40 backdrop-blur transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

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
  params,
  onChange,
  view,
  onViewChange,
  onExport,
  exporting,
}: Props) {
  const set = (patch: Partial<TrayParams>) => onChange({ ...params, ...patch });
  const setView = (patch: Partial<ViewSettings>) => onViewChange({ ...view, ...patch });

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
                  {exporting === "stl" ? "Exporting…" : "Export STL"}
                </button>
                <button
                  className="rounded-md bg-neutral-700 px-3 py-2 text-sm font-medium text-neutral-100 enabled:hover:bg-neutral-600 disabled:opacity-40"
                  disabled={exporting !== null}
                  onClick={() => onExport("step")}
                >
                  {exporting === "step" ? "Exporting…" : "Export STEP"}
                </button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
