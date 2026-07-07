import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
// The handful of Node builtins below are typed by ./vite-node-shims.d.ts — we
// don't depend on @types/node (no new deps — Phase-0 rule).

// Copy the git-tracked source data and the build-time metadata into dist/ after
// the bundle is written, so the static viewer can fetch them at runtime.
//
//   • data/            — the source-of-truth YAML files the engine loads.
//   • generated/       — meta.json from scripts/generate-meta.mjs (baselines +
//                        staleness). It may be ABSENT on a dev machine that never
//                        ran `npm run meta`; that must NOT fail the build — the
//                        viewer already degrades to null when meta is missing.
//
// The dev server serves both from the repo root already; this plugin only
// matters for the production build.
function copyStaticData(): Plugin {
  return {
    name: "first-light:copy-static-data",
    apply: "build",
    closeBundle() {
      const root = process.cwd();
      cpSync(resolve(root, "data"), resolve(root, "dist/data"), {
        recursive: true,
      });
      const generated = resolve(root, "generated");
      if (existsSync(generated)) {
        cpSync(generated, resolve(root, "dist/generated"), { recursive: true });
      }
    },
  };
}

// Vite root = repo root; index.html is the viewer entry.
// base "./" — GitHub Pages serves project sites under /<repo>/, so all asset
// and data URLs must be relative to the page, not the domain root.
export default defineConfig({
  base: "./",
  plugins: [react(), copyStaticData()],
});
