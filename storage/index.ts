// storage/index.ts — the public surface of the data layer (Phase 2A).
//
// The load pipeline, in order:
//   parse-file → validate → merge   (raw text ⇒ engine-safe ProjectData)
//   serialize                       (surgical, comment-preserving file edits)
//
// `mergeProject` is the ONE gate every caller uses to reach the engine: it is
// the only supported way to turn data-file text into the Task[] + Config that
// `computeSchedule` consumes. Nothing here imports the engine's internals — it
// only produces the engine's input contract.
//
// Phase 2B adds a GitHub Contents-API client (write-back = one commit per squad
// file) and git-history readers for baselines + staleness; it will export from
// here too.

export * from "./types";
export * from "./parse-file";
export * from "./validate";
export * from "./merge";
export * from "./serialize";
export * from "./github";
export * from "./settings";
export * from "./meta";
