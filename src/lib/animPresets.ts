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

/**
 * The leaving cell's burst, in ms: it shivers sideways while shrinking, holds
 * still, then blows up and vanishes. Tune these three and the whole preset —
 * including `PRESET_MS.cellOut`, which the transition's clock reads — follows.
 */
export const SHAKE_MS = 600;
export const SHAKE_HOLD_MS = 0;
export const BURST_MS = 150;
/** mm of the first lateral swing; each of the SHAKE_SWINGS steps is that much smaller, ending at 0. */
export const SHAKE_X = 0.8;
export const SHAKE_SWINGS = 12;
/** How much the cell shrinks over the shiver (negative swells it instead), and how big it blows up. */
export const SHAKE_SHRINK = -0.25;
export const BURST_SCALE = 2;
/** What `cellOut` and `explode` both last. */
export const BURST_TOTAL_MS = SHAKE_MS + SHAKE_HOLD_MS + BURST_MS;

/** Nominal durations in ms; the slow-motion knob scales them at play time. */
export const PRESET_MS = {
  cellIn: 300,
  cellOut: BURST_TOTAL_MS,
  fadeIn: 700,
  fadeOut: 700,
  land: 350,
  explode: BURST_TOTAL_MS,
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
/** mm a landing wall drops from. */
export const LAND_DROP = 100;

/** Dev hook: `window.__animSlow = 6` stretches every animation 6×. */
export function slowFactor(): number {
  if (typeof window === "undefined" || process.env.NODE_ENV !== "development") return 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Number((window as any).__animSlow) || 1;
}

const secs = (name: PresetName) => (PRESET_MS[name] * slowFactor()) / 1000;

function easeOutBounce(x: number): number {
  const n1 = 12.5625, d1 = 3.15;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

/**
 * Going away as a fuse gone wrong: a lateral shiver that alternates sides and
 * damps to nothing while the entity swells by SHAKE_SHRINK, a beat of stillness,
 * then a blow-up to BURST_SCALE and it is gone. One keyframe track — the shiver
 * stops, the end of the hold, the burst — starting from `alpha`, which is
 * GHOST_ALPHA for cells already ghosted under a held resize handle and 1 for
 * walls a fuse removes with no warning.
 */
function shiverBurst(alpha: number): Preset {
  const n = SHAKE_SWINGS;
  return {
    prepare(pose) {
      pose.opacity = alpha;
    },
    play(pose, ctx) {
      // Equal swings, alternating sides, each SHAKE_X/n shorter than the last so
      // the shiver dies out at center — then the hold, then the burst. The hold
      // only gets a keyframe when it lasts: two stops at the same time would
      // make Motion interpolate across a zero-length segment.
      const swings = Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 1) * SHAKE_X * (1 - i / (n - 1)));
      const stops = Array.from({ length: n + 1 }, (_, i) => (SHAKE_MS * i) / n);
      const ease: ("easeInOut" | "linear" | "easeOut")[] = Array.from({ length: n }, () => "easeInOut");
      const x = [0, ...swings];
      if (SHAKE_HOLD_MS > 0) {
        stops.push(SHAKE_MS + SHAKE_HOLD_MS);
        ease.push("linear");
        x.push(0);
      }
      const shrink = (t: number) => 1 - SHAKE_SHRINK * Math.min(1, t / SHAKE_MS);
      return animate(
        pose,
        {
          x: [...x, 0],
          scale: [...stops.map(shrink), BURST_SCALE],
          opacity: [...stops.map(() => alpha), 0],
        },
        {
          duration: (BURST_TOTAL_MS * slowFactor()) / 1000,
          delay: ctx.delay,
          times: [...stops, BURST_TOTAL_MS].map((t) => t / BURST_TOTAL_MS),
          ease: [...ease, "easeOut"],
        },
      );
    },
  };
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
  /** A removed cell, continuing the fade it already had as a resize ghost. */
  cellOut: shiverBurst(GHOST_ALPHA),
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
  /** A wall a fuse removes: the same shiver and burst, from full opacity. */
  explode: shiverBurst(1),
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
