// The printed look, minus the part that knows what is being printed.
//
// An analytic FDM height field perturbs the fragment normal — no geometry, no
// textures (the meshers emit two triangles per flat face, so anything
// per-vertex is useless). World y is print height with the bed at y=0, so layer
// seams land where a slicer puts them. Walls and chamfers get layer beads along
// y (period = layer height); up- and down-facing faces get top-fill beads
// (period = the nozzle line width), blended by |n.y|.
//
// Everything here is shared by every model. What each model supplies is one
// function:
//
//     float topEdgeDist(vec2 p, out vec2 away)
//
// the distance from an up-facing fragment (in model-local xz) to the nearest
// edge of the flat region it sits on, and the in-plane direction away from that
// edge. That is what makes the perimeter loops hug a tray's compartment walls
// or a board's slots. Consumers concatenate `FRAG_DECLS` + their own uniforms
// and `topEdgeDist`, then splice in `FRAG_GHOST` and `FRAG_PRINT`.
//
// Two traps, both learned the hard way: three caches the program compiled from
// the first `onBeforeCompile` call, so editing this file needs a **full page
// reload**, not HMR; and the reveal clip lives behind `#ifdef MESH_REVEAL` so
// static meshes compile a front-face-only variant with no `discard` and keep
// early depth testing.

import * as THREE from "three";
import { NOZZLE_LINE_W } from "./viewSettings";

/** Opacity a ghosted fragment fades to — re-exported from animPresets by the viewer. */
export interface PrintUniforms {
  uGhostOn: { value: number };
  uGhostMin: { value: THREE.Vector2 };
  uGhostMax: { value: THREE.Vector2 };
  uGhostAlpha: { value: number };
  uReveal: { value: number };
  uAnimTop: { value: number };
  uLocalOrigin: { value: THREE.Vector3 };
  uPrint: { value: number };
  uLayerH: { value: number };
  uLineW: { value: number };
  uFillAngle: { value: number };
  uRelief: { value: number };
  uSeamShade: { value: number };
  uPerims: { value: number };
}

/** The uniform bag every model's mesh material needs, at its resting values. */
export function printUniforms(ghostAlpha: number): PrintUniforms {
  return {
    uGhostOn: { value: 0 },
    /** Ghost box in world xz; fragments outside it fade to `uGhostAlpha`. */
    uGhostMin: { value: new THREE.Vector2() },
    uGhostMax: { value: new THREE.Vector2() },
    uGhostAlpha: { value: ghostAlpha },
    /** Fraction of the height that exists yet (the print-in reveal); 1 = whole. */
    uReveal: { value: 1 },
    /** Height a fully revealed model reaches (a hair above the top). */
    uAnimTop: { value: 0 },
    /** Model-local origin of this geometry (entities are re-based at their center). */
    uLocalOrigin: { value: new THREE.Vector3() },
    uPrint: { value: 0 },
    uLayerH: { value: 0.2 },
    uLineW: { value: NOZZLE_LINE_W },
    uFillAngle: { value: Math.PI / 4 },
    /** Bead relief as a fraction of its period; drives the normal tilt. */
    uRelief: { value: 0.22 },
    /** How much darker a seam gets than a bead crest. */
    uSeamShade: { value: 0.28 },
    /** Perimeter loops drawn around each flat top region before the fill starts. */
    uPerims: { value: 2 },
  };
}

/** `STANDARD` is MeshStandardMaterial's own define; replacing `defines` must keep it. */
export const REVEAL_DEFINES = { STANDARD: "", MESH_REVEAL: "" };

export const VERTEX_DECLS = `varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec3 vWorldNormal;
uniform vec3 uLocalOrigin;`;

export const VERTEX_BODY = `vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
// Model-local = the model's unit (0,0) at the origin; the layout-dependent print
// pattern uses it so translated previews and re-based entities stay aligned.
vLocalPos = transformed + uLocalOrigin;
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`;

export const FRAG_DECLS = `varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec3 vWorldNormal;
uniform float uGhostOn;
uniform vec2 uGhostMin;
uniform vec2 uGhostMax;
uniform float uGhostAlpha;
uniform float uReveal;
uniform float uAnimTop;
uniform float uPrint;
uniform float uLayerH;
uniform float uLineW;
uniform float uFillAngle;
uniform float uRelief;
uniform float uSeamShade;
uniform float uPerims;
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
float fdmHash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }`;

/** Reveal clip + ghost fade. Splice right after `diffuseColor` is declared. */
export const FRAG_GHOST = `#ifdef MESH_REVEAL
// Revealable variant (entities printing in): double-sided so the cut shows the
// wall's inside, back faces dropped once whole, fragments above the progress
// height dropped. Static meshes compile without this block — no discard at all
// keeps early depth testing, which matters on a retina-sized canvas.
if (!gl_FrontFacing && uReveal >= 1.0) discard;
if (uReveal < 1.0 && vLocalPos.y >= uReveal * uAnimTop) discard;
#endif
if (uGhostOn > 0.5) {
  bool outsideGhost = vWorldPos.x < uGhostMin.x || vWorldPos.x > uGhostMax.x ||
    vWorldPos.z < uGhostMin.y || vWorldPos.z > uGhostMax.y;
  // Partial alpha is partial MSAA coverage; no discard needed.
  if (outsideGhost) diffuseColor.a *= uGhostAlpha;
}`;

/** The height field itself. Splice after `<normal_fragment_maps>`; needs `topEdgeDist`. */
export const FRAG_PRINT = `if (uPrint > 0.5) {
  // Back faces show inside a cell that is still printing in; flip to shade them.
  vec3 nw = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  // Layers repeat along world y; top fill repeats along the fill direction in xz.
  float ly = vWorldPos.y / uLayerH;
  // Top pattern: uPerims loops hugging the region's edge, diagonal fill inside.
  // Only up-facing fragments pay for the distance field (undersides get fill).
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
}`;

/**
 * The B-rep edge lines carry the same ghost fade and reveal clip as the surface,
 * through the *same uniform objects* — identical for every model, so this
 * patches the whole line material in one call.
 */
export function patchEdgeMaterial(
  shader: Parameters<NonNullable<THREE.LineBasicMaterial["onBeforeCompile"]>>[0],
  u: PrintUniforms,
) {
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
}
