// Copies the replicad OpenCASCADE wasm binary into public/ so the CAD worker
// can load it with a plain fetch instead of going through the bundler.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules/replicad-opencascadejs/dist/replicad_single.wasm");
const destDir = join(root, "public");
const dest = join(destDir, "replicad_single.wasm");

if (!existsSync(src)) {
  console.error("replicad-opencascadejs wasm not found — run npm install first");
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("copied replicad_single.wasm -> public/");
