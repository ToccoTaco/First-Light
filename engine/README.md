# engine

The pure scheduling core. **Zero dependencies** — no packages, no DOM, no git, no
storage imports, ever (enforced by `engine/tsconfig.json` having no DOM lib and by
an ESLint `no-restricted-imports` rule). It is a plain date-calculator: merged task
graph in, computed dates / critical path / slack / conflicts out.

The full `computeSchedule` implementation and its acceptance-test suite (§6.3) arrive
in Phase 1. This folder currently holds only the §6.1 type contract and a smoke test.
