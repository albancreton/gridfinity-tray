"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid, Html, useCursor } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CLEAR, PITCH, type MeshData } from "@/lib/protocol";
import { clampUnits } from "@/lib/grid";
import {
  DEFAULT_MAPPING_ID,
  getViewMapping,
  type MouseButton,
  type ViewAction,
} from "@/lib/viewMapping";

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

const HANDLE_GAP = 8; // mm from tray edge to handle center
const HANDLE_LEN = 22;
const HANDLE_THICK = 3.5;
const HANDLE_H = 3;

type Axis = "x" | "y" | "xy";

const AXIS_CURSOR: Record<Axis, string> = {
  x: "ew-resize",
  y: "ns-resize",
  xy: "nwse-resize",
};

interface ShadowState {
  cols: number;
  rows: number;
  axis: Axis;
  /** true while the pointer is down; false = committed, waiting for the rebuilt mesh. */
  live: boolean;
  /** Mesh that was current at commit time — the shadow stays until a newer one arrives. */
  baseMesh: MeshData | null;
}

function Handle({
  x,
  z,
  axis,
  active,
  onDown,
}: {
  x: number;
  z: number;
  axis: Axis;
  active: boolean;
  onDown: (axis: Axis, e: ThreeEvent<PointerEvent>) => void;
}) {
  const [hover, setHover] = useState(false);
  useCursor(hover || active, AXIS_CURSOR[axis]);
  const sx = axis === "y" ? HANDLE_LEN : axis === "x" ? HANDLE_THICK : 7;
  const sz = axis === "x" ? HANDLE_LEN : axis === "y" ? HANDLE_THICK : 7;
  return (
    <group position={[x, HANDLE_H / 2, z]}>
      {/* oversized invisible hit box so the small bar is easy to grab */}
      <mesh
        onPointerDown={(e) => onDown(axis, e)}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <boxGeometry args={[sx + 14, HANDLE_H + 8, sz + 14]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh raycast={() => null}>
        <boxGeometry args={[sx, HANDLE_H, sz]} />
        <meshBasicMaterial color={hover || active ? "#38bdf8" : "#7a7a83"} />
      </mesh>
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
        onDown={beginDrag}
      />
      <Handle
        x={pw / 2}
        z={pd + HANDLE_GAP}
        axis="y"
        active={visible?.axis === "y"}
        onDown={beginDrag}
      />
      <Handle
        x={pw + HANDLE_GAP}
        z={pd + HANDLE_GAP}
        axis="xy"
        active={visible?.axis === "xy"}
        onDown={beginDrag}
      />
    </group>
  );
}

function TrayMesh({ mesh }: { mesh: MeshData }) {
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
        <mesh geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color="#e07a3f"
            roughness={0.55}
            metalness={0.05}
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        </mesh>
        <lineSegments geometry={edgeGeometry}>
          <lineBasicMaterial color="#3a2417" transparent opacity={0.4} />
        </lineSegments>
      </group>
    </group>
  );
}

export default function Viewer({
  mesh,
  cols,
  rows,
  onResize,
  viewMappingId = DEFAULT_MAPPING_ID,
}: {
  mesh: MeshData | null;
  cols: number;
  rows: number;
  /** Commit a grid resize dragged from the 3D handles. */
  onResize: (cols: number, rows: number) => void;
  /** Which button→action preset to use; a future settings UI feeds this. */
  viewMappingId?: string;
}) {
  const extent = Math.max(cols, rows) * PITCH;
  const goalRef = useRef<CameraGoal | null>(null);
  // Stable initial camera config: re-applying a fresh object on each render
  // would teleport the camera and defeat the CameraRig animation.
  const [initialCamera] = useState(() => ({
    position: perspectivePose(cols, rows).pos.toArray() as [number, number, number],
    fov: 40,
    near: 1,
    far: 5000,
  }));
  return (
    <Canvas camera={initialCamera} dpr={[1, 2]}>
      <color attach="background" args={["#101012"]} />
      <CameraRig cols={cols} rows={rows} goalRef={goalRef} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[150, 300, 200]} intensity={1.4} />
      <directionalLight position={[-200, 150, -100]} intensity={0.4} />
      <directionalLight position={[50, -200, 80]} intensity={0.5} />
      {mesh && <TrayMesh mesh={mesh} />}
      <ResizeHandles3D cols={cols} rows={rows} mesh={mesh} onResize={onResize} goalRef={goalRef} />
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
  );
}
