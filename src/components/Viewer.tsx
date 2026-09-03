"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "@/lib/protocol";
import {
  type GridState,
  MAX_UNITS,
  allRegions,
  boundingRect,
  canFuseSelection,
  canSplitSelection,
  clampUnits,
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
function MappedControls({ mappingId }: { mappingId: string }) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
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
    apply();
    // The target lives here (not as a prop) so the CameraRig can move it
    // without a re-render snapping it back.
    const c = controlsRef.current;
    if (c) {
      c.target.set(0, 15, 0);
      c.update();
    }
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__controls = controlsRef.current;
    }
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

/** A camera pose the rig flies toward; cleared once reached or when the user grabs the view. */
interface CameraGoal {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  /** Survives footprint refits — used to restore the user's own pose after a handle drag. */
  sticky?: boolean;
}
type CameraGoalRef = { current: CameraGoal | null };

// The tray's top-left cell corner is pinned to the world origin and the grid
// grows toward +x (columns) and +z (rows), so resizing never shifts what is
// already there.
function perspectivePose(cols: number, rows: number): CameraGoal {
  const w = cols * PITCH;
  const d = rows * PITCH;
  const extent = Math.max(w, d);
  return {
    pos: new THREE.Vector3(w / 2 + extent * 1.1, extent * 1.5, d / 2 + extent * 1.9),
    target: new THREE.Vector3(w / 2, 15, d / 2),
  };
}

/** Top-down pose fitting the tray plus room to drag the handles right/bottom. */
function topPose(cols: number, rows: number, camera: THREE.PerspectiveCamera): CameraGoal {
  const w = cols * PITCH;
  const d = rows * PITCH;
  const padNear = PITCH * 0.6; // left/top breathing room
  const padFar = PITCH * 2.6; // right/bottom room to grow
  const cx = (w + padFar - padNear) / 2;
  const cz = (d + padFar - padNear) / 2;
  const halfW = (w + padNear + padFar) / 2;
  const halfD = (d + padNear + padFar) / 2;
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  const dist = Math.max(halfD / tanHalf, halfW / (tanHalf * camera.aspect)) + 60;
  // tiny z offset keeps the default +Y up vector stable when looking straight down
  return {
    pos: new THREE.Vector3(cx, dist, cz + dist * 0.02),
    target: new THREE.Vector3(cx, 0, cz),
  };
}

function groundPoint(ray: THREE.Ray, out: THREE.Vector3): THREE.Vector3 | null {
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = -ray.origin.y / ray.direction.y;
  if (t <= 0) return null;
  return out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
}

const FLIGHT_SECS = 0.65;

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Signed angle equivalent of `a` in (-π, π], for shortest-way azimuth swings. */
function wrapAngle(a: number): number {
  return THREE.MathUtils.euclideanModulo(a + Math.PI, Math.PI * 2) - Math.PI;
}

/** One in-progress camera move, precomputed so every frame reuses the same endpoints. */
interface Flight {
  goal: CameraGoal;
  t: number;
  fromTarget: THREE.Vector3;
  fromSph: THREE.Spherical;
  /** Goal offset in spherical form, theta unwound to the short way around. */
  toSph: THREE.Spherical;
}

