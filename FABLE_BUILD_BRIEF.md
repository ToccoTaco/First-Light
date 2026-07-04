```
      .
     / \        ND EXPERIMENTAL PROPULSION  ·  BUILD BRIEF
    /___\       ────────────────────────────────────────────
    |=  =|      PROJECT "FIRST LIGHT"
    |   .|      A custom Gantt / mission-timeline tool
    |  . |      for our first liquid rocket.
    | .  |
   /|  . |\     Orchestrated by: Fable 5
  / | .  | \    Implemented by:  Opus subagents
 /  |=  =|  \   Reviewed by:     Fable 5
    /____\
     |  |       // rename the codename to whatever the team likes
     |__|
```

> **How to read this doc.** This is the single source of truth for the build. It is written *to you, Fable*. Your first job is not to code — it's to turn this brief into a `CLAUDE.md` (with the model-routing rules in §2) and an architecture plan, then orchestrate the build in phases (§11). Read the whole thing before doing anything. §2 (your role) and §6 (the scheduling engine) are the two sections that matter most.

---

## 0 · TL;DR — mission summary

We're the **Notre Dame Experimental Propulsion** team — a new split from the Notre Dame Rocketry Team, in our first real year as a team. We're building our **first liquid rocket**, to competition spec, though we haven't entered a formal competition yet. We need a **custom Gantt / timeline tool** to give the whole team one overarching view of the mission and to make our goals feel tangible.

The tool is:
- **Free and self-owned.** No SaaS bills, no vendor lock-in. Data lives in a git repo; the viewer is hosted free on GitHub Pages.
- **Easily modifiable.** Clean layers, a pure scheduling core, human-readable data. Future team members should be able to change it without fear.
- **Lightweight at the top, detailed underneath.** A always-current spine of review + test gates that the whole team trusts, with each squad owning its own detail beneath.

The one architectural idea that drives everything: **build the brain, borrow the body.** Rendering a Gantt chart is a solved, free problem. The part worth building — and the part that makes this tool actually help a team that's constantly re-planning — is the *scheduling engine* that reacts intelligently when a date moves. That engine is the centerpiece of this build (§6).

**You (Fable) are the architect, orchestrator, and QA — not the coder.** See §2.

---

## 1 · Why we're building this

Every idea, task, and deadline currently lives scattered across people's heads, group chats, and Basecamp. As a first-year team building a first-of-its-kind vehicle, we need a shared picture of *what depends on what* and *what has to be true before the next thing can start*. Off-the-shelf Gantt tools are either annoying to maintain or paywall exactly the features a team like ours needs most (auto-rescheduling, critical path, baselines). So we're building our own, tuned to how a student liquid-propulsion team actually works.

The failure mode we're designing against: a giant, over-detailed chart built in September that nobody updates by October. A stale detailed chart is *worse* than a coarse one that's true. So the whole design leans toward **low maintenance burden** and **an honest top-level view that stays current.**

---

## 2 · ⇒ YOUR ROLE — orchestrator, not coder  ⟵ MOST IMPORTANT

**You are the conductor of this build. You do not write feature code yourself.** You decompose the work, hand precise briefs to Opus subagents, and QA everything that comes back. This is non-negotiable and applies to every session.

### 2.1 Model routing — write this into `CLAUDE.md` before building anything

| Role | Model | Responsibilities |
|------|-------|------------------|
| **Architect / Orchestrator / QA** | **You — Fable 5, high effort** | Architecture decisions, task decomposition, writing subagent briefs, design taste, and final QA on every returned piece. Never writes feature code directly. |
| **Implementation** | **Opus subagents** | All feature code. One subagent per task with a precise, self-contained brief. Run them in parallel where tasks are independent, sequentially where they depend on each other. |
| **Bulk / token-hungry chores** | **Cheaper model** | Bulk codebase analysis, dependency audits, repetitive refactors, computer-use — anything mechanical. They report findings back to you. |

- **Run yourself on high effort. Do not escalate to xhigh or max.**
- Before writing a single line of architecture, write the routing table above into `CLAUDE.md` as a standing rule so every future session follows it.
- You own: decomposition, orchestration, design taste, QA, and architecture. Opus owns implementation.

