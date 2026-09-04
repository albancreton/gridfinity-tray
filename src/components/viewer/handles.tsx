"use client";

// The four edge handles that resize whatever is on the table. Written once and
// shared: everything model-specific is in the `GridMetrics` its owner passes —
// how wide a unit is, where unit 0 starts, how far the shape overhangs its
// outermost unit boundary, and which counts are allowed.
//
// With the tray's metrics this is arithmetically what the code did when it
// lived in Viewer.tsx; the board only differs in the numbers.

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, useLoader, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import resizeIcon from "../../../assets/resize.svg";
import type { Frame } from "@/lib/grid";
import { groundPoint } from "./scene";
import { at, clampCount, hi, lo, unitAt, type GridMetrics } from "@/lib/gridMetrics";
export type { GridMetrics };

const HANDLE_GAP = 12; // mm from the shape's edge to the icon center
const HANDLE_ICON = 16; // icon height in mm (the SVG's 24-unit viewBox maps to this)
const HANDLE_HIT_LONG = 36; // hit box extent along the edge the handle sits on
const HANDLE_HIT_SHORT = 20;
const HANDLE_HIT_H = 10;
const HANDLE_REST_SCALE = 0.5;
const HANDLE_REST_OPACITY = 0.5;
const HANDLE_REST_Y = 0.25; // just above the ground grid
const HANDLE_HOVER_Y = 3; // mm the icon lifts while hovered or dragged
const RESIZE_ICON_URL: string = resizeIcon.src;

/** Which edge a handle drags. */
export type Side = "left" | "right" | "top" | "bottom";
const SIDES: readonly Side[] = ["left", "right", "top", "bottom"];
/** Left/right edges move along x; top/bottom along z. */
const alongX = (side: Side) => side === "left" || side === "right";

const sameFrame = (a: Frame, b: Frame) =>
  a.c0 === b.c0 && a.r0 === b.r0 && a.c1 === b.c1 && a.r1 === b.r1;

/**
 * A pending footprint in unit coordinates of the world *as displayed*
 * (end-exclusive; the shape on screen always spans 0..cols × 0..rows). Dragging
 * the left/top edge makes c0/r0 negative (growing) or positive (shrinking).
 */
export interface ShadowState extends Frame {
  side: Side;
}

/**
 * resize.svg's two chevrons as one flat geometry: centred, `HANDLE_ICON` tall,
 * lying on the ground with SVG-down mapped to +z — the direction rows grow
 * (screen-down when looking from above), so the chevrons read the way the grid grows.
 */