/** Flies the camera toward goalRef; refits to the perspective view when the footprint changes. */
function CameraRig({ cols, rows, goalRef }: { cols: number; rows: number; goalRef: CameraGoalRef }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const scene = useThree((s) => s.scene);
  const flightRef = useRef<Flight | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__scene = scene;
    }
  }, [scene]);

  useEffect(() => {
    // A sticky goal (restoring the user's own pose) outranks the generic refit.
    if (goalRef.current?.sticky) return;
    goalRef.current = perspectivePose(cols, rows);
  }, [cols, rows, goalRef]);

  // A manual orbit/pan/zoom takes over: stop steering the camera.
  useEffect(() => {
    if (!controls) return;
    const cancel = () => {
      goalRef.current = null;
    };
    controls.addEventListener("start", cancel);
    return () => controls.removeEventListener("start", cancel);
  }, [controls, goalRef]);

  useFrame((_, dt) => {
    if (!controls) return;
    const goal = goalRef.current;
    if (!goal) {
      flightRef.current = null;
      return;
    }
    let f = flightRef.current;
    if (!f || f.goal !== goal) {
      const fromTarget = controls.target.clone();
      const fromSph = new THREE.Spherical()
        .setFromVector3(camera.position.clone().sub(fromTarget))
        .makeSafe();
      const toSph = new THREE.Spherical()
        .setFromVector3(goal.pos.clone().sub(goal.target))
        .makeSafe();
      toSph.theta = fromSph.theta + wrapAngle(toSph.theta - fromSph.theta);
      f = flightRef.current = { goal, t: 0, fromTarget, fromSph, toSph };
    }
    f.t = Math.min(1, f.t + dt / FLIGHT_SECS);
    // Everything follows the same eased progress *in orbit-angle space*:
    // target pan, azimuth, polar angle and radius. Interpolating the angles
    // (rather than the chord between the two positions) spreads the screen
    // twist near the top-down pole across the whole flight instead of letting
    // it snap at the end, which read as rotation lagging the translation.
    const e = easeInOut(f.t);
    const { lerp } = THREE.MathUtils;
    controls.target.lerpVectors(f.fromTarget, goal.target, e);
    camera.position
      .setFromSpherical(
        new THREE.Spherical(
          lerp(f.fromSph.radius, f.toSph.radius, e),
          lerp(f.fromSph.phi, f.toSph.phi, e),
          lerp(f.fromSph.theta, f.toSph.theta, e),
        ),
      )
      .add(controls.target);
    if (f.t >= 1) {
      camera.position.copy(goal.pos);
      controls.target.copy(goal.target);
      goalRef.current = null;
      flightRef.current = null;
    }
    controls.update();
  });
  return null;
}

// --- 3D resize handles -------------------------------------------------------

const HANDLE_GAP = 12; // mm from tray edge to icon center
// The corner icon sits on the diagonal at the same distance from the tray as the edge ones.
const HANDLE_GAP_DIAG = HANDLE_GAP / Math.SQRT2;
const HANDLE_ICON = 16; // icon height in mm (the SVG's 24-unit viewBox maps to this)
const HANDLE_HIT_LONG = 36; // hit box extent along the edge the handle sits on
const HANDLE_HIT_SHORT = 20;
const HANDLE_HIT_H = 10;
const HANDLE_REST_SCALE = 0.5;
const HANDLE_REST_OPACITY = 0.5;
const HANDLE_REST_Y = 0.25; // just above the ground grid
const HANDLE_HOVER_Y = 3; // mm the icon lifts while hovered or dragged
const RESIZE_ICON_URL: string = resizeIcon.src;

type Axis = "x" | "y" | "xy";

/** Spin about y so the double chevron points along the axis it resizes. */
const AXIS_SPIN: Record<Axis, number> = { x: Math.PI / 2, y: 0, xy: Math.PI / 4 };

interface ShadowState {
  cols: number;
  rows: number;
  axis: Axis;
  /** true while the pointer is down; false = committed, waiting for the rebuilt mesh. */
  live: boolean;
  /** Mesh that was current at commit time — the shadow stays until a newer one arrives. */
  baseMesh: MeshData | null;
}

/**
 * resize.svg's two chevrons as one flat geometry: centred, `HANDLE_ICON` tall,
 * lying on the ground with SVG-down mapped to +z. Handle drags happen in the
 * top view, where +z is screen-down, so the icon reads as it does in the 2D editor.
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
 * full opacity and a small lift. In use (dragging): full size, and the other two
 * handles fade out (`dimmed`). All ease over ~100ms
 * in the frame loop; the initial props are stable primitives so re-renders never
 * snap them.
 */
