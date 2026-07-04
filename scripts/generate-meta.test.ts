import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end proof that generate-meta.mjs reads the right things out of REAL git
// history. Each test builds a throwaway repo in the OS temp dir, drives git with
// pinned dates + identity so it works on a clean machine, runs the ACTUAL script
// against it as a child process, and reads back generated/meta.json.

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "generate-meta.mjs",
);

const DATA_FILES = [
  "data/project.yaml",
  "data/subgroups/engines.yaml",
  "data/subgroups/fluids.yaml",
  "data/subgroups/structures.yaml",
  "data/subgroups/avionics.yaml",
];

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── tiny git harness ───────────────────────────────────────────────────────────

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "meta-test-"));
  created.push(dir);
  git(dir, ["init", "-q"]);
  return dir;
}

function git(repo: string, args: string[], date?: string): void {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...IDENTITY,
  };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
}

function writeFile(repo: string, relPath: string, text: string): void {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function writeAllData(repo: string): void {
  writeFile(repo, "data/project.yaml", "project: ND — initial\n");
  writeFile(
    repo,
    "data/subgroups/engines.yaml",
    "tasks:\n  - id: engines.a\n    name: OLD engines\n",
  );
  writeFile(repo, "data/subgroups/fluids.yaml", "tasks: []\n");
  writeFile(repo, "data/subgroups/structures.yaml", "tasks: []\n");
  writeFile(repo, "data/subgroups/avionics.yaml", "tasks: []\n");
}

/** Run the real script against `repo` and return the parsed meta.json. */
function runScript(repo: string): {
  generatedAt: string;
  staleness: Record<string, string | null>;
  baseline: {
    tag: string;
    taggedAt: string;
    files: Record<string, string>;
  } | null;
} {
  // process.execPath = the node running vitest, so no PATH assumptions.
  execFileSync(process.execPath, [SCRIPT], { cwd: repo, stdio: "ignore" });
  return JSON.parse(readFileSync(join(repo, "generated", "meta.json"), "utf8"));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("generate-meta.mjs against real git history", () => {
  it("staleness dates differ per file; baseline picks the tag and its OLD file content", () => {
    const repo = newRepo();
    writeAllData(repo);

    // Commit 1 — everything, dated May 1.
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "initial"], "2026-05-01T10:00:00+00:00");

    // Tag the baseline HERE, while engines.yaml still holds the OLD content.
    git(repo, ["tag", "baseline/2026-06-01"]);

    // Commit 2 — modify only engines.yaml, dated June 15 (a later date).
    writeFile(
      repo,
      "data/subgroups/engines.yaml",
      "tasks:\n  - id: engines.a\n    name: NEW engines\n",
    );
    git(repo, ["add", "-A"]);
    git(
      repo,
      ["commit", "-q", "-m", "engines update"],
      "2026-06-15T10:00:00+00:00",
    );

    const meta = runScript(repo);

    // Staleness: project untouched since May 1; engines touched June 15 → differ.
    expect(meta.staleness["data/project.yaml"]).toMatch(/^2026-05-01/);
    expect(meta.staleness["data/subgroups/engines.yaml"]).toMatch(
      /^2026-06-15/,
    );
    expect(meta.staleness["data/project.yaml"]).not.toBe(
      meta.staleness["data/subgroups/engines.yaml"],
    );

    // Baseline: the tag, and engines.yaml captured as its OLD (pre-June) content.
    expect(meta.baseline).not.toBeNull();
    expect(meta.baseline!.tag).toBe("baseline/2026-06-01");
    expect(meta.baseline!.files["data/subgroups/engines.yaml"]).toContain(
      "OLD engines",
    );
    expect(meta.baseline!.files["data/subgroups/engines.yaml"]).not.toContain(
      "NEW engines",
    );
  });

  it("two baseline tags → newest (by creatordate) wins", () => {
    const repo = newRepo();
    writeAllData(repo);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "c1"], "2026-05-01T10:00:00+00:00");
    git(repo, ["tag", "baseline/2026-05-01"]);

    // A second, later commit + a newer baseline tag pointing at it.
    writeFile(repo, "data/project.yaml", "project: ND — later\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "c2"], "2026-07-01T10:00:00+00:00");
    git(repo, ["tag", "baseline/2026-07-01"]);

    const meta = runScript(repo);
    expect(meta.baseline!.tag).toBe("baseline/2026-07-01");
    expect(meta.baseline!.files["data/project.yaml"]).toContain("later");
  });

  it("no baseline tags → baseline is null, staleness still populated", () => {
    const repo = newRepo();
    writeAllData(repo);
    git(repo, ["add", "-A"]);
    git(
      repo,
      ["commit", "-q", "-m", "only commit"],
      "2026-05-01T10:00:00+00:00",
    );

    const meta = runScript(repo);
    expect(meta.baseline).toBeNull();
    expect(meta.staleness["data/project.yaml"]).toMatch(/^2026-05-01/);
  });

  it("a file that was never committed → its staleness is null", () => {
    const repo = newRepo();
    // Commit only project.yaml; leave the squad files uncommitted-and-absent.
    writeFile(repo, "data/project.yaml", "project: ND\n");
    git(repo, ["add", "-A"]);
    git(
      repo,
      ["commit", "-q", "-m", "just project"],
      "2026-05-01T10:00:00+00:00",
    );

    const meta = runScript(repo);
    expect(meta.staleness["data/project.yaml"]).toMatch(/^2026-05-01/);
    expect(meta.staleness["data/subgroups/engines.yaml"]).toBeNull();
  });

  it("not a git repo → valid all-null meta, exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-nogit-"));
    created.push(dir);

    // Must NOT throw (execFileSync throws on a non-zero exit).
    const meta = runScript(dir);

    expect(meta.baseline).toBeNull();
    for (const path of DATA_FILES) {
      expect(meta.staleness[path]).toBeNull();
    }
    expect(typeof meta.generatedAt).toBe("string");
  });
});
