"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useLoader, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid, Html, useCursor } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import resizeIcon from "../../assets/resize.svg";
import {
  BASE_H,
  CLEAR,
  LIP_H,
  PITCH,
  R_OUT,
  type MeshData,
  type Region,
  type TrayParams,
  type TraySpec,
} from "@/lib/protocol";
import { meshBounds, meshVolume, type TrayGeometry } from "@/lib/trayMesher";
import { mergeParts, type PartitionedTray, type TrayPart } from "@/lib/trayParts";
import { presets, restPose, type Playback, type Pose } from "@/lib/animPresets";
import { makeTransition, type EntityAnim, type Snapshot, type Transition } from "@/lib/transitions";
import { requestMesh } from "@/lib/cadClient";
import {
  type Frame,
  type GridState,
  MAX_UNITS,
  allRegions,
  boundingRect,
  canFuseSelection,
  canSplitSelection,
  expandSelection,
  fuse,
  regionAt,
  split,
} from "@/lib/grid";
import {
  DEFAULT_MAPPING_ID,
  getViewMapping,
  type MouseButton,
  type ViewAction,
} from "@/lib/viewMapping";
import { NOZZLE_LINE_W, type ViewSettings } from "@/lib/viewSettings";

const ACTION_TO_MOUSE: Record<ViewAction, THREE.MOUSE | undefined> = {
  orbit: THREE.MOUSE.ROTATE,
  pan: THREE.MOUSE.PAN,
  zoom: THREE.MOUSE.DOLLY,
  none: undefined,
};

