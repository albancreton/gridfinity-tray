"use client";

import { Popover } from "@base-ui/react/popover";
import type { ModelKind } from "@/lib/workerProtocol";
import { POPUP, TRIGGER } from "./popoverStyles";

const MODELS: { id: ModelKind; name: string; blurb: string }[] = [
  { id: "tray", name: "Gridfinity tray", blurb: "42mm grid · fusable compartments" },
  { id: "skadis", name: "SKÅDIS board", blurb: "IKEA pegboard · 40mm slot pitch" },
];

function TrayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M9 6v13M15 6v13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
      {/* the checkerboard the real board uses: corners empty */}
      {[
        [12, 6],
        [7.5, 10.5],
        [16.5, 10.5],
        [12, 15],
      ].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x - 0.9} y={y - 1.9} width="1.8" height="3.8" rx="0.9" fill="currentColor" />
      ))}
    </svg>
  );
}

const ICONS: Record<ModelKind, () => React.ReactElement> = { tray: TrayIcon, skadis: BoardIcon };

/** Top-right switch between the two generators. */
export default function ModelSwitcher({
  model,
  onChange,
}: {
  model: ModelKind;
  onChange: (next: ModelKind) => void;
}) {
  const current = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const CurrentIcon = ICONS[current.id];
  return (
    <div className="absolute top-3 right-3 z-10">
      <Popover.Root>
        <Popover.Trigger className={TRIGGER}>
          <CurrentIcon />
          {current.name}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8}>
            <Popover.Popup className={`${POPUP} w-64 p-2`}>
              <div className="flex flex-col gap-1">
                {MODELS.map((m) => {
                  const Icon = ICONS[m.id];
                  const active = m.id === model;
                  return (
                    <Popover.Close
                      key={m.id}
                      render={
                        <button
                          onClick={() => onChange(m.id)}
                          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                            active
                              ? "bg-sky-600/20 text-sky-200"
                              : "text-neutral-300 hover:bg-neutral-800"
                          }`}
                        >
                          <Icon />
                          <span className="flex flex-col">
                            <span className="text-sm font-medium">{m.name}</span>
                            <span className="text-xs text-neutral-500">{m.blurb}</span>
                          </span>
                        </button>
                      }
                    />
                  );
                })}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
