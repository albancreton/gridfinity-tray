// Animation presets for tray entities. lib/transitions groups the parts that
// change into entities (a cell with its walls, a divider, ...) and picks a
// preset for each; Viewer's EntityMesh renders the entity as its own mesh and
// plays the preset. A preset just drives a plain Pose with Motion's animate():
// to try something new, tweak numbers here, add a preset, or point
// transitions.ts at a different one — no shader or React work involved.

import { animate } from "motion";

export interface Pose {
  /** Translation in mm on top of the entity's resting place (y is up). */
  x: number;
  y: number;
  z: number;
  /** Rotation in radians about the entity's center. */
  rx: number;
  ry: number;
  rz: number;
  scale: number;
  opacity: number;
  /** 0..1: how much of the entity exists yet, from the bed up (the print-in look). */
  reveal: number;
}

export const restPose = (): Pose => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1, opacity: 1, reveal: 1 });

export interface PresetContext {
  /** Seconds before the preset starts moving. */
  delay: number;
  /** Unit plan direction (x, z) away from the change's center; zero when there is none. */
  dir: [number, number];
  /** Stable per-entity number in [0, 1) for deterministic variation. */
  seed: number;
}

export interface Playback {
  stop(): void;
}

/**
 * A preset in two steps. `prepare` sets the starting pose and runs at mount,
 * before the first frame, so nothing flashes at rest; `play` starts the motion
 * and runs only once the scene has rendered a frame with the entity in place —
 * the commit that builds a big tray can stall for a while, and the animation
 * must not lose its opening to that.
 */
export interface Preset {
  prepare?(pose: Pose, ctx: PresetContext): void;
  play(pose: Pose, ctx: PresetContext): Playback;
}

/** Nominal durations in ms; the slow-motion knob scales them at play time. */
export const PRESET_MS = {
  cellIn: 300,
  cellOut: 200,
  fadeIn: 700,
  fadeOut: 700,
  land: 1000,
  explode: 2000,
  printIn: 1300,
} as const;
export type PresetName = keyof typeof PRESET_MS;

/**
 * Coverage of the cells a shrink is about to remove, while the handle is still
 * held (Viewer's `uGhostAlpha`). The `*Out` presets start from it, so the commit
 * continues that fade instead of flashing back to solid — keep them in step.
 */
export const GHOST_ALPHA = 0.5;

/** mm a cell travels along the up axis while it fades. */
export const CELL_TRAVEL = 300;
export const CELL_TRAVEL_OUT = -30;
/** mm a landing wall drops from. */
export const LAND_DROP = 200;

/** Dev hook: `window.__animSlow = 6` stretches every animation 6×. */
export function slowFactor(): number {
  if (typeof window === "undefined" || process.env.NODE_ENV !== "development") return 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Number((window as any).__animSlow) || 1;
}

const secs = (name: PresetName) => (PRESET_MS[name] * slowFactor()) / 1000;

function easeOutBounce(x: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export const presets: Record<PresetName, Preset> = {
  /** A whole cell settles down onto the tray while fading in. */
  cellIn: {
    prepare(pose) {
      pose.y = CELL_TRAVEL;
      pose.opacity = 0;
    },
    play(pose, ctx) {
      return animate(pose, { y: 0, opacity: 1 }, { duration: secs("cellIn"), delay: ctx.delay, ease: "easeOut" });
    },
  },
  /** The reverse: lifts off and fades. */
  cellOut: {
    prepare(pose) {
      pose.opacity = GHOST_ALPHA;
    },
    play(pose, ctx) {
      return animate(pose, { y: CELL_TRAVEL_OUT, opacity: 0 }, { duration: secs("cellOut"), delay: ctx.delay, ease: "easeIn" });
    },
  },
  fadeIn: {
    prepare(pose) {
      pose.opacity = 0;
    },
    play(pose, ctx) {
      return animate(pose, { opacity: 1 }, { duration: secs("fadeIn"), delay: ctx.delay });
    },
  },
  fadeOut: {
    prepare(pose) {
      pose.opacity = GHOST_ALPHA;
    },
    play(pose, ctx) {
      return animate(pose, { opacity: 0 }, { duration: secs("fadeOut"), delay: ctx.delay });
    },
  },
  /** A new wall drops in and bounces to rest. */
  land: {
    prepare(pose) {
      pose.y = LAND_DROP;
      pose.opacity = 0;
    },
    play(pose, ctx) {
      return animate(
        pose,
        { y: 0, opacity: [0, 1, 1] },
        { duration: secs("land"), delay: ctx.delay, ease: easeOutBounce },
      );
    },
  },
  /** A removed wall bursts up and away from the change, tumbling, and fades mid-flight. */
  explode: {
    play(pose, ctx) {
      const [dx, dz] = ctx.dir;
      const s = ctx.seed;
      const reach = 25 + 20 * s;
      const spinX = (s - 0.5) * 2.5;
      const spinZ = (0.5 - s) * 2;
      return animate(
        pose,
        {
          x: [0, dx * reach * 0.6, dx * reach],
          z: [0, dz * reach * 0.6, dz * reach],
          y: [0, 22 + 16 * s, -12],
          rx: [0, spinX * 0.5, spinX],
          rz: [0, spinZ * 0.5, spinZ],
          opacity: [1, 1, 0],
        },
        {
          duration: secs("explode"),
          delay: ctx.delay + s * 0.05 * secs("explode"),
          times: [0, 0.45, 1],
          ease: ["easeOut", "easeIn"],
        },
      );
    },
  },
  /** The earlier look: the entity prints in from the bed up. */
  printIn: {
    prepare(pose) {
      pose.reveal = 0;
    },
    play(pose, ctx) {
      return animate(pose, { reveal: 1 }, { duration: secs("printIn"), delay: ctx.delay, ease: "linear" });
    },
  },
};