/** OrbitControls with a configurable button→action mapping (see lib/viewMapping). */
function MappedControls({
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

/** Top of the walls, lip included — the worker's `topZ`; keep in sync with cad.worker.ts. */
function trayTopY(params: TrayParams): number {
  return Math.max(params.heightMm, BASE_H + 1) + (params.lip ? LIP_H : 0);
}

interface CameraPose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

// The tray's top-left cell corner is pinned to the world origin and the grid
// grows toward +x (columns) and +z (rows), so resizing never shifts what is
// already there.
/**
 * Three-quarter view framing a cols×rows tray. Used once, at mount: after that
 * the camera is the user's alone — resizes happen in place, nothing refits.
 */
function perspectivePose(cols: number, rows: number): CameraPose {
  const w = cols * PITCH;
  const d = rows * PITCH;
  const extent = Math.max(w, d);
  return {
    pos: new THREE.Vector3(w / 2 + extent * 1.1, extent * 1.5, d / 2 + extent * 1.9),
    target: new THREE.Vector3(w / 2, 15, d / 2),
  };
}

function groundPoint(ray: THREE.Ray, out: THREE.Vector3): THREE.Vector3 | null {
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = -ray.origin.y / ray.direction.y;
  if (t <= 0) return null;
  return out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
}

// --- 3D resize handles -------------------------------------------------------

const HANDLE_GAP = 12; // mm from tray edge to icon center
const HANDLE_ICON = 16; // icon height in mm (the SVG's 24-unit viewBox maps to this)
const HANDLE_HIT_LONG = 36; // hit box extent along the edge the handle sits on
const HANDLE_HIT_SHORT = 20;
const HANDLE_HIT_H = 10;
const HANDLE_REST_SCALE = 0.5;
const HANDLE_REST_OPACITY = 0.5;
const HANDLE_REST_Y = 0.25; // just above the ground grid
const HANDLE_HOVER_Y = 3; // mm the icon lifts while hovered or dragged
const RESIZE_ICON_URL: string = resizeIcon.src;

/** Which tray edge a handle drags. */
type Side = "left" | "right" | "top" | "bottom";
const SIDES: readonly Side[] = ["left", "right", "top", "bottom"];
/** Left/right edges move along x; top/bottom along z. */
const alongX = (side: Side) => side === "left" || side === "right";

const sameFrame = (a: Frame, b: Frame) =>
  a.c0 === b.c0 && a.r0 === b.r0 && a.c1 === b.c1 && a.r1 === b.r1;

/**
 * A pending footprint in unit coordinates of the world *as displayed*
 * (end-exclusive; the tray on screen always spans 0..cols × 0..rows). Dragging
 * the left/top edge makes c0/r0 negative (growing) or positive (shrinking).
 */
interface ShadowState extends Frame {
  side: Side;
}

/**
 * resize.svg's two chevrons as one flat geometry: centred, `HANDLE_ICON` tall,
 * lying on the ground with SVG-down mapped to +z — the direction rows grow
 * (screen-down when looking from above), so the chevrons read the way the tray grows.
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
  trayRef,
  onDown,
}: {
  x: number;
  z: number;
  side: Side;
  active: boolean;
  /** Another handle is in use: fade out and stop taking the pointer. */
  dimmed: boolean;
  trayRef: React.RefObject<THREE.Mesh | null>;
  onDown: (side: Side, e: ThreeEvent<PointerEvent>) => void;
}) {
  const [hover, setHover] = useState(false);
  const hx = alongX(side) ? HANDLE_HIT_SHORT : HANDLE_HIT_LONG;
  const hz = alongX(side) ? HANDLE_HIT_LONG : HANDLE_HIT_SHORT;
  // The tray mesh has no pointer handlers, so R3F raycasts straight through it
  // to the hit box: a handle hidden behind the tray would still hover and grab
  // clicks. Check the event's own ray against the tray and ignore covered hits
  // (the click then falls through to the cell selector, as the user sees it).
  const covered = (e: ThreeEvent<PointerEvent>) => {
    const tray = trayRef.current;
    if (!tray) return false;
    const first = new THREE.Raycaster(e.ray.origin, e.ray.direction).intersectObject(tray, false)[0];
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
 * Ghost footprint of the pending size — fill + unit gridlines + size badge —
 * floating at the top of the walls (`y`), where it reads as the tray's new
 * outline rather than a mark on the ground.
 */
/**
 * The pending footprint, flat on the ground: a translucent fill, a line per
 * unit boundary and the size badge. Drawn without depth testing so it reads
 * through the tray from any angle. Restored Sept 2026 in place of the
 * wall-top shadow and the half-coverage preview of the future tray.
 */
function SizeGrid({ c0, r0, c1, r1 }: Frame) {
  const x0 = c0 * PITCH;
  const x1 = c1 * PITCH;
  const z0 = r0 * PITCH;
  const z1 = r1 * PITCH;
  const lines = useMemo(() => {
    const pts: number[] = [];
    for (let c = c0; c <= c1; c++) pts.push(c * PITCH, 0, z0, c * PITCH, 0, z1);
    for (let r = r0; r <= r1; r++) pts.push(x0, 0, r * PITCH, x1, 0, r * PITCH);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, [c0, r0, c1, r1, x0, x1, z0, z1]);
  useEffect(() => () => lines.dispose(), [lines]);
  return (
    <group position={[0, 0.6, 0]}>
      <mesh
        position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={10}
      >
        <planeGeometry args={[x1 - x0, z1 - z0]} />
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
      <Html position={[x1 + 14, 0, z1 + 14]} center style={{ pointerEvents: "none" }}>
        <div className="rounded-md bg-sky-500 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-white tabular-nums">
          {c1 - c0} × {r1 - r0}
        </div>
      </Html>
    </group>
  );
}

/**
 * Four grid-resize handles, one per tray edge. Dragging one previews the new
 * footprint as a ground shadow from whatever view the user is in; releasing
 * commits it in one rebuild. The tray on screen always has its cell (0,0) at
 * the world origin (the worker re-anchors there), so after a left/top resize
 * the surviving cells move in world space when the new mesh lands — the camera
 * is translated by the same amount in that same commit, so nothing shifts on
 * screen (the ground grid is 42mm-periodic, so it doesn't give it away either).
 */
function ResizeHandles3D({
  cols,
  rows,
  geometry,
  trayRef,
  shadow: visible,
  setShadow,
  onResize,
}: {
  cols: number;
  rows: number;
  /** The displayed tray; its identity marks when a resize's geometry has landed. */
  geometry: TrayGeometry;
  /** The visible tray mesh, so handles it covers ignore the pointer. */
  trayRef: React.RefObject<THREE.Mesh | null>;
  /** The shadow currently shown (live, or committed and waiting); Viewer owns it. */
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
  // Camera translation (mm) owed once the rebuilt mesh lands: how far the
  // surviving cells move when the new origin takes over.
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
    const { clamp } = THREE.MathUtils;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const rect = dom.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      if (!groundPoint(raycaster.ray, hit)) return;
      // Absolute mapping: the dragged edge snaps to the grid line nearest the
      // pointer's point on the ground plane, whatever the viewing angle. The
      // opposite edge stays put and the size is kept within 1..MAX_UNITS.
      const u = Math.round((alongX(side) ? hit.x : hit.z) / PITCH);
      const next: Frame = { ...start };
      if (side === "right") next.c1 = clamp(u, 1, MAX_UNITS);
      else if (side === "left") next.c0 = clamp(u, cols - MAX_UNITS, cols - 1);
      else if (side === "bottom") next.r1 = clamp(u, 1, MAX_UNITS);
      else next.r0 = clamp(u, rows - MAX_UNITS, rows - 1);
      if (sameFrame(next, frame)) return;
      Object.assign(frame, next);
      setShadow({ ...next, side });
    };

    const finish = (commit: boolean) => {
      detach();
      if (controls) controls.enabled = true;
      // The grid goes first, on its own frame; the commit (re-mesh, partition,
      // entity meshes) follows on the next one, so the two never share a frame. The layout effect above applies the camera shift in the
      // commit that swaps the geometry.
      setShadow(null);
      if (commit && !sameFrame(frame, start)) {
        shiftRef.current = { x: -frame.c0 * PITCH, z: -frame.r0 * PITCH };
        requestAnimationFrame(() => onResize(frame));
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
  // commit, until the new mesh lands) or hug the tray.
  const f: Frame = visible ?? { c0: 0, r0: 0, c1: cols, r1: rows };
  const x0 = f.c0 * PITCH;
  const x1 = f.c1 * PITCH;
  const z0 = f.r0 * PITCH;
  const z1 = f.r1 * PITCH;
  const at: Record<Side, [number, number]> = {
    left: [x0 - HANDLE_GAP, (z0 + z1) / 2],
    right: [x1 + HANDLE_GAP, (z0 + z1) / 2],
    top: [(x0 + x1) / 2, z0 - HANDLE_GAP],
    bottom: [(x0 + x1) / 2, z1 + HANDLE_GAP],
  };

  return (
    <group>
      {visible && (
        <SizeGrid c0={visible.c0} r0={visible.r0} c1={visible.c1} r1={visible.r1} />
      )}
      {SIDES.map((side) => (
        <Handle
          key={side}
          x={at[side][0]}
          z={at[side][1]}
          side={side}
          active={visible?.side === side}
          dimmed={visible !== null && visible.side !== side}
          trayRef={trayRef}
          onDown={beginDrag}
        />
      ))}
    </group>
  );
}

// --- 3D cell selection -------------------------------------------------------

/**
 * Drag-select cells on the tray with the left button (only while the active
 * view mapping leaves it free), with spreadsheet-style selection semantics.
 * Picking raycasts the visible tray mesh first — so clicks on tall walls land
 * where the user points — and falls back to the ground plane off the tray.
 */
function CellSelector({
  grid,
  selection,
  trayRef,
  mappingId,
  onSelect,
  onRelease,
}: {
  grid: GridState;
  selection: Region | null;
  trayRef: React.RefObject<THREE.Mesh | null>;
  mappingId: string;
  onSelect: (sel: Region | null) => void;
  /** Drag released: (x, y) is where the popup should appear, in canvas coords. */
  onRelease: (x: number, y: number) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const detachRef = useRef<(() => void) | null>(null);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  useCursor(hover || dragging, "crosshair");

  useEffect(() => () => detachRef.current?.(), []);

  // Escape drops a standing selection (an in-progress drag has its own listener).
  useEffect(() => {
    if (!selection) return;
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selection, onSelect]);

  const w = grid.cols * PITCH;
  const d = grid.rows * PITCH;

  const cellAt = (p: THREE.Vector3) => ({
    r: Math.max(0, Math.min(grid.rows - 1, Math.floor(p.z / PITCH))),
    c: Math.max(0, Math.min(grid.cols - 1, Math.floor(p.x / PITCH))),
  });

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (detachRef.current || e.nativeEvent.button !== 0) return;
    const mapping = getViewMapping(mappingId);
    const leftAction =
      (e.nativeEvent.shiftKey ? mapping.shiftButtons?.left : undefined) ?? mapping.buttons.left;
    if (leftAction !== "none") return;

    const raycaster = new THREE.Raycaster();
    const pick = (out: THREE.Vector3): boolean => {
      const tray = trayRef.current;
      if (tray) {
        const hits = raycaster.intersectObject(tray, false);
        if (hits.length > 0) {
          out.copy(hits[0].point);
          return true;
        }
      }
      return groundPoint(raycaster.ray, out) !== null;
    };

    raycaster.ray.copy(e.ray);
    const p = new THREE.Vector3();
    if (!pick(p)) return;
    // Clicks just outside the footprint still grab the nearest edge cell;
    // anything farther out clears the selection instead.
    const pad = PITCH * 0.6;
    if (p.x < -pad || p.x > w + pad || p.z < -pad || p.z > d + pad) {
      onSelect(null);
      return;
    }
    e.stopPropagation();

    const start = cellAt(p);
    const anchor = regionAt(grid, start.r, start.c);
    // A press on an already selected cell is a click-to-deselect unless the
    // pointer leaves that cell, in which case it becomes a fresh drag. Until
    // then `last` stays null and the standing selection is left untouched.
    const inside =
      selection !== null &&
      start.r >= selection.r0 &&
      start.r <= selection.r1 &&
      start.c >= selection.c0 &&
      start.c <= selection.c1;
    let last: Region | null = null;
    if (!inside) {
      last = expandSelection(grid, anchor);
      onSelect(last);
    }
    setDragging(true);

    const dom = gl.domElement;
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const rect = dom.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      if (!pick(hit)) return;
      const pos = cellAt(hit);
      if (last === null && pos.r === start.r && pos.c === start.c) return;
      const next = expandSelection(
        grid,
        boundingRect(anchor, { r0: pos.r, c0: pos.c, r1: pos.r, c1: pos.c }),
      );
      if (
        last === null ||
        next.r0 !== last.r0 ||
        next.c0 !== last.c0 ||
        next.r1 !== last.r1 ||
        next.c1 !== last.c1
      ) {
        last = next;
        onSelect(next);
      }
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      detach();
      if (last === null) {
        // Click on an already selected cell: deselect, which also closes the popup.
        onSelect(null);
        return;
      }
      // Anchor the popup above the cursor, clamped so it stays on the canvas.
      const rect = dom.getBoundingClientRect();
      onRelease(
        Math.min(Math.max(ev.clientX - rect.left, 76), rect.width - 76),
        Math.min(Math.max(ev.clientY - rect.top, 60), rect.height - 8),
      );
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        detach();
        onSelect(null);
      }
    };
    const detach = () => {
      detachRef.current = null;
      setDragging(false);
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

  return (
    <group>
      {/* invisible catch-all plane: starts selections near the tray, clears them elsewhere */}
      <mesh
        position={[0, -0.02, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={onDown}
        onPointerMove={(e) => {
          const inside = e.point.x >= 0 && e.point.x <= w && e.point.z >= 0 && e.point.z <= d;
          setHover((h) => (h === inside ? h : inside));
        }}
        onPointerOut={() => setHover(false)}
      >
        <planeGeometry args={[9000, 9000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Cell → compartment lookup for the printed-look shader (RGBA8 = c0, r0, c1, r1). */
function makeRegionTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    new Uint8Array(MAX_UNITS * MAX_UNITS * 4),
    MAX_UNITS,
    MAX_UNITS,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The tray surface: a standard material with two shader patches (compiled once;
 * everything dynamic goes through uniforms mutated in effects).
 *
 * Selection tint — lights the inside of the selected compartments by recoloring
 * the tray's own fragments: everything within the selection's world box is
 * tinted, except horizontal top-rim faces and the outer shell (fragments near
 * the box boundary whose normal points outward — margin 4.3 covers the outer
 * corner radius 3.75 + clearance). The box floor sits just under the pocket
 * floor so the feet keep the base color.
 *
 * Printed look — an analytic FDM height field bumps the normal per fragment:
 * layer beads stacked along world y (print height; the bed is y=0) on walls and
 * chamfers, diagonal top-fill beads on up/down-facing faces, blended by |n.y|.
 * Each pattern fades out once its period spans under ~2px so zooming out
 * returns to the flat look instead of moiré. Geometry is untouched (OCC emits
 * two triangles per flat face), so this must stay per-fragment.
 */
/** `STANDARD` is MeshStandardMaterial's own define; replacing `defines` must keep it. */
const REVEAL_DEFINES = { STANDARD: "", TRAY_REVEAL: "" };

function TrayMesh({
  geometry: tray,
  sel,
  grid,
  params,
  view,
  ghost,
  ghostAlpha = 0.25,
  pose,
  origin,
  revealable = false,
  pickRef,
}: {
  /** Live animation pose (lib/animPresets), applied every frame: transform about the group origin, opacity, reveal. */
  pose?: React.RefObject<Pose>;
  /** Compile the double-sided, reveal-clipping shader variant (entities printing in). The static tray stays front-face-only with no discard. */
  revealable?: boolean;
  /** Tray-local position of this geometry's origin, so the print pattern stays aligned when the geometry was re-based (entities pivot at their center). */
  origin?: [number, number, number];
  /** Procedural preview geometry, already in the world frame (lib/trayMesher). */
  geometry: TrayGeometry;
  sel: Region | null;
  /** Compartment layout — the printed look derives its perimeter loops from it. */
  grid: GridState;
  params: TrayParams;
  view: ViewSettings;
  /** Resize footprint (displayed-world units): fragments outside it fade to `ghostAlpha` — the part a shrink removes. */
  ghost: Frame | null;
  ghostAlpha?: number;
  pickRef?: React.Ref<THREE.Mesh>;
}) {
  const uniforms = useRef({
    uSelMin: { value: new THREE.Vector3() },
    uSelMax: { value: new THREE.Vector3() },
    uSelActive: { value: 0 },
    uGhostOn: { value: 0 },
    /** Ghost box in world xz; fragments outside it fade to `uGhostAlpha`. */
    uGhostMin: { value: new THREE.Vector2() },
    uGhostMax: { value: new THREE.Vector2() },
    uGhostAlpha: { value: 0.25 },
    /** Fraction of the tray height that exists yet (the print-in reveal); 1 = whole. */
    uReveal: { value: 1 },
    /** Height a fully revealed tray reaches (a hair above the rim). */
    uAnimTop: { value: 0 },
    /** Tray-local origin of this geometry (entities are re-based at their center). */
    uLocalOrigin: { value: new THREE.Vector3() },
    uPrint: { value: 0 },
    uLayerH: { value: 0.2 },
    uLineW: { value: NOZZLE_LINE_W },
    uFillAngle: { value: Math.PI / 4 },
    /** Bead relief as a fraction of its period; drives the normal tilt. */
    uRelief: { value: 0.22 },
    /** How much darker a seam gets than a bead crest. */
    uSeamShade: { value: 0.28 },
    /** 12×12 cell → compartment rect (c0, r0, c1, r1) as bytes; see the grid effect. */
    uRegions: { value: makeRegionTexture() },
    uGrid: { value: new THREE.Vector2(1, 1) },
    uWall: { value: 1.2 },
    /** Perimeter loops drawn around each flat top region before the fill starts. */
    uPerims: { value: 2 },
  });
  useEffect(() => {
    const regions = uniforms.current.uRegions.value;
    return () => regions.dispose();
  }, []);

  useEffect(() => {
    const u = uniforms.current;
    u.uGhostOn.value = ghost ? 1 : 0;
    u.uGhostAlpha.value = ghostAlpha;
    if (!ghost) return;
    // Interior walls straddle the grid line by wall/2: keep the one that
    // becomes the new outer wall solid, so the kept part reads as a whole tray.
    const m = params.wall / 2;
    u.uGhostMin.value.set(ghost.c0 * PITCH - m, ghost.r0 * PITCH - m);
    u.uGhostMax.value.set(ghost.c1 * PITCH + m, ghost.r1 * PITCH + m);
  }, [ghost, ghostAlpha, params.wall]);

  useEffect(() => {
    uniforms.current.uAnimTop.value = trayTopY(params) + 0.5;
  }, [params]);
  useEffect(() => {
    const o = origin ?? [0, 0, 0];
    uniforms.current.uLocalOrigin.value.set(o[0], o[1], o[2]);
  }, [origin]);

  // Play the pose, if any: transform about the group origin, fade, reveal.
  const groupRef = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const lineMaterialRef = useRef<THREE.LineBasicMaterial>(null);
  useFrame(() => {
    const p = pose?.current;
    if (!p) return;
    const g = groupRef.current;
    if (g) {
      g.position.set(p.x, p.y, p.z);
      g.rotation.set(p.rx, p.ry, p.rz);
      g.scale.setScalar(p.scale);
    }
    if (materialRef.current) materialRef.current.opacity = p.opacity;
    if (lineMaterialRef.current) lineMaterialRef.current.opacity = 0.4 * p.opacity;
    uniforms.current.uReveal.value = p.reveal;
  });

  useEffect(() => {
    const u = uniforms.current;
    const data = u.uRegions.value.image.data as Uint8Array;
    data.fill(0);
    for (const reg of allRegions(grid)) {
      for (let r = reg.r0; r <= reg.r1; r++) {
        for (let c = reg.c0; c <= reg.c1; c++) {
          const i = (r * MAX_UNITS + c) * 4;
          data[i] = reg.c0;
          data[i + 1] = reg.r0;
          data[i + 2] = reg.c1;
          data[i + 3] = reg.r1;
        }
      }
    }
    u.uRegions.value.needsUpdate = true;
    u.uGrid.value.set(grid.cols, grid.rows);
    u.uWall.value = params.wall;
  }, [grid, params.wall]);

  useEffect(() => {
    const u = uniforms.current;
    if (!sel) {
      u.uSelActive.value = 0;
      return;
    }
    // Mirror the worker's vertical layout (cad.worker.ts buildTray).
    const topZ = trayTopY(params);
    const floorZ = Math.min(BASE_H + Math.max(params.floor, 0), topZ - 0.5);
    const topFaceY = Math.max(topZ - 0.8, floorZ + 0.6);
    u.uSelMin.value.set(sel.c0 * PITCH, floorZ - 0.4, sel.r0 * PITCH);
    u.uSelMax.value.set((sel.c1 + 1) * PITCH, topFaceY, (sel.r1 + 1) * PITCH);
    u.uSelActive.value = 1;
  }, [sel, params]);

  useEffect(() => {
    const u = uniforms.current;
    u.uPrint.value = view.printLook ? 1 : 0;
    u.uLayerH.value = Math.max(view.layerHeight, 0.04);
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__printUniforms = u;
    }
  }, [view]);

  const onBeforeCompile = useCallback(
    (shader: Parameters<THREE.MeshStandardMaterial["onBeforeCompile"]>[0]) => {
      Object.assign(shader.uniforms, uniforms.current);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vLocalPos;\nvarying vec3 vWorldNormal;\nuniform vec3 uLocalOrigin;",
        )
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\n" +
            "vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n" +
            // Tray-local = the tray's cell (0,0) at the origin; the layout-dependent
            // print pattern uses it so translated previews and re-based entities stay aligned.
            "vLocalPos = transformed + uLocalOrigin;\n" +
            "vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vWorldPos;
varying vec3 vLocalPos;
uniform float uGhostOn;
uniform vec2 uGhostMin;
uniform vec2 uGhostMax;
uniform float uGhostAlpha;
uniform float uReveal;
uniform float uAnimTop;
varying vec3 vWorldNormal;
uniform vec3 uSelMin;
uniform vec3 uSelMax;
uniform float uSelActive;
uniform float uPrint;
uniform float uLayerH;
uniform float uLineW;
uniform float uFillAngle;
uniform float uRelief;
uniform float uSeamShade;
uniform sampler2D uRegions;
uniform vec2 uGrid;
uniform float uWall;
uniform float uPerims;
#define FDM_PITCH ${PITCH}.0
#define FDM_CLEAR ${CLEAR}
#define FDM_ROUT ${R_OUT}
// Signed distance to the rounded rectangle [a,b] (corner radius r), and its gradient.
float sdRoundRect(vec2 p, vec2 a, vec2 b, float r, out vec2 grad) {
  vec2 d = p - 0.5 * (a + b);
  vec2 q = abs(d) - (0.5 * (b - a) - vec2(r));
  vec2 s = vec2(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0);
  if (q.x > 0.0 && q.y > 0.0) {
    float l = length(q);
    grad = s * q / max(l, 1e-6);
    return l - r;
  }
  if (q.x > q.y) { grad = vec2(s.x, 0.0); return q.x - r; }
  grad = vec2(0.0, s.y);
  return q.y - r;
}
// Pocket outline of the compartment covering the given grid cell — mirrors the
// pocket rect + corner radius in cad.worker.ts buildTray; keep them in sync.
void pocketRect(ivec2 cell, out vec2 a, out vec2 b, out float r) {
  vec4 reg = floor(texelFetch(uRegions, cell, 0) * 255.0 + 0.5); // c0, r0, c1, r1
  float hw = 0.5 * uWall;
  float edge = FDM_CLEAR + uWall;
  a = vec2(FDM_PITCH * reg.x + (reg.x == 0.0 ? edge : hw),
           FDM_PITCH * reg.y + (reg.y == 0.0 ? edge : hw));
  b = vec2(FDM_PITCH * (reg.z + 1.0) - (reg.z == uGrid.x - 1.0 ? edge : hw),
           FDM_PITCH * (reg.w + 1.0) - (reg.w == uGrid.y - 1.0 ? edge : hw));
  vec2 size = b - a;
  r = max(0.4, min(min(FDM_ROUT - uWall, 0.5 * size.x - 0.1), 0.5 * size.y - 0.1));
}
// Distance from an up-facing fragment (world xz) to the nearest edge of the flat
// region it sits on — a pocket outline or the tray's outer outline — and the
// in-plane direction pointing away from that edge. Checks the fragment's cell
// and the three neighbours toward the nearest grid corner, which covers every
// wall top and junction.
float topEdgeDist(vec2 p, out vec2 away) {
  vec2 cellF = clamp(floor(p / FDM_PITCH), vec2(0.0), uGrid - 1.0);
  vec2 f = p / FDM_PITCH - cellF;
  vec2 nb = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
  float best = 1e9;
  away = vec2(1.0, 0.0);
  for (int i = 0; i < 4; i++) {
    vec2 cf = clamp(cellF + vec2(float(i & 1), float(i >> 1)) * nb, vec2(0.0), uGrid - 1.0);
    vec2 a, b, g;
    float r;
    pocketRect(ivec2(cf), a, b, r);
    float sd = sdRoundRect(p, a, b, r, g);
    float d = abs(sd);
    if (d < best) { best = d; away = sd < 0.0 ? -g : g; }
  }
  vec2 g;
  float dOut = -sdRoundRect(p, vec2(FDM_CLEAR), uGrid * FDM_PITCH - FDM_CLEAR, FDM_ROUT, g);
  if (dOut < best) { best = dOut; away = -g; }
  return best;
}
// Bead cross-section over one period, u in [-1,1] (crest at 0, seams at ±1):
// a half-disc up close, morphing (s→1) into a pure cosine as the period
// shrinks on screen — the disc's seam harmonics alias long before its period.
float fdmProfile(float u, float s) {
  float disc = sqrt(max(1.0 - u * u, 0.0));
  float cosb = 0.5 + 0.5 * cos(PI * u);
  return mix(disc, cosb, s);
}
// Slope per unit u; the disc's is clamped where it goes vertical at the seams.
float fdmSlope(float u, float s) {
  float disc = -u / max(sqrt(max(1.0 - u * u, 0.0)), 0.25);
  float cosb = -0.5 * PI * sin(PI * u);
  return mix(disc, cosb, s);
}
float fdmMean(float s) { return mix(0.785, 0.5, s); }
float fdmHash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }`,
        )
        .replace(
          "vec4 diffuseColor = vec4( diffuse, opacity );",
          `vec4 diffuseColor = vec4( diffuse, opacity );
#ifdef TRAY_REVEAL
// Revealable variant (entities printing in): double-sided so the cut shows the
// wall's inside, back faces dropped once whole, fragments above the progress
// height dropped. The static tray compiles without this block — no discard at
// all keeps early depth testing, which matters on a retina-sized canvas.
if (!gl_FrontFacing && uReveal >= 1.0) discard;
if (uReveal < 1.0 && vLocalPos.y >= uReveal * uAnimTop) discard;
#endif
if (uGhostOn > 0.5) {
  bool outsideGhost = vWorldPos.x < uGhostMin.x || vWorldPos.x > uGhostMax.x ||
    vWorldPos.z < uGhostMin.y || vWorldPos.z > uGhostMax.y;
  // Partial alpha is partial MSAA coverage; no discard needed.
  if (outsideGhost) diffuseColor.a *= uGhostAlpha;
}
if (uSelActive > 0.5) {
  vec3 n = normalize(vWorldNormal);
  bool inBox = vWorldPos.x > uSelMin.x && vWorldPos.x < uSelMax.x &&
    vWorldPos.z > uSelMin.z && vWorldPos.z < uSelMax.z && vWorldPos.y > uSelMin.y;
  bool topFace = n.y > 0.9 && vWorldPos.y > uSelMax.y;
  bool outerX = abs(n.x) > 0.55 &&
    ((vWorldPos.x < uSelMin.x + 4.3 && n.x < 0.0) || (vWorldPos.x > uSelMax.x - 4.3 && n.x > 0.0));
  bool outerZ = abs(n.z) > 0.55 &&
    ((vWorldPos.z < uSelMin.z + 4.3 && n.z < 0.0) || (vWorldPos.z > uSelMax.z - 4.3 && n.z > 0.0));
  if (inBox && !topFace && !outerX && !outerZ && n.y > -0.5) {
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.28, 0.39, 0.58), 0.92);
  }
}`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
if (uPrint > 0.5) {
  // Back faces show inside a cell that is still printing in; flip to shade them.
  vec3 nw = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  // Layers repeat along world y; top fill repeats along the fill direction in xz.
  float ly = vWorldPos.y / uLayerH;
  // Top pattern: uPerims loops hugging the region's edge, diagonal fill inside.
  // Only up-facing fragments pay for the distance field (feet bottoms get fill).
  vec2 dir = vec2(cos(uFillAngle), sin(uFillAngle));
  vec2 away = dir;
  float dEdge = 1e9;
  if (nw.y > 0.5) dEdge = topEdgeDist(vLocalPos.xz, away);
  bool perim = dEdge < uPerims * uLineW;
  vec2 tdir = perim ? away : dir;
  float ls = (perim ? dEdge : dot(vLocalPos.xz, dir)) / uLineW;
  float uy = 2.0 * fract(ly) - 1.0;
  float us = 2.0 * fract(ls) - 1.0;
  // Screen footprint of each pattern in periods per pixel: soften the profile
  // to a cosine from ~12px/period down, fade it out entirely by ~1.7px/period.
  float fwY = fwidth(ly);
  float fwS = fwidth(ls);
  float sY = smoothstep(0.08, 0.3, fwY);
  float sS = smoothstep(0.08, 0.3, fwS);
  float aaY = 1.0 - smoothstep(0.35, 0.6, fwY);
  float aaS = 1.0 - smoothstep(0.35, 0.6, fwS);
  float wTop = smoothstep(0.7, 0.95, abs(nw.y));
  // World-space gradient of the height field: relief = uRelief·period and
  // d(bead)/d(world) = slope(u)·2/period, so the period cancels out.
  float k = 2.0 * uRelief;
  vec3 gY = vec3(0.0, fdmSlope(uy, sY) * k * aaY, 0.0);
  vec3 gS = vec3(tdir.x, 0.0, tdir.y) * (fdmSlope(us, sS) * k * aaS);
  vec3 g = mix(gY, gS, wTop);
  vec3 np = normalize(nw - (g - nw * dot(nw, g)));
  normal = normalize((viewMatrix * vec4(np, 0.0)).xyz);
  // Seams sit in shadow; a touch of per-layer variation breaks the regularity.
  float hY = mix(fdmMean(sY), fdmProfile(uy, sY), aaY);
  float hS = mix(fdmMean(sS), fdmProfile(us, sS), aaS);
  float h = mix(hY, hS, wTop);
  float layerVar = (fdmHash(floor(ly)) - 0.5) * 0.08 * aaY * (1.0 - wTop);
  diffuseColor.rgb *= (1.0 - uSeamShade * (1.0 - h)) * (1.0 + layerVar);
}`,
        );
    },
    [],
  );

  const onBeforeCompileEdges = useCallback(
    (shader: Parameters<THREE.LineBasicMaterial["onBeforeCompile"]>[0]) => {
      const u = uniforms.current;
      Object.assign(shader.uniforms, {
        uGhostOn: u.uGhostOn,
        uGhostMin: u.uGhostMin,
        uGhostMax: u.uGhostMax,
        uGhostAlpha: u.uGhostAlpha,
        uReveal: u.uReveal,
        uAnimTop: u.uAnimTop,
        uLocalOrigin: u.uLocalOrigin,
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vLocalPos;\nuniform vec3 uLocalOrigin;",
        )
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvLocalPos = transformed + uLocalOrigin;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vWorldPos;
varying vec3 vLocalPos;
uniform float uGhostOn;
uniform vec2 uGhostMin;
uniform vec2 uGhostMax;
uniform float uGhostAlpha;
uniform float uReveal;
uniform float uAnimTop;`,
        )
        .replace(
          "vec4 diffuseColor = vec4( diffuse, opacity );",
          `vec4 diffuseColor = vec4( diffuse, opacity );
if (uGhostOn > 0.5) {
  bool outsideGhost = vWorldPos.x < uGhostMin.x || vWorldPos.x > uGhostMax.x ||
    vWorldPos.z < uGhostMin.y || vWorldPos.z > uGhostMax.y;
  if (outsideGhost) diffuseColor.a *= uGhostAlpha;
}
if (uReveal < 1.0 && vLocalPos.y >= uReveal * uAnimTop) discard;`,
        );
    },
    [],
  );

  // The mesher already emits flat-shaded, non-indexed triangles in the world
  // frame (x cols, y up, z rows), so the geometry is uploaded as is.
  const { geometry, edgeGeometry } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(tray.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(tray.normals, 3));
    const e = new THREE.BufferGeometry();
    e.setAttribute("position", new THREE.BufferAttribute(tray.edges, 3));
    return { geometry: g, edgeGeometry: e };
  }, [tray]);
  // Geometries handed in as props aren't auto-disposed by R3F when they change.
  useEffect(
    () => () => {
      geometry.dispose();
      edgeGeometry.dispose();
    },
    [geometry, edgeGeometry],
  );

  return (
    <group ref={groupRef}>
      <mesh ref={pickRef} geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          ref={materialRef}
          color="#59B9BA"
          roughness={0.55}
          metalness={0.05}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
          // The ghost alpha (and a pose's opacity) goes through MSAA coverage,
          // not blending: the material stays opaque (depth-sorted, no
          // self-overlap artifacts) and the multisampled canvas resolves partial
          // coverage to a clean fade.
          alphaToCoverage
          // Two program variants, both cached after their first use: the static
          // tray is front-face-only with no discard; revealable entities are
          // double-sided and clip (see onBeforeCompile).
          side={revealable ? THREE.DoubleSide : THREE.FrontSide}
          {...(revealable ? { defines: REVEAL_DEFINES } : {})}
          onBeforeCompile={onBeforeCompile}
        />
      </mesh>
      <lineSegments geometry={edgeGeometry}>
        <lineBasicMaterial
          ref={lineMaterialRef}
          color="#0f3536"
          transparent
          opacity={0.4}
          onBeforeCompile={onBeforeCompileEdges}
        />
      </lineSegments>
    </group>
  );
}

/**
 * One animating entity: its parts merged into a mesh, re-based at their
 * center so the preset's rotation and scale pivot there, playing its preset
 * from lib/animPresets through a pose the TrayMesh applies every frame.
 */
function EntityMesh({
  entity,
  tray,
  offset,
  grid,
  params,
  view,
}: {
  entity: EntityAnim;
  /** The tray the entity's parts come from (the new one, or the old one leaving). */
  tray: PartitionedTray;
  /** Where that tray sits in the world. */
  offset: [number, number, number];
  grid: GridState;
  params: TrayParams;
  view: ViewSettings;
}) {
  const built = useMemo(() => {
    const byKey = new Map(tray.parts.map((p) => [p.key, p]));
    const parts = entity.keys.map((k) => byKey.get(k)).filter((p): p is TrayPart => !!p);
    const merged = mergeParts(parts);
    const b = meshBounds(merged.positions);
    const center: [number, number, number] = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    const rebase = (a: Float32Array) => {
      const out = new Float32Array(a.length);
      for (let i = 0; i < a.length; i += 3) {
        out[i] = a[i] - center[0];
        out[i + 1] = a[i + 1] - center[1];
        out[i + 2] = a[i + 2] - center[2];
      }
      return out;
    };
    const geometry: TrayGeometry = {
      positions: rebase(merged.positions),
      normals: merged.normals,
      edges: rebase(merged.edges),
      cols: tray.cols,
      rows: tray.rows,
      topZ: tray.topZ,
    };
    return { geometry, center };
  }, [entity, tray]);
  const pose = useRef<Pose>(restPose());
  const playback = useRef<Playback | null>(null);
  const ticks = useRef(0);
  // Prepare before the first paint (nothing may flash at rest), play on the
  // second frame: the first one after a commit uploads the new geometry and can
  // stall — on a big tray in dev mode for hundreds of ms — and the animation
  // must not lose its opening to that.
  useLayoutEffect(() => {
    const ctx = { delay: entity.delay / 1000, dir: entity.dir, seed: entity.seed };
    presets[entity.preset].prepare?.(pose.current, ctx);
    return () => {
      playback.current?.stop();
      playback.current = null;
    };
  }, [entity]);
  useFrame(() => {
    if (playback.current || ++ticks.current < 2) return;
    playback.current = presets[entity.preset].play(pose.current, {
      delay: entity.delay / 1000,
      dir: entity.dir,
      seed: entity.seed,
    });
  });
  return (
    <group position={[offset[0] + built.center[0], offset[1] + built.center[1], offset[2] + built.center[2]]}>
      <TrayMesh
        geometry={built.geometry}
        sel={null}
        grid={grid}
        params={params}
        view={view}
        ghost={null}
        pose={pose}
        origin={built.center}
        revealable={entity.preset === "printIn"}
      />
    </group>
  );
}

/**
 * Calls `onDone` once the transition has played out. The clock starts on the
 * second frame after mount — the same moment the entities start playing — so a
 * slow commit frame delays the whole transition instead of eating into it.
 */
function TransitionEnd({ duration, onDone }: { duration: number; onDone: () => void }) {
  const ticks = useRef(0);
  const started = useRef<number | null>(null);
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    if (started.current === null) {
      if (++ticks.current >= 2) started.current = performance.now();
      return;
    }
    if (performance.now() - started.current < duration) return;
    done.current = true;
    onDone();
  });
  return null;
}

/**
 * Dev builds only: the CAD kernel's B-rep edges for the same spec, drawn in red
 * over the procedural preview, plus `window.__compare()` (bounds and volume of
 * both) — the guard against the mesher and the export drifting apart.
 */
function CadOverlay({ spec, geometry }: { spec: TraySpec; geometry: TrayGeometry }) {
  const [cad, setCad] = useState<MeshData | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(() => {
      requestMesh(spec)
        .then((m) => {
          if (seq.current === id) setCad(m);
        })
        .catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [spec]);

  // The worker's frame is OCC's (z up, row 0 at the highest y): rotate −90°
  // about x after shifting the mesh's own top y to the origin.
  const built = useMemo(() => {
    if (!cad) return null;
    let maxY = -Infinity;
    for (let i = 1; i < cad.vertices.length; i += 3) maxY = Math.max(maxY, cad.vertices[i]);
    const e = new THREE.BufferGeometry();
    e.setAttribute("position", new THREE.BufferAttribute(cad.edges, 3));
    return { edges: e, offsetY: -(maxY + CLEAR) };
  }, [cad]);
  useEffect(() => () => built?.edges.dispose(), [built]);

  useEffect(() => {
    if (!cad || !built) return;
    const compare = () => {
      // Expand the indexed CAD mesh into world-frame triangles.
      const { vertices: v, triangles: t } = cad;
      const soup = new Float32Array(t.length * 3);
      for (let i = 0; i < t.length; i++) {
        const k = t[i] * 3;
        soup[i * 3] = v[k];
        soup[i * 3 + 1] = v[k + 2];
        soup[i * 3 + 2] = -(v[k + 1] + built.offsetY);
      }
      const cadVol = meshVolume(soup);
      const preVol = meshVolume(geometry.positions);
      return {
        cad: { bounds: meshBounds(soup), volume: cadVol },
        preview: { bounds: meshBounds(geometry.positions), volume: preVol },
        volumeDiffPct: ((preVol - cadVol) / cadVol) * 100,
      };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__compare = compare;
  }, [cad, built, geometry]);

  if (!built) return null;
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <group position={[0, built.offsetY, 0]}>
        <lineSegments geometry={built.edges}>
          <lineBasicMaterial color="#ff3b30" transparent opacity={0.9} depthTest={false} />
        </lineSegments>
      </group>
    </group>
  );
}

export default function Viewer({
  geometry,
  spec,
  grid,
  params,
  onResize,
  onGridChange,
  view,
  viewMappingId = DEFAULT_MAPPING_ID,
}: {
  /** The tray to draw, meshed and partitioned synchronously from `spec` by the state owner. */
  geometry: PartitionedTray;
  /** The same spec, for the dev-only CAD comparison overlay. */
  spec: TraySpec;
  grid: GridState;
  /** Needed to locate the compartment interiors for the selection tint. */
  params: TrayParams;
  /** Commit a grid resize dragged from the 3D handles (new outline in current grid units). */
  onResize: (frame: Frame) => void;
  /** Commit a fuse/split made from the 3D selection popup. */
  onGridChange: (next: GridState) => void;
  /** Rendering options (printed look, layer height). */
  view: ViewSettings;
  /** Which button→action preset to use; a future settings UI feeds this. */
  viewMappingId?: string;
}) {
  const { cols, rows } = grid;
  const extent = Math.max(cols, rows) * PITCH;
  const trayPickRef = useRef<THREE.Mesh | null>(null);
  const [selection, setSelection] = useState<Region | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  // Pending resize footprint. Lives here because both the handles (label,
  // handle placement) and the tray (ghosting what a shrink removes) render from it.
  const [shadow, setShadow] = useState<ShadowState | null>(null);

  // --- Transitions: how the last layout turns into this one ----------------
  // Derived in render (React's "adjust state from props" pattern) so the
  // retiring mesh and the new geometry land in the same commit — there is no
  // frame where removed cells are simply gone. The change that caused it is
  // marked in state by the event handler (resize frame, or null for fuse/split,
  // plus the clock — render must stay pure), in the same event as the parent's
  // grid update, so both batch into one render; the derivation consumes it.
  // Changes without a mark (Settings params, restores) never animate.
  const [pending, setPending] = useState<{ frame: Frame | null; at: number } | null>(null);
  const [prev, setPrev] = useState<Snapshot>(() => ({ grid, geometry, params }));
  const [anim, setAnim] = useState<Transition | null>(null);
  if (geometry !== prev.geometry) {
    const next: Snapshot = { grid, geometry, params };
    const t = pending ? makeTransition(prev, next, pending.frame, pending.at) : null;
    setPrev(next);
    if (pending) setPending(null);
    if (t) setAnim(t);
  }
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (process.env.NODE_ENV === "development") (window as any).__transition = anim;
  }, [anim]);
  // Everything not currently animating in, as one mesh. Entering entities are
  // drawn separately (EntityMesh) and rejoin it when the transition ends.
  const staticGeometry = useMemo<TrayGeometry>(() => {
    if (!anim || anim.enter.length === 0) return geometry;
    const hidden = new Set(anim.enter.flatMap((e) => e.keys));
    return {
      ...mergeParts(geometry.parts.filter((p) => !hidden.has(p.key))),
      cols: geometry.cols,
      rows: geometry.rows,
      topZ: geometry.topZ,
    };
  }, [geometry, anim]);
  // A shrink (2D or 3D handles) can leave the selection out of bounds; treat as cleared.
  const sel = selection && selection.c1 < cols && selection.r1 < rows ? selection : null;

  const handleSelect = useCallback((next: Region | null) => {
    setSelection(next);
    setPopupPos(null);
  }, []);
  const handleRelease = useCallback((x: number, y: number) => setPopupPos({ x, y }), []);
  // Cell indices shift under a left/top resize, so a selection can't survive one.
  const handleResize = (frame: Frame) => {
    handleSelect(null);
    // Batched with the parent's grid update: the next render sees both and
    // derives the transition (see below).
    setPending({ frame, at: performance.now() });
    onResize(frame);
  };

  const canFuse = sel !== null && canFuseSelection(grid, sel);
  const canSplit = sel !== null && canSplitSelection(grid, sel);

  // The camera starts framing the tray as mounted (page.tsx mounts the Viewer
  // after the localStorage restore, so that is the saved design) and is then
  // the user's alone. Both objects must keep their identity: a fresh Canvas
  // `camera` config or controls target on re-render would teleport the view.
  const [initial] = useState(() => {
    const pose = perspectivePose(cols, rows);
    return {
      pose,
      camera: {
        position: pose.pos.toArray() as [number, number, number],
        fov: 40,
        near: 1,
        far: 5000,
      },
    };
  });
  return (
    <div className="relative h-full w-full">
      <Canvas camera={initial.camera} dpr={[1, 2]}>
        <color attach="background" args={["#101012"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[150, 300, 200]} intensity={1.4} />
        <directionalLight position={[-200, 150, -100]} intensity={0.4} />
        <directionalLight position={[50, -200, 80]} intensity={0.5} />
        <TrayMesh
          geometry={staticGeometry}
          sel={sel}
          grid={grid}
          params={params}
          view={view}
          ghost={shadow}
          pickRef={trayPickRef}
        />
        {anim?.enter.map((e) => (
          <EntityMesh key={e.id} entity={e} tray={geometry} offset={[0, 0, 0]} grid={grid} params={params} view={view} />
        ))}
        {anim?.leave.map((e) => (
          <EntityMesh
            key={`${anim.start}:${e.id}`}
            entity={e}
            tray={anim.leaveTray}
            offset={anim.leaveOffset}
            grid={anim.leaveGrid}
            params={params}
            view={view}
          />
        ))}
        {anim && <TransitionEnd key={anim.start} duration={anim.duration} onDone={() => setAnim(null)} />}
        {process.env.NODE_ENV === "development" && view.cadOverlay && (
          <CadOverlay spec={spec} geometry={geometry} />
        )}
        <ResizeHandles3D
          cols={cols}
          rows={rows}
          geometry={geometry}
          trayRef={trayPickRef}
          shadow={shadow}
          setShadow={setShadow}
          onResize={handleResize}
        />
        <CellSelector
          grid={grid}
          selection={sel}
          trayRef={trayPickRef}
          mappingId={viewMappingId}
          onSelect={handleSelect}
          onRelease={handleRelease}
        />
        <Grid
          position={[0, -0.05, 0]}
          args={[10, 10]}
          cellSize={PITCH / 2}
          cellThickness={0.4}
          cellColor="#2a2a2e"
          sectionSize={PITCH}
          sectionThickness={0.8}
          sectionColor="#3d3d44"
          fadeDistance={Math.max(extent * 6, 1200)}
          infiniteGrid
        />
        <MappedControls mappingId={viewMappingId} initialTarget={initial.pose.target} />
      </Canvas>
      {sel && popupPos && (canFuse || canSplit) && (
        <div
          className="absolute z-10 flex animate-[popup-in_0.15s_ease-out] items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-900/95 p-1.5 shadow-xl shadow-black/40 backdrop-blur"
          style={{ left: popupPos.x, top: popupPos.y - 12, transform: "translate(-50%, -100%)" }}
        >
          <button
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white enabled:hover:bg-sky-500 disabled:opacity-30"
            disabled={!canFuse}
            onClick={() => {
              setPending({ frame: null, at: performance.now() });
              onGridChange(fuse(grid, sel));
              handleSelect(null);
            }}
          >
            Fuse
          </button>
          <button
            className="rounded-md bg-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-100 enabled:hover:bg-neutral-600 disabled:opacity-30"
            disabled={!canSplit}
            onClick={() => {
              setPending({ frame: null, at: performance.now() });
              onGridChange(split(grid, sel));
              handleSelect(null);
            }}
          >
            Split
          </button>
          <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-r border-b border-neutral-700 bg-neutral-900" />
        </div>
      )}
    </div>
  );
}
