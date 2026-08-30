<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gridfinity Tray Builder

Visual web app to design [gridfinity](https://gridfinity.xyz) trays and export them as
**binary STL** and **real STEP** (ISO-10303-21). The user sizes a grid of 42mm units by
dragging (max 12×12), selects cells and **fuses** them into larger compartments
(spreadsheet-style cell merging), tweaks parameters in a sidebar, and watches a live 3D
preview. Everything is client-side; there is no backend.

**Stack:** Next.js 16.3 (Turbopack) · TypeScript · Tailwind v4 · Base UI
(`@base-ui/react` — NOT `@base-ui-components/react`, that package doesn't exist) ·
react-three-fiber 9 + drei 10 · replicad 1.0 over OpenCASCADE WASM, in a web worker.

## Commands

- `npm run dev` — dev server. **Usually already running on :3000** (check before starting
  a second one; `next dev` refuses duplicates for this dir anyway). Hot reload works.
- `npx tsc --noEmit && npx eslint src --max-warnings 0` — the check to run after changes.
- `npm run build` — production build (prebuild copies the WASM, see below).

## Architecture (data flows top to bottom)

| File | Role |
|---|---|
| `src/app/page.tsx` | State owner: `GridState` + `TrayParams` → `TraySpec`; 150ms-debounced, latest-wins mesh requests; localStorage persistence (`gridfinity-tray-v1`); export handler; size readout |
| `src/components/GridEditor.tsx` | The 2D grid: drag-select, drag handles to resize, Fuse/Split buttons |
| `src/components/Sidebar.tsx` | Base UI number fields + switches for params, export buttons |
| `src/components/Viewer.tsx` | R3F canvas: mesh display (flat-shaded + edge lines), auto-fit camera, `MappedControls` (view controls) |
| `src/lib/grid.ts` | Pure grid model: `merges: Region[]` (only >1-cell merges stored; uncovered cells are implicit 1×1). `expandSelection` grows a rect over touched merges until stable — spreadsheet semantics |
| `src/lib/protocol.ts` | Shared types (`TraySpec`, `MeshData`, worker messages) + shared mm constants + `traySizeMm()` |
| `src/lib/viewMapping.ts` | Mouse-button → view-action presets (pure data). Active: `"fusion"` (middle=pan, shift+middle=orbit, wheel=zoom, left/right free) |
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
- **React hooks v6 lint rules** (`react-hooks/refs`, `react-hooks/set-state-in-effect`)
  are **error-level** here: no ref access during render (no curried event handlers that
  close over refs), and the localStorage-restore effect needs its existing
  eslint-disable *block* (single-line disables don't suppress it).
- **Hydration/persistence:** saving is gated on a `hydrated` **state** flag, not a ref —
  a ref updates synchronously and lets the mount-commit save clobber the stored design
  under StrictMode double-effects. Don't "simplify" this back to a ref.
- **Dev hooks** (dev builds only): `window.__cad` (requestMesh/requestExport — parse the
  STL blob to verify dimensions) and `window.__controls` (OrbitControls instance).
  Synthetic PointerEvents with fake pointerIds make OrbitControls' `releasePointerCapture`
  throw, leaving its internal drag state stuck (wheel stops working) — reload the page
  after event-driven tests; real mice are unaffected.
- Removing a drei OrbitControls prop doesn't reset it on HMR — full-reload the page.
