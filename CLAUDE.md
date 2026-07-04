# CLAUDE.md — Project "First Light"

Mission-timeline / Gantt tool for **Notre Dame Experimental Propulsion** (our first liquid rocket).

**Full spec: `FABLE_BUILD_BRIEF.md` — read it before acting.** This file holds the standing rules that apply to *every* session and is loaded automatically as context. The rules below are locked. The Phase-0 section at the bottom has blanks that you (Fable) fill in *after* you make the architecture calls — do not guess them earlier.

---

## Model routing — non-negotiable

| Role | Model | Owns |
|------|-------|------|
| **Architect / Orchestrator / QA** | **Fable 5, high effort** (not xhigh/max) | Architecture, decomposition, subagent briefs, design taste, final QA. **Never writes feature code directly.** |
| **Implementation** | **Opus subagents** | All feature code. One subagent per task with a precise, self-contained brief. Parallel where independent, sequential where dependent. |
| **Bulk / token-hungry chores** | **Cheaper model** | Bulk codebase analysis, dependency audits, repetitive refactors, computer-use. Reports back. |

You are the conductor. Decompose → brief → delegate → QA. If you catch yourself writing feature code, stop and delegate it.

---

## How QA works here — objective, not vibes

- The scheduling engine ships a **full acceptance-test suite** (brief §6.3, eleven cases). Review engine work by **running the tests and reading the diff against the brief** — never by eyeballing logic.
- **Never merge engine code with a failing or missing test.** Extend the matrix whenever you add engine behavior.
- For UI and plumbing, QA against each section's acceptance criteria and the two north stars below.

---

## Architecture rules

- **Build the brain, borrow the body.** Build the scheduling engine ourselves; use a free MIT-licensed library for chart *rendering* — do not build a renderer from scratch.
- **Git is the backend.** Human-readable data files are the source of truth; "save" means "commit"; **baselines and staleness derive from git history, not from schema fields.**
- **Three clean layers, one pure core:** `engine` (pure functions — no UI, no git, no storage) · `rendering/UI` · `storage`. Nothing about git or the DOM may leak into the engine. That purity is what makes it testable and the tool modifiable.

---

## North stars — break every tie with these

1. **Low maintenance burden** for the squad leads.
2. **A top-level view that stays true.**

---

## Working agreement

- Build in **phases** (brief §11), engine-first. Each phase ends with a working, reviewable slice and a short plain-language summary. **Stop and check in at each gate — do not run ahead.**
- Flag any decision the brief didn't cover, but make a sensible default so we're never blocked.
- Write for a smart teammate, not a compiler.

---

## Phase 0 — Architecture calls (made 2026-07-04, reviewed & approved)

- [x] **Rendering library:** **DHTMLX Gantt Community Edition (MIT, v10+)**, isolated behind `ui/gantt-adapter.ts` so it's swappable. Its PRO-only features (auto-scheduling, critical path) are exactly what our engine does — we only borrow pixels; its auto-scheduler stays off. Runner-up was SVAR React Gantt (MIT since v2.4, but young and Svelte-cored); Frappe Gantt disqualified (no task hierarchy). ⚠️ Baseline ghost-bar overlays are PRO-gated → custom overlay via `gantt.getTaskPosition()` in Phase 4; de-scopes to v1.1 if hostile. Dashboard slippage headline is renderer-independent and unaffected.
- [x] **Framework / language / build tooling:** TypeScript + React 18 + Vite; Vitest for tests; ESLint + Prettier; npm. Engine purity enforced mechanically: `/engine` has its own tsconfig (no DOM lib) and an ESLint `no-restricted-imports` rule (no imports from `/ui`, `/storage`, or any package).
- [x] **Repo layout & paths:** brief §14 plus `/auth-worker` (Cloudflare Worker, Phase 5) and `/scripts` (build-time staleness/baseline metadata → `generated/meta.json`). Vite root = repo root; `index.html` is the viewer entry.
- [x] **Build command:** `npm run build` (tsc + vite build)
- [x] **Test command:** `npm test` (vitest run — the engine acceptance suite lives here)
- [x] **Lint command:** `npm run lint` (eslint; formatting via `npm run format`)
- [x] **Write-back auth mechanism:** GitHub OAuth login + one ~30-line Cloudflare Worker (free tier) for the token exchange; saves = commits via GitHub REST Contents API from the browser (one squad file per save). Push access = edit rights. Fallback/dev mode: fine-grained PAT pasted into a settings field (localStorage).
- [x] **Deploy target:** GitHub Pages via Actions — confirmed. Baselines = git tags (newest `baseline/*` wins); staleness + baseline data precomputed at deploy time, never live API calls from the viewer.

*These calls are approved. This file is now the living operating manual for the build.*
