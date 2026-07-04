# auth-worker

A tiny (~30-line) Cloudflare Worker that performs the GitHub OAuth token exchange so
squad leads can commit from the static viewer (push access = edit rights). Free tier;
deployed in Phase 5. Not a blocker: the UI also accepts a pasted fine-grained PAT
(stored in localStorage) as a dev/fallback path, so write-back works before this exists.
