# Klyx daily-driver roadmap (M9)

> **For agentic workers:** This is the standing roadmap for the autonomous daily-driver
> build (owner directive 2026-06-09, auto mode). Execute phases in order, top to
> bottom. Each phase = its own branch + subagent-driven tasks + full gate + merge to
> main. Tick checkboxes as work lands and keep this file authoritative — a fresh
> context must be able to resume from it alone.

**Goal:** Klyx becomes the owner's daily driver for everything Kubernetes — keeping
its identity (fast, informer/on-demand, capability-gated, diagnostic-lens-first,
fleet-root) while adding the standard coverage every daily driver needs: pods, live
logs, events, the common resource kinds, nodes, day-2 verbs, helm releases,
port-forward, and the long-promised command palette.

**Owner directive (verbatim intent):** existing k8s GUIs are buggy and slow; Klyx is
fast — finish it as the daily driver, keep current ideas, improve layout, shelling
out to kubectl/helm where that is the best tool. Brainstorming off, auto mode,
loop until done.

## Working agreement (auto mode)

- Subagent-driven dev per task (TDD; implementer + ONE combined spec/quality
  reviewer; adversarial scrutiny reserved for honesty-critical or lifecycle-tricky
  logic such as log streaming and severity classification).
- Full gate before merge: `go test ./...`, `go test -race` on touched packages,
  `go vet`, `gofmt -l`, `npx vitest run`, `npx tsc --noEmit`, `wails3 build` exit 0
  (from `cmd/klyx`; regenerate bindings with `wails3 generate bindings`, never
  git-add `frontend/bindings/`).
- Programmatic verification on the homelab gates merges in auto mode (context
  `kubernetes-admin@homelab-nelli` is reachable; `homelab-orange` may not be).
  Fixtures go in namespace `klyx-test`, always deleted after. GUI eyeballing is
  batched: keep a running "eyeball checklist" section at the bottom of this file
  for the owner to verify visually whenever they next run the app.
- Identity guardrails that survive the scope change: never author desired state
  (no create/edit wizards, no live YAML editing); Git remains source of truth;
  imperative day-2 verbs are allowed (delete pod, restart, scale, cordon/drain);
  destructive verbs use ConfirmDialog + the `Protected` cluster gate; rank/health
  semantics never lie (no fake denominators, nil ≠ 0); capability-gate everything
  detectable; sentence case; 0.5px borders; mono for k8s identifiers; Tabler icons;
  light+dark.
- Commits: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` retained on
  merge that line style; current model is Fable 5 — use
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` going forward.
- External CLIs: shelling out is sanctioned where client-go is the wrong tool —
  `helm` for release inspection/rollback, `kubectl` for drain and as the exec
  escape hatch (open external terminal). Detect binary presence; degrade honestly.

## Existing assets to reuse (verified 2026-06-09)

- Generic resource engine: `CRDService.ListInstances/GetInstanceDetail`
  (internal/fleet/crd.go) is dynamic-client + GVR — works for ANY kind including
  core v1; detail already returns conditions + events (by involvedObject.uid) +
  managedFields-stripped YAML. DD2 is mostly curation on top of this.
- Write-verb pattern: GitOpsService Reconcile/SetSuspend → `ActionResultDTO`,
  frontend ConfirmDialog (type-name-to-arm when `Protected`), inline action toast.
- Streaming pattern: appbridge `Emitter` + per-cluster pushLoop (GitOps watch) —
  template for log tailing.
