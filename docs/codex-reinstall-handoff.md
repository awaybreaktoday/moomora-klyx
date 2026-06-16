# Codex Reinstall Handoff

Date: 2026-06-16

This file is for a fresh Codex session after Mark reinstalls his Mac. Read this
first, then read `AGENTS.md`.

## Current State

Klyx has reached the daily-driver target for Mark's homelab and personal EKS
testing. The main line is currently at `v0.2.1`:

- `bdddb139 chore: bump patch dependencies`
- tag: `v0.2.1`
- remote: `origin/main`

The active working branch is:

- `codex/wails-update`

Commits on this branch ahead of `main`:

- `37c0bf22 chore: update wails alpha`
- `3c35fa7c fix: contain long fleet card names`
- `7a1631a3 feat: improve eks cluster support`

At the time this file was created, the only untracked path was:

- `sreenshots/`

Do not delete, rename, or stage that folder unless Mark explicitly asks.

## What Recently Shipped

The UI has had a major polish pass and is now considered close to daily-driver
ready:

- fleet-first board with richer health and capability data
- dark and light themes plus additional traditional themes, with midnight blue
  currently Mark's favourite
- resource menu reorganised into practical groups
- Gateway API network view improved with service/load-balancer details
- Services and EndpointSlices gained meaningful table columns
- Nodes page gained a dense board, filters, right-hand detail panel, taints,
  conditions, pods-on-node, and cordon/drain actions
- left sidebar gained capability status: Flux, Cilium, Gateway API, Prometheus
- command palette can be opened by clicking the top search bar
- long EKS ARN names are contained on fleet cards
- app icon was changed to the blue Klyx shield style Mark preferred

Release/build work also happened:

- GitHub Actions release pipeline builds macOS, Linux, and Windows artifacts
- Windows NSIS installer issues were fixed
- current release is `v0.2.1`
- Helm detection was improved for desktop launches outside a terminal
- dependencies were updated before `v0.2.1`

## Current Branch Details

The current branch is about Wails plus EKS support.

`chore: update wails alpha`:

- updates Wails v3 alpha dependency and release workflow Wails version

`fix: contain long fleet card names`:

- prevents long EKS ARN cluster names from breaking fleet card layout
- displays the name after `:cluster/` when possible

`feat: improve eks cluster support`:

- parses AWS EKS kubeconfig context ARNs
- imports EKS contexts as short fleet names while retaining the ARN as context
- derives tags: `cloud=aws`, `provider=eks`, `region`, `account`
- exposes provider/region/account in Settings DTOs
- augments desktop PATH so `aws`, `kubectl`, etc. are found when Klyx is
  launched outside a terminal
- adds friendlier auth/tooling failures, for example:
  - `AWS CLI not found - install AWS CLI v2 or ensure aws is on PATH for EKS authentication`
  - `AWS auth expired - run aws sso login for the profile used by this kubeconfig`
- preserves pre-sync watch errors so they are not hidden behind a generic
  `connect timed out after 30s`

Validation already run for the latest branch commit:

- `go test ./...`
- from `cmd/klyx/frontend`: `npm test -- --run`
- from `cmd/klyx/frontend`: `npm run build`

## Important Runtime Paths

Klyx defaults:

- fleet config: `~/.config/klyx/fleet.yaml`
- kubeconfig: `~/.kube/config`

Useful overrides:

- `KLYX_CONFIG`
- `KLYX_HELM_PATH`

EKS support assumes normal client-go exec credential behaviour. If kubeconfig
uses `aws eks get-token`, the AWS CLI must be installed and the profile/session
must be valid. For SSO-backed profiles, run `aws sso login` outside Klyx when
the session expires.

## How To Resume

1. Check the branch and status:

   ```bash
   git status --short --branch
   git log --oneline --decorate -8
   ```

2. Confirm whether Mark wants this branch merged, pushed, or tested further.

3. If testing locally:

   ```bash
   go test ./...
   cd cmd/klyx/frontend
   npm test -- --run
   npm run build
   cd ../../..
   wails3 build
   ```

4. For real desktop QA, run the Wails app against Mark's actual kubeconfig and
   check:

   - Fleet page with homelab and EKS clusters
   - EKS cluster card name containment
   - Settings import of an EKS ARN context
   - AWS auth errors when AWS CLI is missing or SSO is expired
   - Workloads, Pods, Nodes, Network, Resources, Flux, Argo CD, Helm

## Product Direction

Keep Klyx provider-agnostic but pragmatic:

- AWS/EKS should work through kubeconfig exec plugins, not a separate cloud
  account wizard
- AKS, EKS, k3s, and future providers should be identified through tags and
  capability detection
- do not turn Klyx into a desired-state editor, Helm chart installer, RBAC
  management console, or alerting platform
- keep the fleet-first model and GitOps-first vocabulary

## Near-Term Next Steps

Likely next useful work:

- run real desktop QA with the EKS cluster after reinstall
- merge or push `codex/wails-update` if Mark is happy with it
- consider whether existing EKS fleet entries should be migrated from ARN names
  to short names in `fleet.yaml`
- add provider-specific polish only where it helps daily operation, for example
  showing EKS account/region clearly in Settings or Fleet details

