// Shared chrome for the floating popovers: the Settings/Export pair at the top
// left and the model switcher at the top right.

export const TRIGGER =
  "flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900/90 px-3.5 py-2 text-sm font-medium text-neutral-200 shadow-lg shadow-black/30 backdrop-blur transition-colors hover:bg-neutral-800 hover:text-white data-[popup-open]:bg-neutral-800 data-[popup-open]:text-white";

export const POPUP =
  "origin-[var(--transform-origin)] rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 shadow-xl shadow-black/40 backdrop-blur transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";