- Severity engine: `internal/workloads` worstPodReason/rank — reuse for the pods
  lens (export what's needed; do not duplicate).
- Metrics plumbing: `ensureMetricsLocked` + InstantVector; per-pod usage queries
  already exist in fleet WorkloadMetrics (reuse for pod cpu/mem columns).
- Route model: `Route` union in store/fleet.ts + `ClusterSection` union + Sidebar
  SECTION_LABELS/ICONS + ClusterDetail switch + Placeholder exhaustiveness — the 4
  touch points for any new section.

## Phases

### DD1 — Pods lens + live logs + events (the daily core)
Branch: `feat/dd1-pods-logs-events`

- [x] T1 Go: pure pod-summary model in `internal/workloads` (reuse severity engine;
      PodSummary{Name,Namespace,Ready,Phase,Reason,Rank,Restarts,Node,IP,
      AgeSeconds,Owner{kind,name},Containers[]}) + fleet `ListPods(ctx, namespace)`
      (typed list, triage sort unhealthy-first).
- [x] T2 Go: fleet `PodDetail(ctx, ns, name)` — containers (state/image/restarts/
      req+lim), conditions, labels, owner chain, events (reuse crd events helper via
      GVR pods), YAML. appbridge PodsService: ListPods/GetPodDetail DTOs.
- [x] T3 Go: log streaming — fleet `StreamLogs(ctx, ns, pod, container, previous,
      tailLines)` using client-go GetLogs(follow) → lines pushed via Emitter events
      (`podlogs:<streamID>`); appbridge LogsService Open/Close with stream registry,
      context cancel on close/cluster-nav; cap buffer; never block the UI thread.
      ADVERSARIAL REVIEW required (lifecycle/leak/blocking).
- [x] T4 Go: events lens — fleet `ListEvents(ctx, namespace)` (core v1 events,
      warning-first sort, dedupe by count), appbridge EventsService DTO.
- [x] T5 Go: day-2 verbs — appbridge: DeletePod(cluster, ns, name),
      RolloutRestart(cluster, kind, ns, name) (patch restartedAt annotation);
      ActionResultDTO; respect Protected.
- [x] T6 FE: "pods" ClusterSection (4 nav touch points) + pods store slice + bridge +
      PodsView: triage list (dot/ns/name/ready/phase-reason/restarts/cpu-mem
      capability-gated/node/age), ns dropdown + search + needs-attention chip;
      row click → detail panel (info, conditions, owner link, events, yaml).
- [ ] T7 FE: logs pane in pod detail — follow/pause, container picker, previous
      toggle, tail-lines select, search highlight, wrap toggle, clear; auto-scroll
      with stick-to-bottom; stream cleanup on unmount/nav.
- [ ] T8 FE: "events" ClusterSection + EventsView: warning-first, type/ns filter,
      involved-object links into pods/workloads where resolvable.
- [ ] T9 FE: actions — delete pod + rollout restart (from PodsView and
      WorkloadsView rows) via ConfirmDialog; toast; refresh after action.
- [ ] T10 Gate + verify: bindings, full gate, fixtures on homelab-nelli (crashloop
      pod → red + reason; delete pod → recreated; logs stream from a chatty pod;
      events show the crashloop warnings), cleanup, merge.

### DD2 — Standard resources, curated (the resource zoo, done the Klyx way)
Branch: `feat/dd2-standard-resources`

- [ ] T1 Curated builtin catalog: extend the Resources section so the CRD browser
      gains a "Built-in" set above API groups: Workloads (Jobs, CronJobs,
      ReplicaSets), Config (ConfigMaps, Secrets), Network (Services, Ingresses,
      NetworkPolicies, EndpointSlices), Storage (PVCs, PVs, StorageClasses),
      Cluster (Namespaces, Nodes, ResourceQuotas, LimitRanges), Access (SAs, Roles,
      RoleBindings, ClusterRoles, ClusterRoleBindings — view-only). Static GVR
      table; instance list/detail reuse the existing engine; counts lazy.
- [ ] T2 Secrets honesty: masked by default in detail YAML + per-key reveal/decode
      (base64) with explicit click; never log values; copy-key button.
- [ ] T3 Nodes view (first-class, not just instance list): list with roles, version,
      taints count, conditions summary, cpu/mem capacity vs allocatable (+ live
      usage when metrics available); node detail: conditions, taints, labels,
      pods-on-node (links), kubelet/os info.
- [ ] T4 Cordon/uncordon (client-go patch unschedulable) + drain (exec kubectl,
      streamed output modal, confirm + Protected gate).
- [ ] T5 Service detail enrichment: endpoints/ready addresses inline (the "is it
      backed" question), selector → pods links.
- [ ] T6 Gate + verify on nelli (configmap/secret fixtures, node cordon/uncordon on
      a homelab node, drain dry-run), cleanup, merge.

### DD3 — Day-2 ops: scale, port-forward, exec escape hatch
Branch: `feat/dd3-day2-ops`

- [ ] T1 Scale workload (Deployment/STS replicas patch) from WorkloadsView row menu
      + confirm; shows desired change.
- [ ] T2 Port-forward manager: client-go portforward (SPDY) per target (pod or
      svc→pod resolution), local port auto/choose, active-forwards panel in
      TopBar/sidebar with stop buttons; survives view nav, dies with app; status
      events on broken pipe. ADVERSARIAL REVIEW (lifecycle/ports).
- [ ] T3 Exec escape hatch: "Open shell" on pod/container → launches OS terminal
      running `kubectl exec -it` with the right context/ns/container (macOS
      Terminal.app via `open`/osascript; document Linux/Windows fallback). Copy
      kubectl command button alongside.
- [ ] T4 Gate + verify (forward to a homelab svc and curl it locally; exec opens
      terminal), merge.

### DD4 — Helm releases (CLI-backed)
Branch: `feat/dd4-helm`

- [ ] T1 helm CLI adapter in Go: detect binary, `helm list -A -o json`,
      `helm history/status/get values/get manifest -o json` per release; parse;
      capability = binary present (degrade honestly when absent).
- [ ] T2 appbridge HelmService + "helm" inside GitOps section or own section
      (decide: it complements Flux HelmReleases — show BOTH the Flux object and the
      underlying helm release state; vocabulary stays helm's: revision, status).
- [ ] T3 Rollback verb (confirm + Protected); uninstall deliberately EXCLUDED
      (authoring/destruction of desired state stays in Git).
- [ ] T4 Gate + verify on nelli (kube-prometheus-stack history renders; values
      readable), merge.

### DD5 — Command palette + layout finish
Branch: `feat/dd5-palette-layout`

- [ ] T1 Command palette (⌘K): fuzzy index of clusters, sections, namespaces,
      workloads/pods by name (recent-cluster cached), verbs (restart/scale/logs/
      forward); keyboard-first per principle #6. No new heavy deps — small custom
      fuzzy matcher unless cmdk earns its weight.
- [ ] T2 Sidebar upgrade: labeled expandable rail (collapsed=icons, expanded=
      icon+label, persisted preference), section order: Overview, Workloads, Pods,
      Events, Resources, Network, GitOps, Helm, Observability.
- [ ] T3 Layout polish: virtualized long lists (pods/events/instances), resizable
      detail panel (drag), consistent empty/loading/error states, global namespace
      selector unified across pods/events/workloads/resources views, toast
      unification.
- [ ] T4 Keyboard map (j/k row nav, enter expand, / focus search, esc close panel)
      + a11y pass on rows (the standing backlog item).
- [ ] T5 Gate + final whole-app review + merge. Update CLAUDE.md milestone status.

## Deferred / explicitly out
- Live YAML editing & resource creation (Git owns desired state — unchanged).
- Helm install/uninstall, chart browsing.
- RBAC management (viewing shipped in DD2).
- Embedded terminal (xterm.js) — external-terminal escape hatch instead; revisit
  only if daily use demands it.
- Argo provider (unchanged from earlier deferral).

## Eyeball checklist (owner: verify visually when convenient)
*(append items here as phases merge; clear after owner confirms)*