function useResizeIconGeometry(): THREE.BufferGeometry {
  const { paths } = useLoader(SVGLoader, RESIZE_ICON_URL);
  const geometry = useMemo(() => {
    const parts = paths.flatMap((p) => p.toShapes().map((s) => new THREE.ShapeGeometry(s)));
    const merged = mergeGeometries(parts) ?? new THREE.BufferGeometry();
    parts.forEach((p) => p.dispose());
    const k = HANDLE_ICON / 24;
    merged.translate(-12, -12, 0).scale(k, k, 1).rotateX(Math.PI / 2);
    return merged;
  }, [paths]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/**
 * One handle's chevrons. At rest: half size, half opacity, on the ground. Hover:
 * full opacity and a small lift. In use (dragging): full size, and the other
 * handles fade out (`dimmed`). All ease over ~100ms in the frame loop; the
 * initial props are stable primitives so re-renders never snap them.
 */
function HandleIcon({
  side,
  hover,
  active,
  dimmed,
}: {
  side: Side;
  hover: boolean;
  active: boolean;
  dimmed: boolean;
}) {
  const geometry = useResizeIconGeometry();
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const targetScale = active ? 1 : HANDLE_REST_SCALE;
  const targetOpacity = dimmed ? 0 : hover || active ? 1 : HANDLE_REST_OPACITY;
  const targetY = hover || active ? HANDLE_HOVER_Y : HANDLE_REST_Y;
  useFrame((_, dt) => {
    const m = meshRef.current;
    const mat = matRef.current;
    if (!m || !mat) return;
    const k = 1 - Math.exp(-dt * 18);
    m.scale.setScalar(THREE.MathUtils.lerp(m.scale.x, targetScale, k));
    mat.opacity = THREE.MathUtils.lerp(mat.opacity, targetOpacity, k);
    m.position.y = THREE.MathUtils.lerp(m.position.y, targetY, k);
  });
  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      position-y={HANDLE_REST_Y}
      // spin so the double chevron points along the axis this edge moves on
      rotation-y={alongX(side) ? Math.PI / 2 : 0}
      scale={HANDLE_REST_SCALE}
      raycast={() => null}
      renderOrder={5}
    >
      <meshBasicMaterial
        ref={matRef}
        color="#e4e4e7"
        transparent
        opacity={HANDLE_REST_OPACITY}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

function Handle({
  x,
  z,
  side,
  active,
  dimmed,
  shapeRef,
  onDown,
}: {
  x: number;
  z: number;
  side: Side;
  active: boolean;
  /** Another handle is in use: fade out and stop taking the pointer. */
  dimmed: boolean;
  shapeRef: React.RefObject<THREE.Mesh | null>;
  onDown: (side: Side, e: ThreeEvent<PointerEvent>) => void;
}) {
  const [hover, setHover] = useState(false);
  const hx = alongX(side) ? HANDLE_HIT_SHORT : HANDLE_HIT_LONG;
  const hz = alongX(side) ? HANDLE_HIT_LONG : HANDLE_HIT_SHORT;
  // The model's mesh has no pointer handlers, so R3F raycasts straight through
  // it to the hit box: a handle hidden behind the shape would still hover and
  // grab clicks. Check the event's own ray against the mesh and ignore covered
  // hits (the click then falls through, as the user sees it).
  const covered = (e: ThreeEvent<PointerEvent>) => {
    const shape = shapeRef.current;
    if (!shape) return false;
    const first = new THREE.Raycaster(e.ray.origin, e.ray.direction).intersectObject(shape, false)[0];
    return first !== undefined && first.distance < e.distance;
  };
  return (
    <group position={[x, 0, z]}>
      {/* oversized invisible hit box so the flat icon is easy to grab */}
      <mesh
        position-y={HANDLE_HIT_H / 2}
        visible={!dimmed}
        onPointerDown={(e) => {
          if (!covered(e)) onDown(side, e);
        }}
        onPointerOver={(e) => {
          if (covered(e)) return;
          e.stopPropagation();
          setHover(true);
        }}
        onPointerMove={(e) => setHover(!covered(e))}
        onPointerOut={() => setHover(false)}
      >
        <boxGeometry args={[hx, HANDLE_HIT_H, hz]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Suspense fallback={null}>
        <HandleIcon side={side} hover={hover && !dimmed} active={active} dimmed={dimmed} />
      </Suspense>
    </group>
  );
}

/**
 * The strip a resize would **add**, in world mm. Only one edge moves per drag,
 * so what is new is a single band outside the current footprint: it runs from
 * the *old* shape's edge to the *new* one on the axis that moved, and spans the
 * new shape's full extent on the other. A shrink adds nothing.
 */
function addedStrip(
  f: Frame,
  cols: number,
  rows: number,
  m: GridMetrics,
): { x0: number; z0: number; x1: number; z1: number } | null {
  const x = { x0: lo(m, f.c0), x1: hi(m, f.c1) };
  const z = { z0: lo(m, f.r0), z1: hi(m, f.r1) };
  if (f.c1 > cols) return { ...z, x0: hi(m, cols), x1: hi(m, f.c1) };
  if (f.c0 < 0) return { ...z, x0: lo(m, f.c0), x1: lo(m, 0) };
  if (f.r1 > rows) return { ...x, z0: hi(m, rows), z1: hi(m, f.r1) };
  if (f.r0 < 0) return { ...x, z0: lo(m, f.r0), z1: lo(m, 0) };
  return null;
}

/**
 * The cells a resize would add, flat on the ground: a translucent fill, a line
 * per unit boundary inside it, plus the resulting size badge. Nothing is drawn
 * under what is already there. A shrink adds nothing, so only the badge shows;
 * what it removes is ghosted on the model's own mesh. Drawn without depth
 * testing, so the strip reads from any angle.
 */
function SizeGrid({
  c0,
  r0,
  c1,
  r1,
  cols,
  rows,
  metrics: m,
}: Frame & { cols: number; rows: number; metrics: GridMetrics }) {
  const { lines, box } = useMemo(() => {
    const b = addedStrip({ c0, r0, c1, r1 }, cols, rows, m);
    const pts: number[] = [];
    if (b) {
      // The strip's own border, plus every unit boundary strictly inside it.
      // Clamping to the border is what keeps the board's overhang clean: its
      // outermost boundary sits `pad` in from the edge, where a full-length
      // line would read as a seam rather than a division.
      const rule = (u0: number, u1: number, min: number, max: number) => {
        const out = [min, max];
        for (let u = Math.min(u0, u1); u <= Math.max(u0, u1); u++) {
          const v = at(m, u);
          if (v > min + 1e-6 && v < max - 1e-6) out.push(v);
        }
        return out;
      };
      for (const x of rule(c0, c1, b.x0, b.x1)) pts.push(x, 0, b.z0, x, 0, b.z1);
      for (const z of rule(r0, r1, b.z0, b.z1)) pts.push(b.x0, 0, z, b.x1, 0, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    return { lines: g, box: b };
  }, [c0, r0, c1, r1, cols, rows, m]);
  useEffect(() => () => lines.dispose(), [lines]);
  return (
    <group position={[0, 0.6, 0]}>
      {box && (
        <>
          <mesh
            position={[(box.x0 + box.x1) / 2, 0, (box.z0 + box.z1) / 2]}
            rotation={[-Math.PI / 2, 0, 0]}
            renderOrder={10}
          >
            <planeGeometry args={[box.x1 - box.x0, box.z1 - box.z0]} />
            <meshBasicMaterial
              color="#38bdf8"
              transparent
              opacity={0.14}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
          <lineSegments geometry={lines} renderOrder={11}>
            <lineBasicMaterial color="#7dd3fc" transparent opacity={0.8} depthTest={false} />
          </lineSegments>
        </>
      )}
      <Html
        position={[hi(m, c1) + 14, 0, hi(m, r1) + 14]}
        center
        style={{ pointerEvents: "none" }}
      >
        <div className="rounded-md bg-sky-500 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-white tabular-nums">
          {c1 - c0} × {r1 - r0}
        </div>
      </Html>
    </group>
  );
}

/**
 * Four resize handles, one per edge. Dragging one previews the new footprint as
 * a ground shadow from whatever view the user is in; releasing commits it in one
 * rebuild. The shape on screen always has its unit (0,0) at the world origin
 * (every layout re-anchors there), so after a left/top resize what survives
 * moves in world space when the new mesh lands — the camera is translated by the
 * same amount in that same commit, so nothing shifts on screen (the ground grid
 * is pitch-periodic, so it doesn't give it away either).
 */
export function ResizeHandles3D({
  cols,
  rows,
  metrics: m,
  geometry,
  shapeRef,
  shadow: visible,
  setShadow,
  onResize,
}: {
  cols: number;
  rows: number;
  metrics: GridMetrics;
  /** The displayed model; its identity marks when a resize's geometry has landed. */
  geometry: object;
  /** The visible mesh, so handles it covers ignore the pointer. */
  shapeRef: React.RefObject<THREE.Mesh | null>;
  /** The shadow currently shown (live, or committed and waiting); the viewer owns it. */
  shadow: ShadowState | null;
  setShadow: (s: ShadowState | null) => void;
  /** Commit a new footprint, in the current grid's unit coordinates. */
  onResize: (frame: Frame) => void;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  // Fetch controls lazily at event time (never from render) so we can toggle
  // `enabled` without fighting the hooks immutability rule or stale closures.
  const getState = useThree((s) => s.get);
  const detachRef = useRef<(() => void) | null>(null);
  // Camera translation (mm) owed once the rebuilt mesh lands: how far what
  // survives moves when the new origin takes over.
  const shiftRef = useRef({ x: 0, z: 0 });

  useEffect(() => () => detachRef.current?.(), []);

  // Layout effect: same commit as the geometry swap, before the next frame.
  useLayoutEffect(() => {
    const s = shiftRef.current;
    if (s.x === 0 && s.z === 0) return;
    const { camera: cam, controls } = getState();
    cam.position.x += s.x;
    cam.position.z += s.z;
    const c = controls as unknown as OrbitControlsImpl | null;
    if (c) {
      c.target.x += s.x;
      c.target.z += s.z;
    }
    s.x = 0;
    s.z = 0;
  }, [geometry, getState]);

  const beginDrag = (side: Side, e: ThreeEvent<PointerEvent>) => {
    if (detachRef.current || e.nativeEvent.button !== 0) return;
    e.stopPropagation();
    const start: Frame = { c0: 0, r0: 0, c1: cols, r1: rows };
    const frame: Frame = { ...start };
    const controls = getState().controls as unknown as OrbitControlsImpl | null;
    // Mappings that put orbit/pan on the left button must not also move the view.
    if (controls) controls.enabled = false;
    setShadow({ ...start, side });

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const dom = gl.domElement;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const rect = dom.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      if (!groundPoint(raycaster.ray, hit)) return;
      // Absolute mapping: the dragged edge snaps to the unit boundary nearest
      // the pointer's point on the ground plane, whatever the viewing angle.
      // The opposite edge stays put; the resulting count is snapped to the
      // model's allowed sizes (the board's must stay odd, so it moves by two).
      const u = unitAt(m, alongX(side) ? hit.x : hit.z);
      const next: Frame = { ...start };
      if (side === "right") next.c1 = clampCount(m, u);
      else if (side === "left") next.c0 = cols - clampCount(m, cols - u);
      else if (side === "bottom") next.r1 = clampCount(m, u);
      else next.r0 = rows - clampCount(m, rows - u);
      if (sameFrame(next, frame)) return;
      Object.assign(frame, next);
      setShadow({ ...next, side });
    };

    const finish = (commit: boolean) => {
      detach();
      if (controls) controls.enabled = true;
      // Both updates in one batch, so a single render swaps the grid, the
      // geometry and the leaving entities together. Deferring the commit by a
      // frame (which this used to do) leaves one painted frame showing the old
      // shape with the ghost already gone — what is about to be removed flashes
      // back to solid before the animation picks it up at `GHOST_ALPHA`.
      // Nothing is saved by splitting it: the work is the same, one frame later.
      // The layout effect above applies the camera shift in that same commit.
      setShadow(null);
      if (commit && !sameFrame(frame, start)) {
        shiftRef.current = { x: -frame.c0 * m.pitch, z: -frame.r0 * m.pitch };
        onResize(frame);
      }
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) finish(true);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    const detach = () => {
      detachRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
    };
    detachRef.current = detach;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
  };

  // Handles follow the shadow (still in the displayed world's frame after a
  // commit, until the new mesh lands) or hug the shape.
  const f: Frame = visible ?? { c0: 0, r0: 0, c1: cols, r1: rows };
  const x0 = lo(m, f.c0);
  const x1 = hi(m, f.c1);
  const z0 = lo(m, f.r0);
  const z1 = hi(m, f.r1);
  const anchor: Record<Side, [number, number]> = {
    left: [x0 - HANDLE_GAP, (z0 + z1) / 2],
    right: [x1 + HANDLE_GAP, (z0 + z1) / 2],
    top: [(x0 + x1) / 2, z0 - HANDLE_GAP],
    bottom: [(x0 + x1) / 2, z1 + HANDLE_GAP],
  };

  return (
    <group>
      {visible && (
        <SizeGrid
          c0={visible.c0}
          r0={visible.r0}
          c1={visible.c1}
          r1={visible.r1}
          cols={cols}
          rows={rows}
          metrics={m}
        />
      )}
      {SIDES.map((side) => (
        <Handle
          key={side}
          x={anchor[side][0]}
          z={anchor[side][1]}
          side={side}
          active={visible?.side === side}
          dimmed={visible !== null && visible.side !== side}
          shapeRef={shapeRef}
          onDown={beginDrag}
        />
      ))}
    </group>
  );
}
