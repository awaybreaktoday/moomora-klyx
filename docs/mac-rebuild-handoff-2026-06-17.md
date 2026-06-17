# Klyx handoff — 2026-06-17 (Mac rebuild)

Written before Mark wipes his Mac. Read this, then `CLAUDE.md` and `AGENTS.md`.
Everything below is already on `origin/main` — nothing lives only on the old
machine. (Note: Claude Code's per-project memory lives in a container volume and
does NOT survive a wipe, so the durable record is this file + the repo.)

## Current state

- `origin/main` is at the M10 merge: **PR #3 "M10: Flux diagnosis depth"**
  (merge commit `1accf9f`), branch `feat/m10-flux-diagnosis` deleted.
- All internal Go packages pass, `go vet` clean, frontend vitest (66) pass,
  `tsc` clean. Verified on `main`.

### Milestone status (see CLAUDE.md for the full list)
- Shipped: M1–M7, M9, M6, **M10 (Flux diagnosis depth)**.
- Remaining: **M5-c** (ClusterMesh edges) and **M8** (`klyx serve` headless mode).

### M10 — what shipped (Flux view)
Plan + spec: `docs/superpowers/{plans,specs}/2026-06-17-klyx-flux-diagnosis*`.
- M10-a Source health — watches the 5 source kinds; bound-source health in the
  detail panel (failing source is the headline); a `sources` filter.
- M10-b Reconcile with source (`flux reconcile … --with-source`).
- M10-c Failing-condition reason chip on the row + inspector.
- M10-d dependsOn — "Depends on" section + "blocked by <dep>" on DependencyNotReady.
- M10-e Drift surface — reads the controller's own Events (involvedObject),
  flags drift/Warnings. Zero credentials, multi-cloud for free.
- M10-f On-demand `flux diff` — gated to suspended/apply-failing Kustomizations,
  via new `internal/fluxcli` (mirrors `internal/helmcli`). Hidden when `flux`
  is not on PATH.
- Fix: HelmRelease row showed a stale chart version (status.history is
  newest-first; now picks max `version`); the apply-failed heuristic is gated to
  Kustomization (HelmRelease v2 has no lastAppliedRevision).

### Open follow-up
- **M10-f path** — `flux diff --path` defaults to the resource's `spec.path`,
  which only resolves when Klyx's working dir is the local repo. A per-cluster
  "local clone root" config would let it build `repoRoot/spec.path` reliably.

## Rebuilding the dev environment (devcontainer)

The devcontainer (`.devcontainer/devcontainer.json`) ships Node 24, kubectl,
helm, docker, gh — but **NOT Go** and **NOT the Wails CLI**. To work on Klyx:

1. **Go** (module needs 1.26.4): the container had no Go; install it —
   `curl -sL https://go.dev/dl/go1.26.4.linux-arm64.tar.gz | sudo tar -C /usr/local -xz`
   then use `/usr/local/go/bin`. (Adding a Go devcontainer feature would remove
   this manual step — worth doing.)
2. **Frontend deps**: `cd cmd/klyx/frontend && npm ci`. The vitest runner
   (rolldown) sometimes loses its native optional binding
   (`@rolldown/binding-linux-arm64-gnu`, the known npm optional-deps bug) — if
   vitest errors with "Cannot find native binding", run
   `npm i @rolldown/binding-linux-arm64-gnu --no-save` and re-run.
3. **Tests**: `go test ./internal/...` (the root `make test` / `go test ./...`
   fails in this container because `cmd/klyx` embeds `frontend/dist`, which only
   exists after a Wails build — test `./internal/...` directly). Frontend:
   `npx vitest run`. `npx tsc --noEmit` still shows pre-existing
   `bindings/github.com/...` errors because the Wails-generated `bindings/` dir
   is untracked and only created by `wails3 build` — filter those out.

## Building / running the app

`wails3` is not in the container, and a Linux build can't run as a macOS app.
Two supported paths:

- **On the Mac** (Homebrew Go): add `~/go/bin` to PATH (do NOT set GOROOT —
  Homebrew handles it), then
  `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.103`,
  `wails3 doctor`, then `task dev` (hot reload) or `task package` (.app bundle)
  from the repo root. Only extra system dep on macOS is Xcode CLT
  (`xcode-select --install`); WebKit is system-provided.
- **Cloud build (no local Wails)** — the `release` workflow has a macOS job.
  Actions → release → Run workflow → pick the branch, set a SemVer `version`,
  `publish_release: false` → download the `klyx-<version>-darwin-universal`
  artifact (a zip of `klyx.app`). Unsigned, so first launch is right-click →
  Open. Same as how M10 was verified.

## Git / auth notes

- SSH to GitHub works from the container (key is available via agent). `gh` is
  **not** authenticated there and there's no token — so PRs are raised from the
  web UI or by running `gh auth login` in-session. Pushing branches over SSH
  works fine.