function HandleIcon({
  axis,
  hover,
  active,
  dimmed,
}: {
  axis: Axis;
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
      rotation-y={AXIS_SPIN[axis]}
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
  axis,
  active,
  dimmed,
  onDown,
}: {
  x: number;
  z: number;
  axis: Axis;
  active: boolean;
  /** Another handle is in use: fade out and stop taking the pointer. */
  dimmed: boolean;
  onDown: (axis: Axis, e: ThreeEvent<PointerEvent>) => void;
}) {
  const [hover, setHover] = useState(false);
  const hx = axis === "y" ? HANDLE_HIT_LONG : axis === "x" ? HANDLE_HIT_SHORT : 24;
  const hz = axis === "x" ? HANDLE_HIT_LONG : axis === "y" ? HANDLE_HIT_SHORT : 24;
  return (
    <group position={[x, 0, z]}>
      {/* oversized invisible hit box so the flat icon is easy to grab */}
      <mesh
        position-y={HANDLE_HIT_H / 2}
        visible={!dimmed}
        onPointerDown={(e) => onDown(axis, e)}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <boxGeometry args={[hx, HANDLE_HIT_H, hz]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Suspense fallback={null}>
        <HandleIcon axis={axis} hover={hover && !dimmed} active={active} dimmed={dimmed} />
      </Suspense>
    </group>
  );
}

/** Ghost footprint of the pending size: fill + unit gridlines + size badge. */
function SizeShadow({ cols, rows }: { cols: number; rows: number }) {
  const w = cols * PITCH;
  const d = rows * PITCH;
  const lines = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= cols; i++) pts.push(i * PITCH, 0, 0, i * PITCH, 0, d);
    for (let j = 0; j <= rows; j++) pts.push(0, 0, j * PITCH, w, 0, j * PITCH);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, [cols, rows, w, d]);
  useEffect(() => () => lines.dispose(), [lines]);
  return (
    <group position={[0, 0.6, 0]}>
      <mesh position={[w / 2, 0, d / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
        <planeGeometry args={[w, d]} />
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
      <Html position={[w + 14, 0, d + 14]} center style={{ pointerEvents: "none" }}>
        <div className="rounded-md bg-sky-500 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-white tabular-nums">
          {cols} × {rows}
        </div>
      </Html>
    </group>
  );
}

/**
 * The three grid-resize handles (columns / rows / both), mirroring the 2D
 * editor. Pressing one flies the camera to a top view; dragging previews the
 * new size as a shadow; releasing commits it in one rebuild.
 */
function ResizeHandles3D({
  cols,
  rows,
  mesh,
  onResize,
  goalRef,
}: {
  cols: number;
  rows: number;
  mesh: MeshData | null;
  onResize: (cols: number, rows: number) => void;
  goalRef: CameraGoalRef;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  // Fetch controls lazily at event time (never from render) so we can toggle
  // `enabled` without fighting the hooks immutability rule or stale closures.
  const getState = useThree((s) => s.get);
  const [shadow, setShadow] = useState<ShadowState | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(() => () => detachRef.current?.(), []);

  const beginDrag = (axis: Axis, e: ThreeEvent<PointerEvent>) => {
    if (detachRef.current || e.nativeEvent.button !== 0) return;
    e.stopPropagation();
    const startCols = cols;
    const startRows = rows;
    const preview = { cols, rows };
    const controls = getState().controls as unknown as OrbitControlsImpl | null;
    // Where to fly back once the drag ends: the exact pose the user left —
    // or, when a restore flight is still going, the pose it was headed to.
    const prevGoal = goalRef.current;
    const savedPos = (prevGoal?.sticky ? prevGoal.pos : camera.position).clone();
    const savedTarget = (
      prevGoal?.sticky ? prevGoal.target : (controls?.target ?? new THREE.Vector3(0, 15, 0))
    ).clone();
    if (controls) controls.enabled = false;
    goalRef.current = topPose(cols, rows, camera);
    setShadow({ cols, rows, axis, live: true, baseMesh: null });

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
      // Absolute mapping: the dragged edge snaps to the grid line nearest the
      // pointer, so it stays correct even while the camera is still flying.
      const c = axis === "y" ? startCols : clampUnits(Math.round(hit.x / PITCH));
      const r = axis === "x" ? startRows : clampUnits(Math.round(hit.z / PITCH));
      preview.cols = c;
      preview.rows = r;
      setShadow((s) =>
        s && s.live && s.cols === c && s.rows === r
          ? s
          : { cols: c, rows: r, axis, live: true, baseMesh: null },
      );
    };

    const finish = (commit: boolean) => {
      detach();
      if (controls) controls.enabled = true;
      const changed = commit && (preview.cols !== startCols || preview.rows !== startRows);
      if (changed) {
        // Keep the shadow up while the worker rebuilds; it clears once a
        // mesh newer than `baseMesh` lands.
        setShadow({ cols: preview.cols, rows: preview.rows, axis, live: false, baseMesh: mesh });
        onResize(preview.cols, preview.rows);
      } else {
        setShadow(null);
      }
      goalRef.current = { pos: savedPos, target: savedTarget, sticky: true };
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

  const visible = shadow && (shadow.live || shadow.baseMesh === mesh) ? shadow : null;
  const pw = (visible?.cols ?? cols) * PITCH;
  const pd = (visible?.rows ?? rows) * PITCH;

  return (
    <group>
      {visible && <SizeShadow cols={visible.cols} rows={visible.rows} />}
      <Handle
        x={pw + HANDLE_GAP}
        z={pd / 2}
        axis="x"
        active={visible?.axis === "x"}
        dimmed={visible !== null && visible.axis !== "x"}
        onDown={beginDrag}
      />
      <Handle
        x={pw / 2}
        z={pd + HANDLE_GAP}
        axis="y"
        active={visible?.axis === "y"}
        dimmed={visible !== null && visible.axis !== "y"}
        onDown={beginDrag}
      />
      <Handle
        x={pw + HANDLE_GAP_DIAG}
        z={pd + HANDLE_GAP_DIAG}
        axis="xy"
        active={visible?.axis === "xy"}
        dimmed={visible !== null && visible.axis !== "xy"}
        onDown={beginDrag}
      />
    </group>
  );
}

// --- 3D cell selection -------------------------------------------------------

/**
 * Drag-select cells on the tray with the left button (only while the active
 * view mapping leaves it free), with the 2D editor's spreadsheet semantics.
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
function TrayMesh({
  mesh,
  sel,
  grid,
  params,
  view,
  pickRef,
}: {
  mesh: MeshData;
  sel: Region | null;
  /** Compartment layout — the printed look derives its perimeter loops from it. */
  grid: GridState;
  params: TrayParams;
  view: ViewSettings;
  pickRef?: React.Ref<THREE.Mesh>;
}) {
  const uniforms = useRef({
    uSelMin: { value: new THREE.Vector3() },
    uSelMax: { value: new THREE.Vector3() },
    uSelActive: { value: 0 },
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
    const tex = uniforms.current.uRegions.value;
    return () => tex.dispose();
  }, []);

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
    const topZ = Math.max(params.heightMm, BASE_H + 1) + (params.lip ? LIP_H : 0);
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
          "#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;",
        )
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\n" +
            "vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n" +
            "vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vWorldPos;
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
  vec3 nw = normalize(vWorldNormal);
  // Layers repeat along world y; top fill repeats along the fill direction in xz.
  float ly = vWorldPos.y / uLayerH;
  // Top pattern: uPerims loops hugging the region's edge, diagonal fill inside.
  // Only up-facing fragments pay for the distance field (feet bottoms get fill).
  vec2 dir = vec2(cos(uFillAngle), sin(uFillAngle));
  vec2 away = dir;
  float dEdge = 1e9;
  if (nw.y > 0.5) dEdge = topEdgeDist(vWorldPos.xz, away);
  bool perim = dEdge < uPerims * uLineW;
  vec2 tdir = perim ? away : dir;
  float ls = (perim ? dEdge : dot(vWorldPos.xz, dir)) / uLineW;
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

  const { geometry, edgeGeometry, offset } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    const flat = g.toNonIndexed();
    g.dispose();
    flat.computeVertexNormals();
    const e = new THREE.BufferGeometry();
    e.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
    // The worker puts row 0 at its top y; shifting by -depth (before the -90°
    // X rotation) lands the tray in [0,w]×[0,d] with row 0 at z's start — the
    // same top-left origin the 2D editor and the resize shadow use. The depth
    // comes from this mesh's own bounds (not the grid props) so a stale mesh
    // stays put while a resize rebuilds.
    flat.computeBoundingBox();
    const off: [number, number, number] = [0, -((flat.boundingBox?.max.y ?? 0) + CLEAR), 0];
    return { geometry: flat, edgeGeometry: e, offset: off };
  }, [mesh]);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <group position={offset}>
        <mesh ref={pickRef} geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color="#59B9BA"
            roughness={0.55}
            metalness={0.05}
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
            onBeforeCompile={onBeforeCompile}
          />
        </mesh>
        <lineSegments geometry={edgeGeometry}>
          <lineBasicMaterial color="#0f3536" transparent opacity={0.4} />
        </lineSegments>
      </group>
    </group>
  );
}

