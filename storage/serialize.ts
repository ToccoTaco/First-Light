// storage/serialize.ts — comment-preserving, minimal-diff edits to a data file.
//
// "Save = commit" only stays reviewable if a one-field change produces a
// one-line diff. So we never re-serialise our own model back over a file.
// Instead we parse the file into a `yaml` Document (which keeps every comment,
// key order, quote style, and structure), surgically change only the node the
// edit touches, and stringify. Untouched tasks come back untouched.
//
// One honest caveat: the `yaml` stringifier normalises flow-collection spacing
// to its canonical padded form (`[review.pdr]` → `[ review.pdr ]`) across the
// whole document. Comments, key order, and quoting are preserved byte-for-byte;
// only that inner padding is canonicalised, and only once. Everything downstream
// (edits, adds, removes) is then stable and produces the tiny diffs we want.
//
// These functions are pure text-in/text-out — no engine, no git, no DOM.

import { parseDocument, isSeq, isMap, type Document, type YAMLSeq } from "yaml";
import type { Task } from "../engine/types";

/** No line wrapping — long dependency lists must not get re-flowed mid-edit. */
const STRINGIFY = { lineWidth: 0 } as const;

/** Where a task lives inside a document: which list, and at what index. */
interface TaskLocation {
  key: string; // "tasks" | "reviews" | "gates"
  seq: YAMLSeq;
  index: number;
}

/**
 * Apply a partial edit to one task. Scalar fields are set or replaced; a value
 * of `undefined` in the patch DELETES that key. `schedule` is merged key-by-key
 * so its inline comments and flow style survive; `dependsOn` is rewritten as a
 * compact flow list. An unknown task id is a no-op (returns the text unchanged).
 */
export function applyTaskEdit(
  fileText: string,
  taskId: string,
  patch: Partial<Task>,
): string {
  const doc = parseDocument(fileText);
  const loc = findTask(doc, taskId);
  if (!loc) return fileText;

  const base = [loc.key, loc.index];
  for (const [key, val] of Object.entries(patch)) {
    const path = [...base, key];

    // schedule: merge into the existing map rather than replacing it wholesale,
    // so a duration change stays a single-scalar change on a single line. When
    // there's no schedule map yet (a spine review is unpinned in project.yaml and
    // carries none), create it as a real node in one shot — there are no comments
    // or key order to preserve, and setIn'ing keys into a bare `{}` would fail.
    if (key === "schedule" && isPlainObject(val)) {
      if (!doc.hasIn(path)) {
        const fresh = Object.fromEntries(
          Object.entries(val).filter(([, v]) => v !== undefined),
        );
        doc.setIn(path, doc.createNode(fresh));
      } else {
        for (const [k, v] of Object.entries(val)) {
          if (v === undefined) doc.deleteIn([...path, k]);
          else doc.setIn([...path, k], v);
        }
      }
      continue;
    }

    if (val === undefined) {
      doc.deleteIn(path);
      continue;
    }

    // Arrays (dependsOn) render as a compact flow list, matching our file style.
    if (Array.isArray(val)) {
      const node = doc.createNode(val);
      node.flow = true; // compact `[ … ]` list, matching our file style
      doc.setIn(path, node);
      continue;
    }

    doc.setIn(path, val);
  }

  return doc.toString(STRINGIFY);
}

/**
 * Append a task to the file's `tasks:` list, creating that list if the file
 * doesn't have one yet. Existing lines are untouched — the new task is added at
 * the end as a fresh block mapping.
 */
export function addTask(fileText: string, task: Task): string {
  const doc = parseDocument(fileText);
  let seq = doc.get("tasks");
  if (!isSeq(seq)) {
    doc.set("tasks", doc.createNode([]));
    seq = doc.get("tasks");
  }
  (seq as YAMLSeq).add(doc.createNode(task));
  return doc.toString(STRINGIFY);
}

/**
 * Remove exactly the one task with `taskId`, leaving every other task (and all
 * comments not attached to the removed node) in place. Unknown id → no-op.
 */
export function removeTask(fileText: string, taskId: string): string {
  const doc = parseDocument(fileText);
  const loc = findTask(doc, taskId);
  if (!loc) return fileText;
  loc.seq.items.splice(loc.index, 1);
  return doc.toString(STRINGIFY);
}

// ── internals ────────────────────────────────────────────────────────────────

/** Locate a task by id across the lists a data file may hold. */
function findTask(doc: Document, taskId: string): TaskLocation | null {
  for (const key of ["tasks", "reviews", "gates"]) {
    const seq = doc.get(key);
    if (!isSeq(seq)) continue;
    for (let i = 0; i < seq.items.length; i++) {
      const item = seq.items[i];
      if (isMap(item) && item.get("id") === taskId)
        return { key, seq, index: i };
    }
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
