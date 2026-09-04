"use client";

// The parts of the 3D scene that don't know which model is on the table:
// the view controls, the lights, the ground grid and the one-time camera pose.
// Both Viewer (gridfinity tray) and BoardViewer (SKÅDIS board) mount these.

import { useCallback, useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { getViewMapping, type MouseButton, type ViewAction } from "@/lib/viewMapping";

const ACTION_TO_MOUSE: Record<ViewAction, THREE.MOUSE | undefined> = {
  orbit: THREE.MOUSE.ROTATE,
  pan: THREE.MOUSE.PAN,
  zoom: THREE.MOUSE.DOLLY,
  none: undefined,
};

/** OrbitControls with a configurable button→action mapping (see lib/viewMapping). */
export function MappedControls({
  mappingId,
  initialTarget,
}: {
  mappingId: string;
  /** Orbit pivot at mount. Must be a stable object: re-applying one would snap the target. */
  initialTarget: THREE.Vector3;
}) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const scene = useThree((s) => s.scene);
  const mapping = getViewMapping(mappingId);

  const apply = useCallback(
    (e?: PointerEvent) => {
      const c = controlsRef.current;
      if (!c) return;
      const shift = e?.shiftKey ?? false;
      // OrbitControls itself swaps orbit<->pan whenever ctrl/meta/shift is held
      // on the pointer event. Pre-invert those two actions so that after its
      // swap, the button does exactly what the mapping says.
      const swapped = e ? e.ctrlKey || e.metaKey || e.shiftKey : false;
      const resolve = (b: MouseButton) => {
        let a = (shift ? mapping.shiftButtons?.[b] : undefined) ?? mapping.buttons[b];
        if (swapped && a === "orbit") a = "pan";
        else if (swapped && a === "pan") a = "orbit";
        return ACTION_TO_MOUSE[a];
      };
      c.mouseButtons.LEFT = resolve("left");
      c.mouseButtons.MIDDLE = resolve("middle");
      c.mouseButtons.RIGHT = resolve("right");
    },
    [mapping],
  );

  useEffect(() => {
    // The target is set once, imperatively (not as a prop), and then belongs
    // to the user's pans; a prop would re-apply on every re-render.
    const c = controlsRef.current;
    if (c) {
      c.target.copy(initialTarget);
      c.update();
    }
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__controls = c;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__scene = scene;
    }
  }, [initialTarget, scene]);

  useEffect(() => {
    apply();
    // The action is chosen when the drag starts, so resolve modifiers in a
    // capture-phase listener that runs before OrbitControls' own handler.
    const onPointerDown = (e: PointerEvent) => apply(e);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [apply]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableZoom={mapping.wheelZoom}
      // half the default momentum (0.05): keep the ease-out but subtle
      dampingFactor={0.1}
    />
  );
}

export interface CameraPose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

// The model's top-left corner is pinned to the world origin and it grows toward
// +x (columns) and +z (rows), so resizing never shifts what is already there.
/**
 * Three-quarter view framing a `w` × `d` mm footprint. Used once, at mount:
 * after that the camera is the user's alone — resizes happen in place, nothing
 * refits.
 */
export function perspectivePose(w: number, d: number): CameraPose {
  const extent = Math.max(w, d);
  return {
    pos: new THREE.Vector3(w / 2 + extent * 1.1, extent * 1.5, d / 2 + extent * 1.9),
    target: new THREE.Vector3(w / 2, 15, d / 2),
  };
}

export function groundPoint(ray: THREE.Ray, out: THREE.Vector3): THREE.Vector3 | null {
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = -ray.origin.y / ray.direction.y;
  if (t <= 0) return null;
  return out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
}

export function SceneLights() {
  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[150, 300, 200]} intensity={1.4} />
      <directionalLight position={[-200, 150, -100]} intensity={0.4} />
      <directionalLight position={[50, -200, 80]} intensity={0.5} />
    </>
  );
}

/**
 * The infinite ground grid. `section` is the model's own pitch so cell
 * boundaries land on the heavy lines (tray 42, board 40 — a slot pair).
 */
export function GroundGrid({ section, extent }: { section: number; extent: number }) {
  return (
    <Grid
      position={[0, -0.05, 0]}
      args={[10, 10]}
      cellSize={section / 2}
      cellThickness={0.4}
      cellColor="#2a2a2e"
      sectionSize={section}
      sectionThickness={0.8}
      sectionColor="#3d3d44"
      fadeDistance={Math.max(extent * 6, 1200)}
      infiniteGrid
    />
  );
}
