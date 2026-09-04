"use client";

// The SKÅDIS board's 3D view. Much smaller than the tray's Viewer: a board has
// no compartments, so there is no cell selection, no fuse/split and no
// per-entity transitions — the only edit is dragging an edge to add or remove
// lattice columns and rows, which the shared handles already do.
//
// What it does share with the tray: the scene shell (controls, lights, ground),
// the resize handles and their ghost preview, and the printed-look shader —
// only the `topEdgeDist` below is the board's own.

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GHOST_ALPHA } from "@/lib/animPresets";
import { type Frame } from "@/lib/grid";
import { hi, lo, type GridMetrics } from "@/lib/gridMetrics";
import {
  FRAG_DECLS,
  FRAG_GHOST,
  FRAG_PRINT,
  VERTEX_BODY,
  VERTEX_DECLS,
  patchEdgeMaterial,
  printUniforms,
} from "@/lib/printShader";
import {
  BOARD_R,
  LATTICE,
  MARGIN,
  MAX_UNITS,
  MIN_UNITS,
  SLOT_H,
  SLOT_PITCH,
  SLOT_R,
  SLOT_W,
  UNIT_STEP,
  boardSizeMm,
  type SkadisSpec,
} from "@/lib/skadis";
import { buildBoardGeometry, type BoardGeometry } from "@/lib/boardMesher";
import { meshBounds, meshVolume } from "@/lib/meshKit";
import { requestMesh } from "@/lib/cadClient";
import type { MeshData } from "@/lib/workerProtocol";
import { DEFAULT_MAPPING_ID } from "@/lib/viewMapping";
import { type ViewSettings } from "@/lib/viewSettings";
import { GroundGrid, MappedControls, SceneLights, perspectivePose } from "./viewer/scene";
import { ResizeHandles3D, type ShadowState } from "./viewer/handles";

/**
 * The board's unit grid: 20mm lattice positions, the first one `MARGIN` in from
 * the edge, so a unit boundary sits at `MARGIN − LATTICE/2 + LATTICE·u` and the
 * board overhangs the outermost boundary by half a step. Counts are odd only.
 */
export const BOARD_METRICS: GridMetrics = {
  pitch: LATTICE,
  origin: MARGIN - LATTICE / 2,
  pad: LATTICE / 2,
  min: MIN_UNITS,
  max: MAX_UNITS,
  step: UNIT_STEP,
};

/**
 * The board's flat regions for the printed look. Both faces are one plane
 * pierced by slots, and the slots are a checkerboard — which is two interleaved
 * 40mm lattices, one per parity. So the nearest slot is a round-to-lattice on
 * each, clamped to the range that actually carries slots, and the perimeter
 * loops fall out of the obround's own signed distance. The board outline is the
 * other edge a loop can hug.
 */
const BOARD_TOP_EDGE_DIST = `uniform vec4 uSlotA;
uniform vec4 uSlotB;
uniform vec2 uBoardSize;
#define SLOT_PITCH ${SLOT_PITCH}.0
#define SLOT_HX ${SLOT_W / 2}
#define SLOT_HZ ${SLOT_H / 2}
#define SLOT_RAD ${SLOT_R}
#define BOARD_RAD ${BOARD_R}.0
float topEdgeDist(vec2 p, out vec2 away) {
  float best = 1e9;
  away = vec2(1.0, 0.0);
  for (int i = 0; i < 2; i++) {
    vec4 rng = i == 0 ? uSlotA : uSlotB;
    // Nearest centre on this parity's lattice, kept inside the slotted range.
    vec2 c = clamp(rng.xy + SLOT_PITCH * floor((p - rng.xy) / SLOT_PITCH + 0.5), rng.xy, rng.zw);
    vec2 g;
    float sd = sdRoundRect(p, c - vec2(SLOT_HX, SLOT_HZ), c + vec2(SLOT_HX, SLOT_HZ), SLOT_RAD, g);
    float d = abs(sd);
    if (d < best) { best = d; away = sd < 0.0 ? -g : g; }
  }
  vec2 g;
  float dOut = -sdRoundRect(p, vec2(0.0), uBoardSize, BOARD_RAD, g);
  if (dOut < best) { best = dOut; away = -g; }
  return best;
}`;

/**
 * The two parities' slot lattices as (xMin, zMin, xMax, zMax). Set A is the odd
 * columns / even rows, set B the other — see `hasSlot` in lib/skadis.
 */