### 2.2 How you QA — this project makes it objective

You are not eyeballing code and guessing whether the scheduling logic is right. **The scheduling engine ships with a full acceptance-test suite (§6.3). You review by running the tests and reading the diff against the brief you gave — not by vibes.** If a subagent's engine code passes the test matrix, it is correct by definition. This is *why* we spec the engine and its tests before anything else: it turns your review step from a judgment call into a checkable contract. Extend the test matrix whenever you add engine behavior; never merge engine code with a failing or missing test.

For UI and plumbing where tests are looser, QA against the explicit acceptance criteria in each section, and against the design intent — especially the "low maintenance burden" and "top-level view stays current" principles.

---

## 3 · Core design philosophy

Three ideas, in priority order. When a decision is ambiguous, resolve it in favor of these.

1. **Build the brain, borrow the body.** Build the scheduling engine ourselves (§6). For the chart *rendering*, use a free, MIT-licensed library — do not build a Gantt renderer from scratch. Evaluate candidates at architecture time; strong options as of this writing are **DHTMLX Gantt Community Edition** (MIT, ships full source), **SVAR React Gantt core** (MIT, React-first), and **Frappe Gantt** (MIT, minimal). Pick based on how cleanly the engine's output can drive it and how modifiable it is. The smart scheduling logic is *ours*; the pixels are *borrowed*.

2. **Git is the backend.** The source of truth is human-readable data files in a GitHub repo. This gives us free hosting (GitHub Pages), free version history, free auth (push access = edit rights), and — critically — **baselines and staleness for free** (see §6.4). Leads never see the files; they use a UI, and "save" means "commit" under the hood.

3. **Three clean layers, one pure core.** Keep the **scheduling engine** (pure functions, no UI, no git), the **rendering/UI**, and the **storage** strictly separate. The engine being a pure date-calculator is what makes it trivially testable and the whole tool easily modifiable. Nothing about git or the DOM may leak into the engine.

---

## 4 · Architecture at a glance

```
   Team leads (edit via UI)
            │
            ▼
   ┌───────────────────────────┐
   │   SCHEDULING ENGINE        │   pure functions — the part we build
   │   auto-reschedule ·        │   dates · critical path · slack · conflicts
   │   critical path · slack    │
   └───────────────────────────┘
            │
            ▼
   Data files in git repo         ← source of truth · commit history = baselines
            │
            ▼
   GitHub Pages (free static)     ← serves the read-only viewer to the whole team
            │
            ▼
   Whole team (view Gantt + dashboard)
```

- **Editing** flows: lead changes something in the UI → engine recomputes → change is committed to the repo.
- **Viewing** flows: the static viewer reads the latest committed files, runs the same engine to compute the schedule, and renders the chart + dashboard.
- **Write-back auth** (leads committing from a static page) is solved either by authenticating each lead through their GitHub login, or via one tiny serverless function on a free tier. **Decide this at architecture time; don't build a real server.**

---

## 5 · Data model

