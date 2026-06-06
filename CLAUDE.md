# Klyx

A platform-engineer-grade Kubernetes desktop client. Built because every existing tool (Lens, FreeLens, Headlamp, K9s, Aptakube, Portainer) treats clusters as a kubeconfig dropdown rather than a fleet, hides GitOps state behind a separate plugin, dumps CRDs as a flat alphabetical list, and renders Gateway API CRDs as raw YAML instead of the data path they actually describe.

## Owner context

Built by a Senior Platform Engineer running six AKS clusters across West Europe and North Europe (DEV/STG/PRD), with Cilium BYOCNI + ClusterMesh, Envoy Gateway replacing NGINX, FluxCD for GitOps, External Secrets Operator with Reloader, and an LGTM stack with Managed Grafana. The tool needs to work for this environment by default - not as an enterprise-tier upsell.

Also runs on a homelab k3s on AMD ROCm hardware and may end up on personal EKS labs. Provider-agnostic by design.

## What Klyx is

A native desktop application (Go + Wails) that connects to one or more Kubernetes clusters via standard kubeconfig and provides:

- Fleet-first multi-cluster overview
- GitOps reconciliation state with inline drift diffs (Flux and Argo, including coexistence)
- Gateway API topology rendering (Gateway / HTTPRoute / *TrafficPolicy graph)
- ClusterMesh-aware cross-cluster routing visualisation
- CRD browser grouped by API group with live instance counts
- Inline observability metrics from Prometheus/LGTM
- Keyboard-first command palette navigation

## What Klyx is not

Hard non-goals. Resist scope creep toward these even if a feature seems adjacent:

- Not a resource creation/editing wizard. Desired state is authored as Helm/Kustomize in Git, never hand-written through Klyx. Klyx may drive controllers and perform day-2 operations (reconcile, suspend/resume, and later scale/restart), but it never authors desired state - Git remains the source of truth.
- Not an RBAC management UI. Klyx views and operates on cluster state; it does not manage roles, bindings, or permissions.
- Not an alerting platform. Delegate to AlertManager / Grafana.
- Not a Helm chart browser or installer. That's `helm` and Flux's job.
- Not a multi-tenant SaaS. Single-user desktop binary, with optional `klyx serve` headless mode for shared team use.
- Not an Electron app. Native binary, sub-second startup, ~10-20MB.
- Not a kubectl replacement. K9s and kubectl remain the daily ops tools.

## Tech stack (locked decisions)

- **Language**: Go 1.22+
- **Native shell**: Wails v3 (https://wails.io)
- **K8s client**: client-go (informer-based for live state, never direct API calls per render)
- **Frontend**: TypeScript + React with Tabler outline icons
- **Styling**: CSS variables for theming, both light and dark mode mandatory
- **Build targets**: macOS universal (Intel + Apple Silicon), Linux x86_64 + ARM64, Windows x64 + ARM64
- **Distribution**: Homebrew tap, apt/rpm repos, AppImage, .msi, winget, scoop
- **Auto-update**: built in with per-platform signed channels

## Architecture layers

```
┌─────────────────────────────────────────────────┐
│  UI (TypeScript + React in Wails webview)       │
├─────────────────────────────────────────────────┤
│  View layer (per-feature view models)            │
│   - FleetVM, GitOpsVM, NetworkVM, CRDVM ...      │
├─────────────────────────────────────────────────┤
│  Capability detection                            │
│   - Detects Flux, Argo, Cilium, Gateway API,    │
│     ESO, Reloader, cert-manager, monitoring     │
│   - Conditional view rendering based on caps    │
├─────────────────────────────────────────────────┤
│  Data layer (Go)                                 │
│   - One informer factory per cluster             │
│   - Shared cache, watch-based, never polled      │
│   - Cross-cluster query aggregation              │
├─────────────────────────────────────────────────┤
│  Connection layer                                │
│   - kubeconfig loader with exec plugin support  │
│   - aws eks get-token, kubelogin, bearer token  │
│   - Per-cluster credential isolation             │
└─────────────────────────────────────────────────┘
```

## Design principles

See `docs/design-principles.md` for the full set. The non-negotiable ones:

1. Fleet is the root, not a dropdown.
2. GitOps is primary, not a plugin.
3. Gateway API is rendered as a graph, not a CRD list.
4. ClusterMesh is a visible edge between clusters.
5. Inline observability, not a separate Grafana tab.
6. Command palette as primary nav (`⌘K`).
7. Capability detection over assumption - render only what's installed.
8. Speak each tool's vocabulary correctly (Flux "ready/drift", Argo "synced/degraded").

## Initial milestone

Build M1 before anything else. M1 is the smallest thing that demonstrates the design works:

- Wails app skeleton with sidebar, header, command palette
- Kubeconfig connection to one cluster
- Fleet view rendering one cluster card with live data via client-go informers
- Capability detection for Flux, Argo, Cilium, Gateway API
- Light and dark mode

No GitOps view, no network topology, no CRD browser yet. Just prove the foundation works end to end.

After M1, milestones in priority order:
- M2: Multi-cluster fleet view (the killer feature)
- M3: GitOps view with Flux support
- M4: CRD browser grouped by API group
- M5: Gateway API topology view (M5-a lanes, M5-b-i Envoy policies, M5-b-ii Cilium inference shipped; M5-c ClusterMesh edges next)
- M7: Inline observability (Prom queries)
- M8: `klyx serve` headless mode
- Deferred: Argo support + coexistence (was M6) — the owner runs Flux only and Argo ships a strong UI, so the Klyx wedge is thin and it can't be native-verified here. The M3 GitOps view is already vocabulary-correct (Flux ready/drift as its own concept), so an Argo provider can be added later if Argo enters the fleet or `klyx serve` goes multi-user (where fleet-wide Argo aggregation would beat per-instance Argo UIs).

## References

- `docs/design-principles.md` - full design philosophy
- `docs/mockups.html` - six UI mockups (open in browser to view)
- `docs/brainstorm-questions.md` - open architectural questions
- `docs/example-prompts.md` - example Claude Code prompts per phase

## Working style

- Direct, principle-led, technically precise. Push back on weak assumptions.
- Prefer hyphens over em dashes.
- Concise actionable prose. Bulleting only when it earns its place.
- First-person ownership language.
- Show stress-tests of decisions before posting/committing.
- Context is a competitive advantage - bring it up front, do not ask the same question twice.
