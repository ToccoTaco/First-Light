// scripts/generate-meta.mjs — build-time git → generated/meta.json.
//
// Baselines and staleness are read from GIT HISTORY, not schema fields (brief
// §6.4). The deployed viewer is static and has no git, so this script runs at
// DEPLOY time (see .github/workflows/deploy.yml, which checks out full history)
// and bakes the answers into generated/meta.json for the viewer to fetch.
//
// It computes two things for the five data files:
//   • staleness — the ISO date of the last commit that touched each file, so the
//     dashboard can say "Avionics: last updated 18 days ago" and nudge the right
//     squad (null if the file was never committed).
//   • baseline  — the NEWEST `baseline/*` tag, plus each data file's full text AS
//     IT EXISTED at that tag, so the viewer can diff "now" against it.
//
// Robustness is the whole point: the viewer must NEVER depend on this script
// succeeding. If git is missing or this isn't a repo, we still write a valid
// meta.json (all-null staleness, null baseline) and exit 0 with a stderr warning.
//
// Plain Node, zero dependencies, no TypeScript — it runs in CI before the build.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The five files whose history we track — the team-lead file plus one per squad.
const DATA_FILES = [
  "data/project.yaml",
  "data/subgroups/engines.yaml",
  "data/subgroups/fluids.yaml",
  "data/subgroups/structures.yaml",
  "data/subgroups/avionics.yaml",
];

const OUT_PATH = join("generated", "meta.json");

function main() {
  const meta = {
    generatedAt: new Date().toISOString(),
    staleness: {},
    baseline: null,
  };

  // If we can't even run git here, emit an all-null-but-valid file and leave.
  if (!isGitRepo()) {
    process.stderr.write(
      "generate-meta: not a git repository (or git unavailable) — writing empty meta.json\n",
    );
    for (const path of DATA_FILES) meta.staleness[path] = null;
    write(meta);
    return;
  }

  // Staleness: last commit date per file (null if the file was never committed).
  for (const path of DATA_FILES) {
    meta.staleness[path] = lastCommitDate(path);
  }

  // Baseline: the newest baseline/* tag, plus each file's text at that tag.
  meta.baseline = newestBaseline();

  write(meta);
}

// ── git reads (each swallows failure and returns a safe empty value) ────────────

/** Is the current directory inside a working git repo? */
function isGitRepo() {
  try {
    const out = git(["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** ISO date of the most recent commit touching `path`, or null if none. */
function lastCommitDate(path) {
  try {
    const out = git(["log", "-1", "--format=%cI", "--", path]).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** The newest baseline/* tag and its captured file contents, or null if no tags. */
function newestBaseline() {
  let tag;
  try {
    const out = git(["tag", "--list", "baseline/*", "--sort=-creatordate"]);
    tag = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0];
  } catch {
    return null;
  }
  if (!tag) return null;

  const files = {};
  for (const path of DATA_FILES) {
    const text = fileAtTag(tag, path);
    if (text !== null) files[path] = text; // omit files that didn't exist at the tag
  }

  return { tag, taggedAt: tagDate(tag), files };
}

/** The full text of `path` as it existed at `tag`, or null if it wasn't there. */
function fileAtTag(tag, path) {
  try {
    return git(["show", `${tag}:${path}`]);
  } catch {
    return null; // file did not exist at that tag
  }
}

/** ISO date the tag was created (works for both lightweight and annotated tags). */
function tagDate(tag) {
  try {
    // %cI = committer date of the tagged commit; a reliable ISO stamp for either
    // tag flavour. (Annotated-tag creation date isn't exposed by `git show` cleanly.)
    return git(["log", "-1", "--format=%cI", tag]).trim();
  } catch {
    return "";
  }
}

// ── plumbing ──────────────────────────────────────────────────────────────────

/** Run git and return stdout as a string. Throws on non-zero exit (callers catch). */
function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Write meta.json, creating generated/ if needed. */
function write(meta) {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(meta, null, 2) + "\n");
  process.stdout.write(`generate-meta: wrote ${OUT_PATH}\n`);
}

main();