Data is split into a **project file** (owned by the team lead) and **one file per squad** (owned by that squad's lead). Git merges them cleanly, so two leads editing different squads never collide — this is federated ownership with conflict isolation, for free.

### 5.1 Project file

```yaml
# project.yaml — team lead owns this: squads, the top-level spine, config
project: "ND Experimental Propulsion — First Liquid Rocket"
team: "Notre Dame Experimental Propulsion"      # split from ND Rocketry Team
mode: capability-driven                           # forward to readiness, not back from a comp date
schedule:
  calendar: calendar-days                         # people work any day of the week — no working-day skips
  today: auto                                     # engine schedules relative to the current date

squads:
  - { id: engines,    name: Engines,    color: "#D85A30" }   # injector, chamber, ignition
  - { id: fluids,     name: Fluids,     color: "#378ADD" }   # feed, tanks, pressurization
  - { id: structures, name: Structures, color: "#1D9E75" }   # airframe + ALL rocket structure
  - { id: avionics,   name: Avionics,   color: "#7F77DD" }   # flight computer, sensing, control

# The top-level spine: design reviews + test gates. See §7.
# Mostly UNPINNED for now — they float on dependencies until we commit to real dates.
reviews:  [ ... ]   # PDR, CDR, MRR, HFR, FRR — see §7
gates:    [ ... ]   # hotfire, integrated static fire, first flight — see §7
```

### 5.2 Squad file

```yaml
# subgroups/engines.yaml — the Engines lead owns this file
tasks:
  - id: engines.flight-... 	          # summary task (inferred: something points to it as parent)
    name: "Combustion chamber dev"

  - id: engines.injector-test
    name: "Injector characterization"
    parent: engines.chamber-dev
    schedule: { mode: auto, duration: 21 }        # calendar days
    dependsOn: [engines.injector-fab]             # finish-to-start, zero lag by default
    status: not-started
    confidence: guess                             # first time doing this — duration is a genuine unknown
    percent: 0                                     # optional; use only where partial progress helps
    links: ["https://.../injector.step"]
    external: { source: null, id: null, url: null }  # Basecamp seam — unused for now (§12)
```

### 5.3 Field rules

- **`id`** — namespaced (`squad.task`) so it's globally unique. This is what lets a Structures task depend on `engines.hotfire-ready` across files, and lets the engine merge every file into one graph.
- **`parent`** — a task is a *summary* if any other task names it as `parent`. Never declare "summary" by hand; infer it. Summary dates/status/percent roll up from children (§6.2).
- **`schedule.mode`** — `auto` tasks float on their dependencies and get computed by the engine; `pinned` tasks are fixed anchors with an explicit `start`. Default new tasks to `auto`; pinning is the deliberate exception.
- **`dependsOn`** — simple string list = finish-to-start, zero lag (covers ~90% of cases). Advanced object form `{ task, type: "FS"|"SS", lag }` supported for the exceptions.
- **`status`** — one of `not-started | in-progress | blocked | done`. This is the core progress signal. `blocked` must be surfaced prominently everywhere.
- **`percent`** — optional. Only meaningful on longer tasks where partial progress genuinely matters. Do not require it.
- **`confidence`** — `firm | estimate | guess`. Pass-through metadata; **never affects the scheduling math.** Renders differently (e.g. hatched/faded) so the team can see, honestly, which parts of the plan are guesses. Pairs with rolling-wave planning (§10).
- **`deadline`** — optional `{ date, hard }`. A `hard: true` deadline is immovable; the engine reports conflicts against it but never silently moves it.
- **`external`** — reserved seam for Basecamp (§12). Leave null for now; its presence means no refactor later.

---

## 6 · ⇒ THE SCHEDULING ENGINE — the centerpiece

A pure function: it takes the merged task graph and returns all computed dates, the critical path, per-task slack, and any conflicts. **No UI, no git, no storage inside it.** This is the single most important artifact in the build and the first thing to be built and tested (§11, Phase 1).

### 6.1 Input / output contract

```typescript
type ISODate = string;                 // "2026-02-14"
type Status  = "not-started" | "in-progress" | "blocked" | "done";

interface Task {
  id: string;                          // namespaced, globally unique
  name: string;
  parent?: string;                     // having children makes a task a "summary"
  milestone?: boolean;                 // zero duration
  gate?: "review" | "test";            // a milestone that fans in across squads (§7)
  schedule:
    | { mode: "auto";   duration: number }
    | { mode: "pinned"; start: ISODate; duration?: number };
  dependsOn?: (string | { task: string; type?: "FS" | "SS"; lag?: number })[];
  deadline?: { date: ISODate; hard: boolean };
  status?: Status;
  percent?: number;                    // optional
  confidence?: "firm" | "estimate" | "guess";   // pass-through, no effect on math
}

interface Config { calendar: "calendar-days"; today: ISODate; }

function computeSchedule(tasks: Task[], config: Config): ScheduleResult;

interface ScheduleResult {
  tasks: Record<string, {
    earliestStart: ISODate;  earliestFinish: ISODate;
    latestStart:   ISODate;  latestFinish:   ISODate;
    slack: number;           // days this task can slip before it becomes critical
    critical: boolean;       // slack === 0
  }>;
  criticalPath: string[];    // ordered ids
  projectFinish: ISODate;    // computed end of the whole graph
  conflicts: Conflict[];
}

type Conflict =
  | { kind: "cycle";              tasks: string[] }
  | { kind: "hard-deadline-miss"; task: string; deadline: ISODate; overrunDays: number }
  | { kind: "pin-conflict";       task: string; pinnedStart: ISODate; earliestPossible: ISODate }
  | { kind: "missing-dependency"; task: string; missing: string };
```

### 6.2 Algorithm — standard Critical Path Method, five steps

1. **Merge + sort.** Merge all squad files into one task list. Topologically sort the dependency graph. If there's a cycle, stop and emit a `cycle` conflict — nothing downstream can be trusted until it's fixed.
2. **Forward pass.** In dependency order, compute each task's earliest start (latest finish among its predecessors + lag) and earliest finish (start + duration, in **calendar days**). Milestones and gates have duration 0 — "reached" the moment their last feeder finishes.
3. **Anchor the backward pass.** *This rule matters for a capability-driven team:* if nothing downstream is pinned, anchor on the project's earliest finish (end of the longest chain). When real review/flight dates get pinned later, those pins become the anchors instead.
4. **Backward pass.** In reverse, compute latest finish and latest start. `slack = latestStart − earliestStart`. Every task with `slack === 0` is on the critical path.
5. **Roll up + check conflicts.** Summary dates = earliest child start → latest child finish; roll up status and percent too. Then flag `hard-deadline-miss` (task finishes after its hard date) and `pin-conflict` (pinned start earlier than dependencies allow).

**Two rules to enforce:**
- **Pins are constraints, never overrides.** If a pinned+hard date can't be met, emit `hard-deadline-miss` with the exact `overrunDays`. Do **not** silently move the date.
- **`status`, `percent`, `confidence` never affect the math.** They pass straight through for the UI to render. (`blocked` should be easy to surface from the result, but it changes no dates.)

### 6.3 Acceptance tests — the heart of the spec

These are the contract you QA against. Expand this matrix as you add behavior; never merge engine code with a failing or missing test.

```
TEST 1 — simple finish-to-start chain
  input:  A(auto,5d) → B(auto,3d) → C(auto,2d), today=2026-01-01
  expect: A.ES=Jan1 A.EF=Jan6;  B.ES=Jan6 B.EF=Jan9;  C.ES=Jan9 C.EF=Jan11
          projectFinish=Jan11;  criticalPath=[A,B,C];  all slack=0

TEST 2 — parallel branch produces slack
  input:  A(5d)→C(2d);  A(5d)→B(2d)→C   (C depends on both A and B)
  expect: A→B→C is the longer path, so B is critical;
          the direct A→C branch reports positive slack;  criticalPath=[A,B,C]

TEST 3 — summary rollup
  input:  parent P with children X(auto,4d) and Y(auto,6d, depends on X)
  expect: P.ES=X.ES;  P.EF=Y.EF;  P spans Jan1..Jan11;  P.percent = weighted rollup

TEST 4 — unpinned, capability-driven (our default today)
  input:  full graph with NO pinned dates
  expect: backward pass anchors on projectFinish; valid critical path + relative
          slack still produced;  conflicts=[]

TEST 5 — pinned date that can't be met
  input:  chain whose earliest finish is Mar 10, feeding a gate pinned+hard to Mar 1
  expect: conflicts=[{kind:"hard-deadline-miss", task:gate, deadline:Mar1, overrunDays:9}]
          dates NOT silently altered

TEST 6 — dependency cycle
  input:  A → B → A
  expect: conflicts=[{kind:"cycle", tasks:[A,B]}];  no schedule emitted

TEST 7 — start-to-start dependency with lag  (advanced dependency form)
  input:  A(auto,5d);  B(auto,4d) dependsOn [{task:A, type:SS, lag:2}];  today=Jan1
  expect: A.ES=Jan1 A.EF=Jan6;  B tracks A's START not finish: B.ES=A.ES+2=Jan3 B.EF=Jan7
          projectFinish=Jan7;  criticalPath=[A,B];  all slack=0

TEST 8 — missing dependency id  (a bad id must not break the chart)
  input:  A(auto,3d);  B(auto,2d) dependsOn ["engines.ghost"] (id not in graph);  today=Jan1
  expect: conflicts=[{kind:"missing-dependency", task:B, missing:"engines.ghost"}]
          the invalid edge is IGNORED, not fatal:  B.ES=Jan1 B.EF=Jan3;  A.ES=Jan1 A.EF=Jan4
          projectFinish=Jan4;  a bad id is reported, never crashes or blanks the schedule

TEST 9 — gate with mixed feeders  (real usage: PDR fanning in from all four squads)
  input:  eng.prelim(10d), flu.prelim(14d), str.prelim(7d), avi.prelim(12d) — all auto from Jan1;
          review.pdr (milestone, gate:review, 0d) dependsOn all four
  expect: gate is reached at the LATEST feeder:  review.pdr.ES=EF=Jan15 (driven by fluids)
          projectFinish=Jan15;  criticalPath=[flu.prelim, review.pdr]
          slack per feeder = Jan15 − its EF:   flu=0,  avi=2,  eng=4,  str=7
          conflicts=[]

TEST 10 — a pin that IS met becomes the anchor and creates upstream slack
  input:  A(auto,3d) → M(milestone, mode:pinned, start:Jan10);  today=Jan1
  expect: earliest possible for M is Jan4;  pinned Jan10 ≥ Jan4 → no conflict
          backward pass anchors on the pin: A.LS=Jan7, so A.slack=6 (A is NOT critical)
          projectFinish=Jan10;  the pinned milestone M is the critical constraint
          conflicts=[]

TEST 11 — status / percent / confidence are pass-through (never touch the math)
  input:  TEST 1's A→B→C chain, but B has status:blocked, percent:40, confidence:guess
  expect: dates, criticalPath, and slack are IDENTICAL to TEST 1
          status/percent/confidence are returned unchanged;  blocked is easy to surface
          from the result but changes no date;  conflicts=[]
```

### 6.4 What the engine deliberately does NOT do

- **Baselines live outside the engine.** A baseline is just running `computeSchedule` against the task files *as they existed at an earlier git commit* and diffing the two `ScheduleResult`s. No baseline fields in the schema.
- **Staleness lives outside the engine.** "Avionics hasn't been updated in 18 days" is read straight from git history (last commit touching `avionics.yaml`). No staleness fields in the schema.

Keeping the engine a pure date-calculator with zero git/storage knowledge is the whole point — it's what makes it testable and the tool modifiable.

---

## 7 · The top-level spine — gates & reviews

The master chart is not a wall of tasks. It's a small, always-current **spine of design reviews and test gates**, with each squad's work feeding the appropriate gate. This is the lightweight top-level view the whole team trusts.

### 7.1 Gates

A **gate** is a zero-duration milestone that *fans in across squads* — it opens only when every feeding squad has arrived. `gate: "review"` or `gate: "test"` so the chart can render them distinctly and offer a filtered view.

- **Tests are first-class gates**, not steps buried inside subsystem tasks. On a liquid program the test campaign is where schedule lives and dies, so proof test, cold-flow, igniter test, engine hotfire, and integrated static fire each appear as their own gate that downstream work depends on.

### 7.2 The review spectrum (our full set)

Each review is a `gate: "review"` that **authorizes the next phase of work to begin:**

```
PDR  Preliminary Design Review    → authorizes detailed design
CDR  Critical Design Review       → authorizes manufacturing planning
MRR  Manufacturing Readiness      → authorizes fabrication (cut metal)
HFR  Hot-Fire Readiness           → authorizes the engine hotfire      (guards the hotfire gate)
FRR  Flight Readiness             → authorizes first flight            (guards the flight gate)
```

**Review-guards-test pattern:** HFR and FRR each sit immediately in front of a test gate and depend on that test being *ready*. HFR fans in from "chamber built, feed system proofed, pressurization checked"; only when HFR clears does the hotfire gate open. This is how the schedule enforces "nobody lights anything before a formal readiness review." Enforce phase-gating through dependencies (e.g. detailed-design tasks depend on `review.pdr`; fabrication depends on `review.mrr`).

### 7.3 Spine example

```yaml
reviews:
  - id: review.pdr
    name: "Preliminary Design Review (PDR)"
    milestone: true
    gate: review
    dependsOn: [engines.prelim-design, fluids.prelim-design,
                structures.prelim-design, avionics.prelim-design]
    # schedule: { mode: pinned, start: ... }  ← add a real date when we set one

  - id: review.cdr   # depends on review.pdr + each squad's detailed design
  - id: review.mrr   # depends on review.cdr  → authorizes fabrication
  - id: review.hfr   # depends on chamber/feed/pressurization readiness → guards hotfire
  - id: review.frr   # depends on integrated static fire + airframe + avionics → guards flight

gates:
  - id: gate.engine-hotfire
    name: "First engine hotfire"
    milestone: true
    gate: test
    dependsOn: [review.hfr, engines.chamber-ready, fluids.feed-ready, fluids.pressurization-ready]
  - id: gate.integrated-static-fire   # depends on hotfire + structures.tank-integration
  - id: gate.first-flight             # depends on review.frr + integrated static fire + airframe + avionics
```

### 7.4 Squad coupling to encode

Engines and Fluids are tightly coupled and converge on the **hotfire** (injector/chamber/ignition meet feed/tanks/pressurization). Structures and Avionics then converge with them on **integrated vehicle tests** and **first flight**. Most interesting cross-squad dependencies will live at these convergence points.

---

## 8 · The editing UI

Leads interact with a real graphical UI. **They never touch a raw data file.** "Save" commits to git invisibly.

- **Two-tier editing** (protects the "don't burden the leads" principle):
  - *Quick* — drag a bar to change dates; one click on a bar sets/cycles its status. No form needed for the 90% case.
  - *Full* — a side panel for real restructuring (dependencies, timing mode, deadlines).
- **Timing toggle** in the panel: **Auto · after dependency** vs **Pinned to a date.** Default auto. This is the engine's `mode` surfaced to the user, and it's what makes auto-reschedule feel like magic.
- **Dependencies via a picker** (chips: "depends on: PCB schematic"), *not* drag-to-connect. Drag-to-connect can come later as a bonus; the picker is the reliable primary path.
- **Status buckets** (not-started / in-progress / blocked / done) as the core control, with an **optional percent** field on longer tasks. Surface `blocked` prominently.
- **Hard-deadline toggle** and **milestone toggle** in the panel.
- **Default view = the lead's own squad, filtered**, with one click to zoom out to the master spine. Cross-squad dependencies are set by picking another squad's *published gates/milestones* — never their internal tasks.

---

## 9 · The dashboard — make the goals tangible

A landing view distinct from the chart, built to make progress *felt*:

- **Countdown** to the next gate (and later, to competition once we enter one).
- **Progress rollups** per squad and overall, from status buckets.
- **One baseline slippage number** — e.g. "projected first-flight readiness has moved 9 days later since <baseline commit>." (Chart itself gets a "compare to baseline" toggle that overlays faint ghost bars; the dashboard just shows the single headline number.)
- **Critical-path health** at a glance.
- **Blocked items**, highlighted.
- **Staleness flags** for the team lead — "Avionics: last updated 18 days ago" — so we know exactly where to nudge (or update on a squad's behalf) rather than chasing everyone. Derived from git history.
- **Review-only filtered view** — the one-slide "spine" version of our year, for showing the parent ND Rocketry Team or a faculty advisor.

---

## 10 · Planning philosophy to bake in

- **Rolling-wave planning.** We are *not* expected to know every task up front. Plan the near term in detail; leave the far term as coarse gates with target dates, and fill in detail as each phase approaches. A `guess` today becomes an `estimate`, then `firm`. The UI should make this comfortable, not penalize it.
- **Right-sized detail.** Leaf tasks roughly 3 days–2 weeks. Longer than ~2 weeks → break it down. Shorter than a couple days → you're micromanaging. Err *coarser* than a company would; our labor is volunteer and turnover is high.
- **Protect the top-level spine's accuracy above all.** Detail where it's actionable, coarse where it's speculative.

---

## 11 · Build sequence — mission phases (stop and check in at each)

We build **correctness-first**, not design-first: for this project the risk lives in the scheduling logic, so the engine and its tests are the spec. Nail the brain, then wrap it.

- **Phase 0 — Flight plan.** Write `CLAUDE.md` (with the §2 model-routing rules), stand up the repo skeleton and the three-layer structure. *Check in: confirm architecture + routing before building.*
- **Phase 1 — The engine.** Build `computeSchedule` as pure functions with the full §6.3 test suite passing. Nothing renders yet; the brain works and is proven. *Check in.*
- **Phase 2 — Data layer.** Schema loading/parsing/merging of squad files; commit-on-save write-back; git-derived baseline diff and staleness reads. *Check in.*
- **Phase 3 — Rendering + editing UI.** Choose the free MIT library; drive it from the engine output; build two-tier editing, the auto/pinned toggle, the dependency picker, squad filtering. *Check in screen by screen on look + feel.*
- **Phase 4 — Dashboard.** Countdown, rollups, baseline headline number, blocked + staleness surfacing, review-only view. *Check in.*
- **Phase 5 — Deploy.** GitHub Pages + the chosen write-back auth mechanism. *Check in.*

Do not run ahead of a check-in. Each phase ends with a working, reviewable slice.

---

## 12 · Out of scope for v1 (deferred, seams left ready)

- **Basecamp integration.** Later: granular to-dos live in Basecamp, big blocks live on the chart; a summary task links to a Basecamp to-do list and pulls its rollup progress. The `external` field is the seam — leave it null now so this is a drop-in, not a refactor. (Basecamp has a REST API exposing projects and to-do lists.)
- **Reduced-capacity calendar** (finals weeks, breaks as low/no-work date ranges the engine stretches around). Easy to add to the engine later; not now.
- **Drag-to-connect dependencies** (picker ships first).
- **Per-person assignment** (squad-level ownership is enough for v1; leave room for an optional assignee field).
- **Pinned competition dates** (added the moment we enter a competition; the hard-deadline machinery is already there waiting).

---

## 13 · Working agreement — how to check in well

- End each phase with a working slice and a short, plain-language summary of what changed and what you want reacted to. We're a student team; write for a smart teammate, not a compiler.
- Flag any decision this brief didn't cover rather than guessing silently — but make a sensible default choice so we're never blocked.
- When you delegate, give each Opus subagent a self-contained brief with its slice of this doc, its acceptance criteria, and the interfaces it must match. Keep the engine's test suite as the contract for anything touching scheduling.
- Optimize every choice for the two north stars: **low maintenance burden** and **a top-level view that stays true.**

---

## 14 · Environment & repo layout (starting point — you may refine)

```
/                      static viewer (GitHub Pages serves this)
/engine                the pure scheduling core + its test suite   ← Phase 1
/data
  project.yaml         team lead's file: squads, spine, config
  /subgroups
    engines.yaml       each squad lead owns their file
    fluids.yaml
    structures.yaml
    avionics.yaml
/ui                    rendering + editing (built on the chosen MIT library)
/dashboard             countdown, rollups, staleness, review-only view
CLAUDE.md              your standing rules — model routing lives here (§2)
```

- Config/secrets (if any write-back function needs them) go in a git-ignored env file with placeholders stubbed for later.
- Keep the engine importable and runnable on its own, with no dependency on the UI or git — that separation is load-bearing.

```
        ·  ·   ✦   ·        ·   ✦
   ·   T-minus: let's build it.   ·   ✦
 ✦        ·          ·       ·
```
