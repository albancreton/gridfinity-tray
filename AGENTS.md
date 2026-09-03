<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gridfinity Tray Builder

Visual web app to design [gridfinity](https://gridfinity.xyz) trays and export them as
**binary STL** and **real STEP** (ISO-10303-21). The user sizes a grid of 42mm units by
dragging (max 12×12, in the 2D panel or via the 3D handles), selects cells and **fuses**
them into larger compartments
(spreadsheet-style cell merging), tweaks parameters in a sidebar, and watches a live 3D
preview. Everything is client-side; there is no backend.

**Stack:** Next.js 16.3 (Turbopack) · TypeScript · Tailwind v4 · Base UI
(`@base-ui/react` — NOT `@base-ui-components/react`, that package doesn't exist) ·
react-three-fiber 9 + drei 10 · replicad 1.0 over OpenCASCADE WASM, in a web worker.

## Commands

- `npm run dev` — dev server. **Usually already running on :3100** (check before starting
  a second one; `next dev` refuses duplicates for this dir anyway). Hot reload works.
- `npx tsc --noEmit && npx eslint src --max-warnings 0` — the check to run after changes.
- `npm run build` — production build (prebuild copies the WASM, see below).

## Architecture (data flows top to bottom)

| File | Role |
|---|---|
| `src/app/page.tsx` | State owner: `GridState` + `TrayParams` → `TraySpec`; 150ms-debounced, latest-wins mesh requests; plus render-only `ViewSettings`; localStorage persistence (`gridfinity-tray-v1`); export handler; size readout |
| `src/components/GridEditor.tsx` | The 2D grid: drag-select, drag handles to resize, Fuse/Split buttons |
| `src/components/Sidebar.tsx` | Base UI number fields + switches for params, printed-look switch + layer height, export buttons |
| `src/components/Viewer.tsx` | R3F canvas: `TrayMesh` (flat-shaded + edge lines; selection-tint and printed-look shader patches), `CameraRig` (eased camera flights via a shared goal ref), `ResizeHandles3D` (3D grid resize: top view + shadow preview, commit on release), `MappedControls` (view controls) |
| `src/lib/grid.ts` | Pure grid model: `merges: Region[]` (only >1-cell merges stored; uncovered cells are implicit 1×1). `expandSelection` grows a rect over touched merges until stable — spreadsheet semantics |
| `src/lib/protocol.ts` | Shared types (`TraySpec`, `MeshData`, worker messages) + shared mm constants (incl. `R_OUT`, used by both the worker and the printed-look shader) + `traySizeMm()` |
| `src/lib/viewMapping.ts` | Mouse-button → view-action presets (pure data). Active: `"fusion"` (middle=pan, shift+middle=orbit, wheel=zoom, left/right free) |
| `src/lib/viewSettings.ts` | Render-only settings (`printLook`, `layerHeight`) + defaults. They never reach the worker — a change must not trigger a rebuild |
| `src/lib/cadClient.ts` | Worker singleton, promise-per-request, `downloadBlob` |
| `src/workers/cad.worker.ts` | All geometry. `buildTray(spec)` is pure: feet loft → body extrude → fuse → pocket cuts → lip socket cut → magnet cuts. Mesh + STL + STEP from the same BRep |

The worker holds **no state** between requests — every parameter change rebuilds the whole
tray (~190ms at 1×1, ~570ms at 3×2 with magnets+lip; boolean ops dominate, meshing doesn't).
The 150ms debounce in `page.tsx` exists to coalesce bursts (steppers, drag-resize) because
the worker is serial and stale builds waste its time. Known optimization paths if perf
becomes a problem: leading-edge debounce, sub-shape caching (feet only depend on
cols/rows/magnets), degraded preview during interaction.

## Gridfinity numbers (mm) — in `protocol.ts` / `cad.worker.ts`

- Pitch **42**, clearance **0.25**/side → a tray is `42·n − 0.5` wide.
- Foot profile bottom→top: 0.8 chamfer / 1.8 straight / 2.15 chamfer = **4.75** base
  height; loft 35.6 → 37.2 → 37.2 → 41.5 (r 0.8/1.6/1.6/3.75). Feet stay per-unit even
  under fused compartments.
- Stacking lip: **+4.4** above nominal height. v1 approximation — socket = mirrored foot
  profile; stacked bins sit ~0.25mm proud of spec. Refine against the rev-6 lip profile
  if it matters.
- Magnets: Ø6.5 × 2.4 pockets at ±13 from each foot center (4 per foot), default off.
- Height param = bottom of feet → top of wall, lip excluded. `topZ = max(heightMm, 5.75) + lip·4.4`.
- Verified: 2×1 @ h21+lip exports exactly 83.5 × 41.5 × 25.4.

## 3D view conventions (Viewer.tsx)

- **Corner-anchored world:** the tray's top-left cell corner is pinned to the origin;
  columns grow +x, rows grow +z (row 0 at z 0..42, matching the 2D editor). Resizing
  therefore never shifts existing geometry, and cell boundaries align with the ground
  grid's 42mm sections. `TrayMesh` derives its y-offset from the **mesh's own bounds**
  (not the grid props) so the stale mesh stays put while the worker rebuilds — don't
  "simplify" it to `rows * PITCH`. (The worker keeps row 0 at its *top* y; the −90° X
  rotation plus that offset produces the layout above.)
- **Camera flights:** every programmatic move is a 0.65s eased flight toward
  `goalRef.current`, interpolated in **orbit-angle space** (azimuth unwound the short
  way, polar, radius, plus target lerp — all on one eased progress). Not a position
  lerp and not a view-direction slerp: both concentrate the roll/heading twist at the
  top-down pole, which reads as rotation lagging translation. Goals with
  `sticky: true` (restoring the user's exact pre-drag pose) outrank the cols/rows
  refit effect; any OrbitControls `start` (user orbit/pan/zoom) cancels the flight.
- **Handle icons:** the three resize handles are `assets/resize.svg` (a vertical double
  chevron) drawn flat on the ground: Next's static import gives the URL, `SVGLoader`
  turns it into one merged `ShapeGeometry` (`useResizeIconGeometry`), rotated so
  SVG-down maps to +z (screen-down in the top view) and spun per axis (`AXIS_SPIN`).
  The icon is not pickable; an oversized invisible box above it takes the pointer. States:
  rest = half size + half opacity on the ground, hover = full opacity + 3mm lift,
  dragging = full size while the other two fade out (and stop taking the pointer); all ease
  in `useFrame` (the initial scale/opacity props are stable primitives, so re-renders
  don't snap them). The corner icon sits at `HANDLE_GAP / √2` per axis so it is as far
  from the tray as the edge ones. No cursor change on hover — by request.
- **Handle drag flow:** pointerdown disables controls, saves the current pose, and
  flies to a top view with growth room right/bottom; moves use window-level listeners
  and **absolute** snapping (the dragged edge goes to the grid line nearest the
  pointer — stays correct while the camera is still flying); release commits once
  (Escape cancels). The shadow persists after commit until a mesh **newer than the
  commit-time one** arrives (`baseMesh` identity compare), masking the rebuild.
- **Stable camera props:** the `Canvas` `camera` object lives in a `useState`
  initializer and OrbitControls gets its target imperatively (not as a prop) — a
  fresh object/array identity on re-render re-applies the prop and teleports the
  camera / snaps the target mid-flight.
- A grid shrink from the 3D handles can invalidate GridEditor's live selection; it
  derives a `sel` guard instead of clearing state (no setState-in-effect).
- **3D cell selection (`CellSelector`):** left-drag on the tray selects cells with the
  2D editor's spreadsheet semantics — the shared helpers (`regionAt`, `boundingRect`,
  `expandSelection`, `canFuseSelection`, `canSplitSelection`) live in `grid.ts`, used by
  both editors. Only active while the view mapping leaves the left button free
  (`buttons.left === "none"`). Picking raycasts the **visible tray mesh** first (via
  `pickRef` on `TrayMesh`), falling back to the ground plane — so a click on a tall wall
  selects the cell the cursor is on, not the occluded one behind it. An invisible
  catch-all plane starts selections near the footprint (0.6-pitch forgiveness pad) and
  clears them elsewhere. Releasing shows a Fuse/Split popup: a DOM overlay in Viewer's
  wrapper div anchored above the cursor (clamped to the canvas, `popup-in` keyframes in
  globals.css). Fuse, split, Escape, empty-ground clicks, and a click on an already selected
  cell all clear the selection and popup (a press inside the selection only becomes a
  new drag once the pointer leaves that cell). Viewer guards its selection against shrinks like GridEditor does.
- **Selection visual = interior tint, not an overlay:** `TrayMesh` recolors the tray's
  own fragments via `onBeforeCompile` uniforms — inside the selection's world box, minus
  horizontal top-rim faces (`n.y > 0.9` above `topZ − 0.8`) and outer-shell fragments
  (outward normal within 4.3mm of a box side, covering corner radius 3.75 + clearance).
  The box floor sits just under the pocket floor so feet keep the base color. Its vertical
  bounds recompute the worker's `topZ`/`floorZ` formulas from `TrayParams` — keep them
  in sync with `cad.worker.ts`. Uniforms live in a ref and are mutated in an effect
  (never recreate the material; the shader patch compiles once).
- **Printed look (`TrayMesh` shader, `ViewSettings.printLook`):** an analytic FDM
  height field perturbs the fragment normal — no geometry, no textures (OCC emits two
  triangles per flat face, so anything per-vertex is useless). World y is print height
  with the bed at y=0, so layer seams land where a slicer puts them. Walls/chamfers get
  layer beads along y (period = layer height); up/down-facing faces get top-fill beads
  (period = `NOZZLE_LINE_W`); blended by |n.y| (`smoothstep(0.7, 0.95)`, so 45° foot
  chamfers still show stair-steps). Up-facing faces first get `uPerims` **perimeter
  loops** hugging the edge of their flat region, then the 45° fill: the shader computes
  an analytic distance field from the compartment layout — `uRegions` is a 12×12 RGBA8
  texture mapping each cell to its region rect (c0, r0, c1, r1), `pocketRect()` rebuilds
  the pocket outline from it with the **same insets and corner radius as
  `cad.worker.ts`** (change one, change both), and `topEdgeDist()` takes the nearest of
  the 4 cells around the closest grid corner plus the outer outline, so wall tops and
  junctions get loops along the wall. Feet bottoms just get fill. Anti-moiré is
  two-stage and both stages are in *periods per pixel* (`fwidth` of the pattern
  coordinate): the half-disc bead profile morphs into a pure cosine from ~12px/period
  (its seam harmonics alias long before the period does — this is what caused the
  "concentric arcs" on walls), then the whole pattern fades out by ~1.7px/period. At
  1× DPR that means lines vanish at a typical overview; on retina they hold. Seams also
  darken the diffuse (`uSeamShade`) and each layer gets a tiny hashed brightness
  offset. All knobs are uniforms in the same ref as the selection uniforms.

## Gotchas learned the hard way

- **WASM plumbing:** `scripts/copy-wasm.mjs` (predev/prebuild) copies
  `replicad-opencascadejs/dist/replicad_single.wasm` → `public/` (gitignored); the worker
  loads it via `locateFile: () => "/replicad_single.wasm"`. Fresh clone = `npm install`
  then dev/build; nothing else.
- **OrbitControls modifier swap:** three's OrbitControls silently swaps orbit↔pan when
  ctrl/meta/shift is held on the pointer event. `MappedControls` (Viewer.tsx) pre-inverts
  the action so the `viewMapping.ts` preset is the single source of truth. Don't set
  `mouseButtons` anywhere else. Controls are bound to R3F's wrapper div, not the canvas;
  drei defaults `enableDamping` on (we run `dampingFactor` 0.1).
- **React hooks v6 lint rules** (`react-hooks/refs`, `react-hooks/set-state-in-effect`,
  `react-hooks/immutability`) are **error-level** here: no ref access during render (no
  curried event handlers that close over refs), the localStorage-restore effect needs
  its existing eslint-disable *block* (single-line disables don't suppress it), and
  hook-returned values can't be mutated in handlers — e.g. toggling
  `controls.enabled` requires fetching controls at event time via
  `useThree((s) => s.get)().controls`, not the hook value (method-call mutations
  inside `useFrame` pass unnoticed).
- **Hydration/persistence:** saving is gated on a `hydrated` **state** flag, not a ref —
  a ref updates synchronously and lets the mount-commit save clobber the stored design
  under StrictMode double-effects. Don't "simplify" this back to a ref.
- **Dev hooks** (dev builds only): `window.__cad` (requestMesh/requestExport — parse the
  STL blob to verify dimensions), `window.__controls` (OrbitControls instance) and
  `window.__scene` (THREE.Scene — the default camera is *not* parented to it, so
  traversing from `__controls.object` finds nothing) and `window.__printUniforms` (the
  tray shader's uniform bag — tweak `uRelief`/`uSeamShade`/`uFillAngle` live).
  Synthetic PointerEvents with fake pointerIds make OrbitControls' `releasePointerCapture`
  throw, leaving its internal drag state stuck (wheel stops working) — reload the page
  after event-driven tests; real mice are unaffected.
- Removing a drei OrbitControls prop doesn't reset it on HMR — full-reload the page.
  Same for GLSL edits inside `onBeforeCompile`: three keeps the program compiled from
  the first callback, so the material never picks up the new source without a reload.