function slotRanges(cols: number, rows: number) {
  const u = (n: number) => MARGIN + LATTICE * n;
  return {
    a: new THREE.Vector4(u(1), u(0), u(cols - 2), u(rows - 1)),
    b: new THREE.Vector4(u(0), u(1), u(cols - 1), u(rows - 2)),
  };
}

function BoardMesh({
  geometry: board,
  spec,
  view,
  ghost,
  pickRef,
}: {
  geometry: BoardGeometry;
  spec: SkadisSpec;
  view: ViewSettings;
  /** Resize footprint (lattice units): fragments outside it fade to `GHOST_ALPHA`. */
  ghost: Frame | null;
  pickRef?: React.Ref<THREE.Mesh>;
}) {
  const uniforms = useRef({
    ...printUniforms(GHOST_ALPHA),
    uSlotA: { value: new THREE.Vector4() },
    uSlotB: { value: new THREE.Vector4() },
    uBoardSize: { value: new THREE.Vector2() },
  });

  useEffect(() => {
    const u = uniforms.current;
    const { a, b } = slotRanges(spec.cols, spec.rows);
    u.uSlotA.value.copy(a);
    u.uSlotB.value.copy(b);
    const size = boardSizeMm(spec);
    u.uBoardSize.value.set(size.w, size.d);
    u.uAnimTop.value = size.h + 0.5;
  }, [spec]);

  useEffect(() => {
    const u = uniforms.current;
    u.uGhostOn.value = ghost ? 1 : 0;
    if (!ghost) return;
    // The kept part's own outline: everything inside the future board stays solid.
    u.uGhostMin.value.set(lo(BOARD_METRICS, ghost.c0), lo(BOARD_METRICS, ghost.r0));
    u.uGhostMax.value.set(hi(BOARD_METRICS, ghost.c1), hi(BOARD_METRICS, ghost.r1));
  }, [ghost]);

  useEffect(() => {
    const u = uniforms.current;
    u.uPrint.value = view.printLook ? 1 : 0;
    u.uLayerH.value = Math.max(view.layerHeight, 0.04);
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__printUniforms = u;
    }
  }, [view]);

  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const lineMaterialRef = useRef<THREE.LineBasicMaterial>(null);
  // Nothing animates the board yet, but the ghost fade rides the same path the
  // tray's poses do: alpha through MSAA coverage on an opaque material.
  useFrame(() => {
    if (materialRef.current) materialRef.current.opacity = 1;
    if (lineMaterialRef.current) lineMaterialRef.current.opacity = 0.4;
  });

  const onBeforeCompile = useMemo(
    () => (shader: Parameters<NonNullable<THREE.MeshStandardMaterial["onBeforeCompile"]>>[0]) => {
      Object.assign(shader.uniforms, uniforms.current);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_DECLS}`)
        .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\n${VERTEX_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAG_DECLS}\n${BOARD_TOP_EDGE_DIST}`)
        .replace(
          "vec4 diffuseColor = vec4( diffuse, opacity );",
          `vec4 diffuseColor = vec4( diffuse, opacity );\n${FRAG_GHOST}`,
        )
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAG_PRINT}`);
    },
    [],
  );
  const onBeforeCompileEdges = useMemo(
    () => (shader: Parameters<NonNullable<THREE.LineBasicMaterial["onBeforeCompile"]>>[0]) =>
      patchEdgeMaterial(shader, uniforms.current),
    [],
  );

  // The mesher emits flat-shaded, non-indexed triangles already in the world
  // frame (x cols, y up, z rows), so the geometry is uploaded as is.
  const { geometry, edgeGeometry } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(board.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(board.normals, 3));
    const e = new THREE.BufferGeometry();
    e.setAttribute("position", new THREE.BufferAttribute(board.edges, 3));
    return { geometry: g, edgeGeometry: e };
  }, [board]);
  useEffect(
    () => () => {
      geometry.dispose();
      edgeGeometry.dispose();
    },
    [geometry, edgeGeometry],
  );

  return (
    <group>
      <mesh ref={pickRef} geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          ref={materialRef}
          color="#C6CBD2"
          roughness={0.62}
          metalness={0.04}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
          alphaToCoverage
          side={THREE.FrontSide}
          onBeforeCompile={onBeforeCompile}
        />
      </mesh>
      <lineSegments geometry={edgeGeometry}>
        <lineBasicMaterial
          ref={lineMaterialRef}
          color="#4a4f57"
          transparent
          opacity={0.4}
          onBeforeCompile={onBeforeCompileEdges}
        />
      </lineSegments>
    </group>
  );
}

/**
 * Dev builds: the CAD kernel's B-rep edges in red over the preview, plus
 * `window.__compareBoard()` — the board's answer to the tray's `window.__compare()`.
 * Mesher ↔ CAD agreement is the project's standing rule; this is how it gets
 * checked without leaving the browser.
 */
function BoardCadOverlay({ spec, geometry }: { spec: SkadisSpec; geometry: BoardGeometry }) {
  const [cad, setCad] = useState<MeshData | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    // A big board takes seconds to build; don't chase every drag step.
    const timer = setTimeout(() => {
      requestMesh({ model: "skadis", spec })
        .then((m) => {
          if (seq.current === id) setCad(m);
        })
        .catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [spec]);

  const depth = boardSizeMm(spec).d;
  // The worker's frame is OCC's (z up, plan z mapped to y = d − z), so the whole
  // thing rotates −90° about x and then flips back along the rows axis.
  const edges = useMemo(() => {
    if (!cad) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(cad.edges, 3));
    return g;
  }, [cad]);
  useEffect(() => () => edges?.dispose(), [edges]);

  useEffect(() => {
    if (!cad) return;
    const compare = () => {
      // Expand the indexed CAD mesh into world-frame triangles.
      const { vertices: v, triangles: t } = cad;
      const soup = new Float32Array(t.length * 3);
      for (let i = 0; i < t.length; i++) {
        const k = t[i] * 3;
        soup[i * 3] = v[k];
        soup[i * 3 + 1] = v[k + 2];
        soup[i * 3 + 2] = depth - v[k + 1];
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
    (window as any).__compareBoard = compare;
  }, [cad, geometry, depth]);

  if (!edges) return null;
  // Shift along the worker's own y first, then rotate: (x, y, z)_occ becomes
  // (x, z, d − y)_world, which is `plan z = d − occ y` (see buildBoard).
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <group position={[0, -depth, 0]}>
        <lineSegments geometry={edges}>
          <lineBasicMaterial color="#ff3b30" transparent opacity={0.9} depthTest={false} />
        </lineSegments>
      </group>
    </group>
  );
}

export default function BoardViewer({
  spec,
  onResize,
  view,
  viewMappingId = DEFAULT_MAPPING_ID,
}: {
  spec: SkadisSpec;
  /** Commit a resize dragged from the 3D handles (new outline in current lattice units). */
  onResize: (frame: Frame) => void;
  view: ViewSettings;
  viewMappingId?: string;
}) {
  const { cols, rows } = spec;
  const size = boardSizeMm(spec);
  const pickRef = useRef<THREE.Mesh | null>(null);
  // Pending resize footprint. Lives here because both the handles (badge,
  // handle placement) and the board (ghosting what a shrink removes) render from it.
  const [shadow, setShadow] = useState<ShadowState | null>(null);

  // A flat plate is cheap to mesh (~15ms for the largest real board), so this
  // stays synchronous like the tray's — every change shows on the next frame.
  const geometry = useMemo(() => buildBoardGeometry(spec), [spec]);

  // The camera frames the board as mounted and is then the user's alone. Both
  // objects must keep their identity: a fresh Canvas `camera` config or controls
  // target on re-render would teleport the view.
  const [initial] = useState(() => {
    const pose = perspectivePose(size.w, size.d);
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
        <SceneLights />
        <BoardMesh
          geometry={geometry}
          spec={spec}
          view={view}
          ghost={shadow}
          pickRef={pickRef}
        />
        <ResizeHandles3D
          cols={cols}
          rows={rows}
          metrics={BOARD_METRICS}
          geometry={geometry}
          shapeRef={pickRef}
          shadow={shadow}
          setShadow={setShadow}
          onResize={onResize}
        />
        {process.env.NODE_ENV === "development" && view.cadOverlay && (
          <BoardCadOverlay spec={spec} geometry={geometry} />
        )}
        <GroundGrid section={SLOT_PITCH} extent={Math.max(size.w, size.d)} />
        <MappedControls mappingId={viewMappingId} initialTarget={initial.pose.target} />
      </Canvas>
    </div>
  );
}
