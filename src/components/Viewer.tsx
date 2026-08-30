"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { PITCH, type MeshData } from "@/lib/protocol";
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
      target={[0, 15, 0]}
      enableZoom={mapping.wheelZoom}
      // half the default momentum (0.05): keep the ease-out but subtle
      dampingFactor={0.1}
    />
  );
}

/** Refit the camera whenever the tray footprint changes. */
function FitCamera({ extent }: { extent: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  useEffect(() => {
    camera.position.set(extent * 1.1, extent * 1.5, extent * 1.9);
    camera.lookAt(0, 10, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controls as any)?.update?.();
  }, [extent, camera, controls]);
  return null;
}

function TrayMesh({ mesh, cols, rows }: { mesh: MeshData; cols: number; rows: number }) {
  const { geometry, edgeGeometry } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    const flat = g.toNonIndexed();
    g.dispose();
    flat.computeVertexNormals();
    const e = new THREE.BufferGeometry();
    e.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
    return { geometry: flat, edgeGeometry: e };
  }, [mesh]);

  const offset: [number, number, number] = [(-PITCH * cols) / 2, (-PITCH * rows) / 2, 0];

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
  viewMappingId = DEFAULT_MAPPING_ID,
}: {
  mesh: MeshData | null;
  cols: number;
  rows: number;
  /** Which button→action preset to use; a future settings UI feeds this. */
  viewMappingId?: string;
}) {
  const extent = Math.max(cols, rows) * PITCH;
  return (
    <Canvas
      camera={{ position: [extent * 1.1, extent * 1.5, extent * 1.9], fov: 40, near: 1, far: 5000 }}
      dpr={[1, 2]}
    >
      <color attach="background" args={["#101012"]} />
      <FitCamera extent={extent} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[150, 300, 200]} intensity={1.4} />
      <directionalLight position={[-200, 150, -100]} intensity={0.4} />
      <directionalLight position={[50, -200, 80]} intensity={0.5} />
      {mesh && <TrayMesh mesh={mesh} cols={cols} rows={rows} />}
      <Grid
        position={[0, -0.05, 0]}
        args={[10, 10]}
        cellSize={PITCH / 2}
        cellThickness={0.4}
        cellColor="#2a2a2e"
        sectionSize={PITCH}
        sectionThickness={0.8}
        sectionColor="#3d3d44"
        fadeDistance={extent * 6}
        infiniteGrid
      />
      <MappedControls mappingId={viewMappingId} />
    </Canvas>
  );
}
