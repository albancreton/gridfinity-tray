// Viewer-only settings: they change how the tray is drawn, never its geometry,
// so they live outside TrayParams and don't trigger a worker rebuild.

export interface ViewSettings {
  /** Shade the tray like an FDM print: layer lines on walls, diagonal top-fill on flats. */
  printLook: boolean;
  /** Layer height in mm for the printed look. */
  layerHeight: number;
}

export const DEFAULT_VIEW: ViewSettings = { printLook: true, layerHeight: 0.2 };

/** Nozzle-line width used for the top-fill beads (0.4mm nozzle, slightly squished). */
export const NOZZLE_LINE_W = 0.42;
