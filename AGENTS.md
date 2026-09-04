<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gridfinity Tray Builder

Visual web app to design [gridfinity](https://gridfinity.xyz) trays and export them as
**binary STL** and **real STEP** (ISO-10303-21). The user sizes a grid of 42mm units by
dragging the 3D handles (max 12×12), selects cells in the 3D view and **fuses**
them into larger compartments
(spreadsheet-style cell merging), tweaks parameters in a floating Settings popover, and
watches a live 3D preview. The whole UI is the 3D view plus two top-left buttons
(Settings, Export); the former sidebar and 2D grid editor were removed in Sept 2026.
Everything is client-side; there is no backend. The preview is meshed **procedurally on
the main thread** (`lib/trayMesher.ts`, ~3ms for a 3×2) from a shared layout module; the
CAD kernel only builds the exports (since Sept 2026). Layout changes animate per
entity — cells slide in and out on resize, divider walls burst away on fuse and drop
in on split — through swappable presets (see "Transitions").

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
| `src/app/page.tsx` | State owner: `GridState` + `TrayParams` → `TraySpec` → `buildTrayParts(spec)` in a `useMemo` (synchronous, no debounce); plus render-only `ViewSettings`; localStorage persistence (`gridfinity-tray-v1`); export handler (the only worker call); size readout |
| `src/components/Toolbar.tsx` | Floating top-left buttons (Base UI `Popover`): Settings (params, printed look, layer height, dev-only CAD overlay toggle) and Export (STL / STEP) |
| `src/components/Viewer.tsx` | R3F canvas: `TrayMesh` (uploads flat-shaded triangles + edge lines; selection-tint, ghost, reveal and printed-look shader patches; applies an animation `pose`), `EntityMesh` + `TransitionEnd` (animation playback), `CadOverlay` (dev builds: the worker's B-rep edges in red + `window.__compare()`), `ResizeHandles3D` (four edge handles + `SizeGrid`, the ground footprint overlay; commit on release, camera compensation for left/top resizes), `MappedControls` (view controls; sets the one-time initial orbit target) |
| `src/lib/transitions.ts` | Pure diff of two partitioned trays into a `Transition`: entering/leaving `EntityAnim`s (cells with everything that belongs to them, lone walls) with presets, delays and directions |
| `src/lib/animPresets.ts` | The animation presets (`cellIn`, `explode`, ...): each drives a plain `Pose` with Motion's `animate()`; durations, distances and the slow-motion knob live here |
| `src/lib/grid.ts` | Pure grid model: `merges: Region[]` (only >1-cell merges stored; uncovered cells are implicit 1×1). `expandSelection` grows a rect over touched merges until stable — spreadsheet semantics. `reframe(state, frame)` re-outlines the grid to a `Frame` (end-exclusive, in the current grid's units, so `c0 < 0` adds columns on the left): merges move with their cells and are clipped at the new bounds |
| `src/lib/protocol.ts` | Shared types (`TraySpec`, `MeshData`, worker messages) + shared mm constants (incl. `R_OUT`, used by both the worker and the printed-look shader) + `traySizeMm()` |
| `src/lib/layout.ts` | **Single source of truth for every dimension**: `levels()` (topZ / floorZ / dividerTop), `outerOutline`, `pocketRect` (insets + corner radius), foot loft rings, magnet centers, the lip socket profile. Plan coordinates = the viewer's world xz (x along columns, z along rows, row 0 at z 0..42); heights in mm above the bed. Used by the worker, the mesher and (by hand-copied #defines) the shader |
| `src/lib/trayMesher.ts` | Procedural preview mesher: emits the tray's *exterior faces* directly — no solid booleans. Wall top = a height field of the inset from the outer outline (`topBands`: rim / chamfer / step / chamfer / socket floor, plus `wall` as a boundary), built as ring-quads near the outline and, for the flat divider network, **per cell** (interior cells analytically: a strip per walled side + a cove per walled corner; boundary cells 2D-clipped with `polygon-clipping`); walls hang off the polygons' edges (classified as pocket / outer / iso-ring); pocket floors, feet lofts, magnet pockets and the underside gaps are analytic. Also emits the B-rep-style edge lines and flat normals. Dev hook `window.__buildTray` |
| `src/lib/trayParts.ts` | **Part partition** of the mesher's soup into animatable entities (`TrayPart`: foot, cell, divider segment, junction post, outer-wall stretch, tray corner), each an exact tile of the tray; `buildTrayParts(spec)` meshes eagerly and partitions **lazily** (`parts` is a getter, so a drag preview pays for the mesh alone); `PartitionedTray` also carries the merged arrays, which is what renders when nothing animates. See "Parts". Dev hook `window.__buildTrayParts` |
| `src/lib/viewMapping.ts` | Mouse-button → view-action presets (pure data). Active: `"fusion"` (middle=pan, shift+middle=orbit, wheel=zoom, left/right free) |
| `src/lib/viewSettings.ts` | Render-only settings (`printLook`, `layerHeight`) + defaults. They never reach the worker — a change must not trigger a rebuild |
| `src/lib/cadClient.ts` | Worker singleton, promise-per-request, `downloadBlob` |
| `src/workers/cad.worker.ts` | **Export geometry** (and the dev overlay's mesh). `buildTray(spec)` is pure, all numbers from `layout.ts`: feet loft → body extrude → fuse → pocket cuts → lip socket cut → magnet cuts. STL + STEP from the same BRep. Loads its WASM lazily, on the first export |

**Preview cost** (main thread, per change, mesh + partition): ~6ms at 3×2, ~120ms at
12×12 with lip + magnets (mesher ~70ms: the per-cell wall tops run edge classification
on ~1k small polygons; partition ~50ms: one pass over ~120k triangles, dominated by
per-triangle overhead, not splitting). If 12×12 must be drag-smooth, emit parts straight
from the mesher (the per-cell layout makes it natural) instead of partitioning after.
The worker holds **no state** between requests; an export rebuilds the whole tray
(~190ms at 1×1, ~570ms at 3×2 with magnets+lip; boolean ops dominate).

**Performance — judge it in a production build.** Measured Sept 2026 on a 7×2 → 9×2
grow with drag steps, 1900² canvas: `next dev` shows main-thread stalls of ~150ms per
drag snap, ~250ms at commit and ~130ms when the transition ends — all React 19
*development* overhead (StrictMode double render, per-component `console.createTask`
tracking, thousands of debugger async-task events per scheduler task; worse with DevTools
attached), not our code: mesh+partition come from the cache in 0.1ms, `makeTransition`
0.3ms, entity builds <0.3ms, the GPU never exceeds 3ms/task and the same interaction in
`npm run build && npx next start -p 3101` produces **zero long tasks** (PerformanceObserver
`longtask`), 60fps at 2× on a 3800² canvas idle, dragging with the preview, and animating.
At 7×7 → 8×7 the dev commit stalls ~750ms while production shows a worst frame gap of
21ms and one 75ms task per drag snap (the preview's mesh). What is done regardless: the
ghost and the commit land in **one** React batch (see the drag flow); `buildTrayParts`
memoizes the last 8 specs so the drag
preview's build is reused at commit, and partitions **lazily** (`parts` is a getter —
only a transition needs it, so the drag pays for the mesh alone and the idle tray draws
the mesher's own, smaller soup); animations start on the second frame after the scene is
up (see Transitions), so a stall delays them instead of eating them; and the static tray
compiles a front-face-only shader variant with no `discard` (entities printing in use the
double-sided `TRAY_REVEAL` variant) so early depth testing stays on at retina sizes.
Note also that another tab hogging the CPU (a localhost:3001 video experience showed
300ms tasks in the same trace) makes everything stutter.

**Mesher ↔ CAD agreement** is checked, not assumed: the Settings popover has a dev-only
"CAD overlay" toggle drawing the worker's edges in red over the preview, and
`window.__compare()` returns bounds + signed volume of both (they match to ~0.03%;
the residue is arc sampling). The one deliberate deviation: when the floor is thicker than
the height allows (pocket floor above the lip's socket floor), the CAD makes a stepped
floor and the preview just lowers the floor.

## Gridfinity numbers (mm) — in `protocol.ts` / `layout.ts`

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
  columns grow +x, rows grow +z (row 0 at z 0..42, screen-down when seen from above).
  Cell boundaries therefore align with the ground grid's 42mm sections, and resizing
  from the right/bottom never moves existing geometry. Resizing from the **left/top**
  does: the layout re-anchors the new cell (0,0) at the origin, so the surviving cells
  move in world space by whole pitches when the new geometry renders — `ResizeHandles3D`
  translates the camera (position + target) by the same amount in a **layout effect
  keyed on the geometry identity**, i.e. in the same commit as the geometry swap, so
  nothing moves on screen (and the 42mm-periodic ground grid can't give it away). The
  mesher emits world-frame geometry directly (x cols, y up, z rows), so `TrayMesh` has no
  rotation or offset group; only the dev `CadOverlay` still applies the worker's frame
  (−90° about x after shifting the mesh's own top y to the origin).
- **The camera belongs to the user:** it starts on `perspectivePose(cols, rows)` (a
  three-quarter view) and is never moved programmatically after that — resizing happens
  in place from whatever view the user is in; no refit, no flight (the earlier fly-to-top
  drag and post-resize refit were removed in Sept 2026 as confusing). `page.tsx` mounts
  the Viewer only once `hydrated`, so that one-time pose frames the *restored* design.
  If a fit-view button is ever wanted, the eased orbit-angle-space flight rig
  (`CameraRig`) is in git history just before that change.
- **Handle icons:** the four resize handles (one per tray edge) are `assets/resize.svg` (a vertical double
  chevron) drawn flat on the ground: Next's static import gives the URL, `SVGLoader`
  turns it into one merged `ShapeGeometry` (`useResizeIconGeometry`), rotated so
  SVG-down maps to +z (screen-down when seen from above) and spun per axis (`AXIS_SPIN`).
  The icon is not pickable; an oversized invisible box above it takes the pointer. Handles
  behind the tray are hidden by it (normal depth test) and must not react either: the tray
  mesh has no pointer handlers, so R3F raycasts through it — each hit box re-raycasts the
  event's ray against `trayRef` and ignores covered hits (the click then falls through to
  the cell selector). States:
  rest = half size + half opacity on the ground, hover = full opacity + 3mm lift,
  dragging = full size while the others fade out (and stop taking the pointer); all ease
  in `useFrame` (the initial scale/opacity props are stable primitives, so re-renders
  don't snap them). No cursor change on hover — by request.
- **Handle drag flow:** pointerdown disables controls (a mapping with orbit/pan on the
  left button must not also move the view); moves use window-level listeners and
  **absolute** snapping — the pointer is raycast onto the ground plane and the dragged
  edge goes to the grid line nearest that point, from any viewing angle, while the
  opposite edge stays put (size clamped to 1..12); release commits once via
  `onResize(frame)` (Escape cancels) and clears the cell selection, whose indices would
  shift under a left/top resize. The pending footprint (`ShadowState`, a `Frame` in the
  *displayed* world's units, so `c0 < 0` after a left grow) is drawn by `SizeGrid`, **flat
  on the ground** (y 0.6) with `depthTest={false}` so it reads from any angle: a
  translucent fill and a line per unit boundary over **only the cells the resize adds**,
  plus the resulting size badge. Only one edge moves per drag, so what is new is a single
  strip outside the current 0..cols × 0..rows footprint (which of the four bounds left it
  says where); a shrink adds nothing, so it draws the badge alone and the tray's own ghost
  carries the message. That overlay was replaced in Sept 2026 by a wall-top label plus a
  half-coverage preview of the future tray, and restored by request in Oct 2026 — the
  preview meshed a second tray on every drag snap and read as clutter; the fill under the
  existing tray went the same day for the same reason. Release clears the grid in
  the same batch as the commit — clearing the shadow a frame early (which `finish` did for
  a while) leaves one painted frame of the *old* tray with the ghost already gone, so the
  cells about to be removed flash back to solid before the animation picks them up at
  `GHOST_ALPHA`; batching them means the last drag frame stays on screen through the
  rebuild and the leaving entities appear already faded. The camera shift for
  a left/top resize is applied by a layout effect keyed on the geometry identity, i.e. in
  the commit that swaps the geometry. The state lives in `Viewer` because the tray renders
  from it too: `TrayMesh`'s `ghost` prop feeds `uGhost*` uniforms and fragments **outside**
  the kept box (expanded by wall/2 so the future outer wall stays solid) fade to
  `GHOST_ALPHA` (0.5, exported from `animPresets.ts`; the `cellOut`/`fadeOut` presets
  `prepare` to the same value so the commit continues the fade instead of flashing back
  to solid — change one, change both) —
  via **alpha-to-coverage** on the still-opaque material, which the multisampled canvas
  resolves to a clean fade with no self-overlap sorting artifacts; the edge lines get the
  same factor through their own `onBeforeCompile` sharing the uniform objects. So a shrink
  shows the grid on what is kept and ghosts what is leaving; a grow just shows the grid
  (nothing of the current tray is leaving). The size badge sits past the footprint's
  bottom-right corner and can fall outside the viewport on a wide grow — pre-existing,
  unchanged. The print pattern reads `vLocalPos` (object space) rather than world xz so
  animating entities, which are re-based at their center, keep their layout aligned; the
  selection and ghost boxes stay in world space.
- **Stable camera props:** the `Canvas` `camera` object lives in a `useState`
  initializer and OrbitControls gets its target imperatively (not as a prop) — a
  fresh object/array identity on re-render re-applies the prop and teleports the
  camera / snaps the target back under the user's orbit/pan.
- A grid shrink from the 3D handles can invalidate the live cell selection; Viewer
  derives a `sel` guard instead of clearing state (no setState-in-effect).
- **3D cell selection (`CellSelector`):** left-drag on the tray selects cells with the
  spreadsheet semantics — the pure helpers (`regionAt`, `boundingRect`,
  `expandSelection`, `canFuseSelection`, `canSplitSelection`) live in `grid.ts`. Only active while the view mapping leaves the left button free
  (`buttons.left === "none"`). Picking raycasts the **visible tray mesh** first (via
  `pickRef` on `TrayMesh`), falling back to the ground plane — so a click on a tall wall
  selects the cell the cursor is on, not the occluded one behind it. An invisible
  catch-all plane starts selections near the footprint (0.6-pitch forgiveness pad) and
  clears them elsewhere. Releasing shows a Fuse/Split popup: a DOM overlay in Viewer's
  wrapper div anchored above the cursor (clamped to the canvas, `popup-in` keyframes in
  globals.css). Fuse, split, Escape, empty-ground clicks, and a click on an already selected
  cell all clear the selection and popup (a press inside the selection only becomes a
  new drag once the pointer leaves that cell).
- **Selection visual = interior tint, not an overlay:** `TrayMesh` recolors the tray's
  own fragments via `onBeforeCompile` uniforms — inside the selection's world box, minus
  horizontal top-rim faces (`n.y > 0.9` above `topZ − 0.8`) and outer-shell fragments
  (outward normal within 4.3mm of a box side, covering corner radius 3.75 + clearance).
  The box floor sits just under the pocket floor so feet keep the base color. Its vertical
  bounds recompute the `topZ`/`floorZ` formulas from `TrayParams` (`trayTopY`) — keep
  them in sync with `layout.ts` `levels()`. Uniforms live in a ref and are mutated in an effect
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
  `layout.ts` `pocketRect()`** (change one, change both), and `topEdgeDist()` takes the nearest of
  the 4 cells around the closest grid corner plus the outer outline, so wall tops and
  junctions get loops along the wall. Feet bottoms just get fill. Anti-moiré is
  two-stage and both stages are in *periods per pixel* (`fwidth` of the pattern
  coordinate): the half-disc bead profile morphs into a pure cosine from ~12px/period
  (its seam harmonics alias long before the period does — this is what caused the
  "concentric arcs" on walls), then the whole pattern fades out by ~1.7px/period. At
  1× DPR that means lines vanish at a typical overview; on retina they hold. Seams also
  darken the diffuse (`uSeamShade`) and each layer gets a tiny hashed brightness
  offset. All knobs are uniforms in the same ref as the selection uniforms.

## Parts (`lib/trayParts.ts`)

- **Why:** animations need entities — "that wall", "that cell" — and the mesher emits one
  soup. `partitionTray(spec, geometry)` regroups it into `TrayPart`s that tile the tray
  exactly; merged back (`mergeParts`) they are the same surface plus the split seams, so
  `__compare()` and the volume check are unchanged. Rendering still uploads the merged
  arrays; animating parts as their own meshes is the next step.
- **Entities and keys:** `foot:c,r` · `cell:c,r` (floor slab under everything, coves, the
  underside gaps in its square) · `div:v:r:c` / `div:h:r:c` (divider segment between
  cells) · `post:r:c` (junction
  square at the grid corner below-right of cell (r,c)) · `wall:top|bottom:c`,
  `wall:left|right:r` (outer-wall stretch along one cell edge, lip collar included) ·
  `corner:tl|tr|bl|br` (the `CLEAR + max(R_OUT, wall)` square at each tray corner).
  `cells` lists the cells a part touches.
- **How:** split the soup along the partition's planes — per axis the wall inner face
  `CLEAR + w`, the corner square `cs`, and `g − w/2, g, g + w/2` at each interior grid
  line; plus `y = floorZ` — then assign every triangle by a point `INSET` (0.05mm) inside
  the solid behind it (`centroid − normal·INSET`) via `partAt`: below the base → foot;
  below the floor → cell (the floor slab is cell material even under walls); corner
  squares; the wall band; divider bands (only where the two cells are different regions);
  a junction square goes to the wall running straight through it, otherwise to a post.
  Feet are copied without plane checks (one part each); anything at or below the base
  only splits along cell lines (the underside gaps between feet).
- **Invariants:** partition boundaries coincide with the mesher's own edges (pocket sides
  at `g ± w/2`, the wall's inner face), so straight walls never get cut and their faces
  land on the right side by the inset sample. The mesher builds interior cells' wall tops
  per cell for the same reason: earcut on one tray-wide polygon makes slivers that shatter
  into dozens of pieces here. Adding a new plan feature = a new key in `partAt` + its
  planes in `splitPlanes`.

## Transitions (`lib/transitions.ts` + `lib/animPresets.ts` + Viewer.tsx)

- **Model:** `makeTransition(prev, next, frame, at)` diffs two `Snapshot`s
  (`{grid, geometry: PartitionedTray, params}`) **by part key**: every old key is mapped
  into the new world (`remapKey` — cells shift by the resize frame's origin; an outer
  wall / corner survives only if its edge is still the tray's edge) and looked up in the
  new tray. Keys only the new tray has *enter*, keys only the old tray had *leave*. Each
  side is grouped into `EntityAnim`s: one per cell of a resize wave, claiming every part
  that touches it (foot, floor slab, its wall stretches, corner, the divider to its
  neighbour), then one per leftover part — a divider/post (fuse: `explode`, split:
  `land`) or a wall stretch/corner that changed role (`fadeOut`/`fadeIn`, e.g. the outer
  wall a grow turns into a divider). Cells get `cellIn`/`cellOut` with the wave delays
  (nearest-first growing, farthest-first shrinking, 0.35 ripple along the edge, ≤180ms
  stagger, 2400ms budget; leaving cells then scatter by `CELL_DELAY_CHAOS` × their
  own delay, off `hash(i + now)` rather than `Math.random()` — this runs during
  render). Each entity also gets a unit `dir` away from the change's center and a
  `seed`. `duration` = latest delay + preset duration, counted from the
  moment playback starts (see below), not from the pointer event.
- **Presets (`lib/animPresets.ts`) — the experimentation surface.** A preset drives a
  plain `Pose` (`x y z` mm, `rx ry rz` rad about the entity's center, `scale`,
  `opacity`, `reveal`) with Motion's imperative `animate()` (the `motion` package; its
  React components and the discontinued 3D package are *not* used). `PRESET_MS` holds
  the nominal durations and `CELL_TRAVEL` / `LAND_DROP` / the `SHAKE_*`+`BURST_*`
  set the distances (all actively tuned — read them, don't quote them); `slowFactor()` (the
  `window.__animSlow` knob) scales every duration and delay at play time. Current set:
  `cellIn` (starts `CELL_TRAVEL` above and transparent, settles onto the tray),
  `cellOut` (a damped lateral shiver that alternates sides and dies at center
  while the cell swells, an optional beat of stillness, then a fast blow-up as it
  fades — `SHAKE_MS`/`SHAKE_HOLD_MS`/`BURST_MS` also set `PRESET_MS.cellOut`, and
  a zero hold drops its keyframe rather than emitting two stops at one time),
  `fadeIn`, `fadeOut`, `land`
  (`LAND_DROP` above, ease-out bounce), `explode` (keyframes up and away along `dir`,
  tumbling, fading over the second half), `printIn` (the old bed-up reveal, via
  `reveal`). The two `*Out` presets `prepare` to `GHOST_ALPHA`, not to 1, because the
  cells they animate were already ghosted while the handle was held. To try something
  new: edit numbers here, add a preset, or point `transitions.ts` at another.
- **Playback (Viewer):** the transition is derived *during render* (React's
  adjust-state-from-props pattern) when the `geometry` prop identity changes, so the
  leaving entities and the new geometry land in the same commit. The event that caused
  the change marks `pending` state `{frame, at}` (`handleResize`, the Fuse/Split
  buttons); `at` is taken in the handler because the compiler lint (`react-hooks/purity`)
  rejects `performance.now()` in render; unmarked changes (Settings, restores) never
  animate. `staticGeometry` = `mergeParts` of the new tray minus the entering entities'
  keys — one mesh for everything at rest. Each entity is an `EntityMesh`: its parts
  merged, **re-based at their center** (so rotation/scale pivot there; `TrayMesh`'s
  `origin` prop feeds `uLocalOrigin` so the print pattern still reads tray coordinates),
  rendered by a `TrayMesh` whose `pose` ref the preset mutates and whose `useFrame`
  applies it (group transform, both materials' opacity through alpha-to-coverage,
  `uReveal`). Leaving entities come from `leaveTray`/`leaveGrid` at `leaveOffset`
  (`(-c0, -r0)·PITCH` for a left/top resize). `TransitionEnd` (keyed by `start`) clears
  the transition once `duration` has elapsed; a new change mid-flight replaces it.
  **Playback starts only once the scene is up:** a preset has `prepare` (sets the
  invisible starting pose in a layout effect, before the first paint) and `play` (starts
  the Motion animation); `EntityMesh` calls `play` on its *second* `useFrame` tick, and
  `TransitionEnd` starts its clock on the same tick, so a slow commit frame (a 7×7 tray
  in dev mode can stall for hundreds of ms building and uploading everything) delays the
  whole animation instead of eating its opening. `duration` is relative to that moment,
  never to the pointer event.
- **Shader hooks the presets rely on:** `pose.opacity` reaches both materials through
  alpha-to-coverage, and `pose.reveal` feeds `uReveal`, which clips fragments above
  `reveal · uAnimTop`. That clip and the back-face discard live behind `#ifdef
  TRAY_REVEAL`, a second program variant used only by entities whose preset needs it
  (`revealable`, today just `printIn`) — the static tray and every other entity compile
  the front-face-only variant with no `discard`, which keeps early depth testing on. The
  ghost uniforms are untouched by entities (`ghost={null}`).
- **Dev:** `window.__animSlow = N` stretches every new transition N×; `window.__transition`
  is the live one (null when idle). Screenshots through the devtools bridge land ~3s
  after the request — slow it down to inspect. Synthetic pointer events leave
  OrbitControls' capture state broken (see Dev hooks) — reload between scripted runs.

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
- **Mesher invariants** (`trayMesher.ts`): every rounded rectangle is sampled by the one
  `sampleRRect` (same corner order, same points per arc) so loft rings and concentric
  iso-rings pair up index by index and coincident outlines (pocket side on the wall-inset
  ring, pocket corner on the outer corner) produce *identical* floats — the edge
  classification relies on that. `polygon-clipping` leaves a touching edge whole, so an
  iso-ring edge that a pocket side runs along is split at the pocket's vertices before
  classifying (`pocketVerticesOn`); dropping that split brings back the wall = 2.0 holes.
  The wall thickness must stay a band boundary: bands ending at or before it skip clipping
  entirely (pockets start at that inset). Triangles are wound by `Sink.tri` toward a
  `want` direction, so a wrong normal shows up as a sign flip in `meshVolume`. Open-edge
  checks will report collinear T-junctions (floor caps, underside seams, split top edges);
  those are geometrically watertight. Node repro: `npx tsx` a script importing the module.
- **Dev hooks** (dev builds only): `window.__cad` (requestMesh/requestExport — parse the
  STL blob to verify dimensions), `window.__buildTray` (the mesher; time it or diff it
  against `__cad.requestMesh` for a spec), `window.__compare()` (bounds + volume of the
  preview vs the CAD mesh; needs the CAD overlay toggle on), `window.__transition` and
  `window.__animSlow` (see Transitions), `window.__controls` (OrbitControls instance) and
  `window.__scene` (THREE.Scene — the default camera is *not* parented to it, so
  traversing from `__controls.object` finds nothing) and `window.__printUniforms` (the
  tray shader's uniform bag — tweak `uRelief`/`uSeamShade`/`uFillAngle` live).
  Synthetic PointerEvents with fake pointerIds make OrbitControls' `releasePointerCapture`
  throw, leaving its internal drag state stuck (wheel stops working) — reload the page
  after event-driven tests; real mice are unaffected.
- Removing a drei OrbitControls prop doesn't reset it on HMR — full-reload the page.
  Same for GLSL edits inside `onBeforeCompile`: three keeps the program compiled from
  the first callback, so the material never picks up the new source without a reload.