export default function Viewer({
  mesh,
  grid,
  params,
  onResize,
  onGridChange,
  view,
  viewMappingId = DEFAULT_MAPPING_ID,
}: {
  mesh: MeshData | null;
  grid: GridState;
  /** Needed to locate the compartment interiors for the selection tint. */
  params: TrayParams;
  /** Commit a grid resize dragged from the 3D handles. */
  onResize: (cols: number, rows: number) => void;
  /** Commit a fuse/split made from the 3D selection popup. */
  onGridChange: (next: GridState) => void;
  /** Rendering options (printed look, layer height). */
  view: ViewSettings;
  /** Which button→action preset to use; a future settings UI feeds this. */
  viewMappingId?: string;
}) {
  const { cols, rows } = grid;
  const extent = Math.max(cols, rows) * PITCH;
  const goalRef = useRef<CameraGoal | null>(null);
  const trayPickRef = useRef<THREE.Mesh | null>(null);
  const [selection, setSelection] = useState<Region | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  // A shrink (2D or 3D handles) can leave the selection out of bounds; treat as cleared.
  const sel = selection && selection.c1 < cols && selection.r1 < rows ? selection : null;

  const handleSelect = useCallback((next: Region | null) => {
    setSelection(next);
    setPopupPos(null);
  }, []);
  const handleRelease = useCallback((x: number, y: number) => setPopupPos({ x, y }), []);

  const canFuse = sel !== null && canFuseSelection(grid, sel);
  const canSplit = sel !== null && canSplitSelection(grid, sel);

  // Stable initial camera config: re-applying a fresh object on each render
  // would teleport the camera and defeat the CameraRig animation.
  const [initialCamera] = useState(() => ({
    position: perspectivePose(cols, rows).pos.toArray() as [number, number, number],
    fov: 40,
    near: 1,
    far: 5000,
  }));
  return (
    <div className="relative h-full w-full">
      <Canvas camera={initialCamera} dpr={[1, 2]}>
        <color attach="background" args={["#101012"]} />
        <CameraRig cols={cols} rows={rows} goalRef={goalRef} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[150, 300, 200]} intensity={1.4} />
        <directionalLight position={[-200, 150, -100]} intensity={0.4} />
        <directionalLight position={[50, -200, 80]} intensity={0.5} />
        {mesh && (
          <TrayMesh
            mesh={mesh}
            sel={sel}
            grid={grid}
            params={params}
            view={view}
            pickRef={trayPickRef}
          />
        )}
        <ResizeHandles3D cols={cols} rows={rows} mesh={mesh} onResize={onResize} goalRef={goalRef} />
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
        <MappedControls mappingId={viewMappingId} />
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
