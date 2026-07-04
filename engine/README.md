# engine

The pure scheduling core. **Zero dependencies** — no packages, no DOM, no git, no
storage imports, ever (enforced by `engine/tsconfig.json` having no DOM lib and by
an ESLint `no-restricted-imports` rule). It is a plain date-calculator: merged task
graph in, computed dates / critical path / slack / conflicts out.

## Algorithm (`compute-schedule.ts`, Critical Path Method — brief §6.2)

1. **Merge + sort.** Build one dependency graph over *leaf* tasks. Summaries never
   schedule; an edge to/from a summary expands onto all of its leaves. Bad ids drop
   the edge and log a `missing-dependency`. Tarjan's SCC scan finds cycles — any
   cycle aborts with only `cycle` conflicts. Otherwise Kahn's algorithm gives a
   deterministic topological order.
2. **Forward pass.** In order, compute earliest start/finish. FS tracks a pred's
   finish, SS its start (both with lag). Auto roots start at `today`; a pinned task's
   start is *exactly* its pin, always.
3. **Anchor.** A met pin anchors itself (LS = LF = pin); otherwise true sinks anchor
   on the project's earliest finish (capability-driven default).
4. **Backward pass.** In reverse, compute latest start/finish; `slack = LS − ES`;
   `critical = slack === 0`.
5. **Roll up + check.** Summaries roll up dates/status/percent from their leaves.
   Then flag `hard-deadline-miss` and `pin-conflict` (deadline miss wins if both).

All dates are ISO strings converted to integer UTC epoch-days internally — no
local-timezone arithmetic anywhere (`date-math.ts`).

## The contract

`engine.test.ts` holds the eleven §6.3 acceptance tests verbatim in spirit, plus
edge-case guards. **That suite is the spec** — never merge engine changes with a
failing or missing test, and extend the matrix whenever behavior is added.
