# scripts

Build-time scripts that run inside the GitHub Pages deploy Action (never live in the
browser). They emit `generated/meta.json` so the viewer never makes live API calls:

- per-squad-file last-commit dates (staleness — "Avionics: last updated 18 days ago")
- the task files as they existed at the newest `baseline/*` git tag (for baseline diffs)

Built in Phase 2.
