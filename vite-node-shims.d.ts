// vite-node-shims.d.ts — minimal ambient types for the build-only vite.config.ts.
//
// The config touches a few Node builtins (fs.cpSync, path.resolve, process.cwd)
// to copy data/ + generated/ into dist/. We deliberately do NOT install
// @types/node (Phase-0 rule: no new deps), so we declare just those few surfaces
// here. This file is a SCRIPT (no import/export), so `declare module` creates an
// ambient module rather than augmenting a nonexistent one. It is scoped to
// tsconfig.node.json only — these node globals never leak into the app/engine.

declare module "node:fs" {
  export function cpSync(
    src: string,
    dest: string,
    opts: { recursive: boolean },
  ): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
}

declare const process: { cwd(): string };
