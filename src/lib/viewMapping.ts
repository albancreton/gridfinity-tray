// Mouse-button → viewport-action mappings. Pure data, renderer-agnostic:
// the Viewer translates actions to OrbitControls config. Adding a preset here
// is all it takes to offer it in a future settings UI.

export type ViewAction = "orbit" | "pan" | "zoom" | "none";
export type MouseButton = "left" | "middle" | "right";

export interface ViewMapping {
  id: string;
  label: string;
  buttons: Record<MouseButton, ViewAction>;
  /** Overrides applied when Shift is held at the moment the drag starts. */
  shiftButtons?: Partial<Record<MouseButton, ViewAction>>;
  /** Whether the scroll wheel zooms. */
  wheelZoom: boolean;
}

export const VIEW_MAPPINGS: ViewMapping[] = [
  {
    id: "fusion",
    label: "Fusion 360",
    buttons: { left: "none", middle: "pan", right: "none" },
    shiftButtons: { middle: "orbit" },
    wheelZoom: true,
  },
  {
    id: "classic",
    label: "Classic",
    buttons: { left: "orbit", middle: "zoom", right: "pan" },
    wheelZoom: true,
  },
];

export const DEFAULT_MAPPING_ID = "fusion";

export function getViewMapping(id: string): ViewMapping {
  return VIEW_MAPPINGS.find((m) => m.id === id) ?? VIEW_MAPPINGS[0];
}
