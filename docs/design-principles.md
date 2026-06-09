# Klyx design principles

These are the design choices that make Klyx different from every existing Kubernetes GUI. Treat them as non-negotiable defaults. If a feature seems to require violating one, that is a signal to redesign the feature, not to bend the principle.

## 1. Fleet is the root, not a dropdown

Lens, FreeLens, Headlamp, K9s all treat the cluster as the unit of work and the fleet as a dropdown of kubeconfig contexts. For a six-cluster (or larger) estate, this is backwards. Klyx makes the fleet the home view and a single cluster a drilldown.

**Implication for build:** the first view a user sees on launch is a grid of all configured clusters with live health, GitOps state, and ClusterMesh peering. No "select a cluster" gate.

## 2. GitOps is primary, not a plugin

Drift detection, reconciliation state, and the actual diff (in-cluster vs Git) live alongside the resources they manage. Not in a separate Flux dashboard. Not behind a "install the Flux extension" prompt. Not as a tab that defaults to disabled.

**Implication for build:** the GitOps view is one of the top-five sidebar entries. Every workload resource shows its owning Kustomization/Application as a clickable reference. Drift diffs render inline, not in a modal.

## 3. Gateway API is rendered as a graph, not a CRD list

Every existing tool dumps `kubectl get httproute -o yaml`. Klyx renders the actual data path: Gateway -> HTTPRoute -> Service -> Pods, with ClientTrafficPolicy attached to the Gateway, BackendTrafficPolicy attached to the route, and CiliumNetworkPolicy shown at the service level.

**Implication for build:** the network view is graph-based, not table-based. Each node in the graph is interactive. Policies attached at each edge are inline-visible, not nested in click-throughs.

## 4. ClusterMesh is a visible edge between clusters

Cilium GlobalServices and cross-cluster peering surface as arrows on the topology, not buried in `cilium-cli` output. Solves the "ATM is blind to backend health" problem - you can see which cluster traffic is actually going to.

**Implication for build:** the fleet view and network view both render mesh edges where they exist. Don't fake them where they don't.

## 5. Inline observability, not a separate Grafana tab

p50/p99/rps next to the route. CPU/memory on the pod card. Reconciliation duration next to the Flux Kustomization. All sourced from Prometheus/LGTM via PromQL. Klyx queries, doesn't reinvent.

**Implication for build:** the data layer needs a Prom query client alongside the K8s client. Metrics are part of the resource model, not a separate "metrics view".

## 6. Command palette as primary nav

`⌘K` (or `Ctrl+K`) opens a fuzzy-search palette for context switching, namespace jumps, resource lookup, action execution. The sidebar is a fallback for mouse users.

**Implication for build:** the command palette is implemented before the sidebar. Every navigable surface is reachable from the palette.

## 7. Capability detection over assumption

Klyx discovers what's installed in each cluster on connect - Flux CRDs, Argo CRDs, Gateway API, Cilium, ESO, monitoring stack - and conditionally renders the relevant views. The kind cluster doesn't get an empty "GitOps" pane because it has no Flux. The homelab k3s doesn't get a phantom ClusterMesh edge.

**Implication for build:** every view has a capability gate. If the required CRDs aren't installed, the view either hides or shows a clear empty state explaining what's needed.

## 8. Speak each tool's vocabulary correctly

Flux Kustomizations are "ready" or "drifted". Argo Applications are "synced" or "degraded". A HelmRelease has a revision; an Application has a sync status and a health status. Klyx never invents a unified abstraction that flattens these into one fake type - they're not the same thing, and pretending otherwise lies about reality.

**Implication for build:** the model layer has separate types for Flux and Argo resources. The UI uses each tool's terminology when displaying its resources.

## 9. No resource creation wizards

Klyx is a viewer, not a control plane. Resources are written as Helm, Kustomize, or plain YAML in Git. The UI surfaces what's in the cluster, helps diagnose what's wrong, and links to the source location - but does not have "Create Deployment" buttons.

**Implication for build:** there are no creation forms anywhere. There are read-write actions (reconcile, suspend, delete pod, restart deployment) but no resource templating UI.

## 10. Native, not Electron

Go + Wails. Native binaries. Sub-second cold start. ~10-20MB on disk. The webview is for the UI tree, not for running a Chromium process tree.

**Implication for build:** any dependency that requires Node.js at runtime is rejected. The binary must ship statically linked.

## 11. Diagnostic lenses first, daily driver included (revised 2026-06-09)

Klyx leads with diagnostic lenses - health, ownership, traffic path, policy, observability, and failure context decide what is surfaced first. The owner has since promoted Klyx to daily driver, so standard resource coverage (pods, configmaps, secrets, services, nodes, RBAC viewing, events, logs) is now in scope - but done the Klyx way, not as a dumb kind-tree:

- Every list defaults to a diagnostic ordering (triage sort, warning-first events), never alphabetical-by-default.
- Standard kinds ship through the one generic GVR engine with a curated category layout, not fifteen bespoke tables.
- Secrets are masked until explicitly revealed. RBAC is view-only.
- Logs and events exist both contextually (attached to the pod/workload they explain) and as first-class views, because a daily driver needs the direct path too.

**Implication for build:** the test for any new surface is now "does it diagnose, explain, or operate - and does its default presentation tell you what's wrong before what exists?" A plain table is acceptable only as the body under a diagnostic default.

## Visual language

Borrowed from the mockups - see `mockups.html` for the canonical reference.

- Sentence case for everything, never Title Case or ALL CAPS
- Two font weights only: 400 regular, 500 medium
- 0.5px borders for component edges, never thicker except for the deliberate "featured" accent
- Flat surfaces. No gradients, no shadows except focus rings
- Monospace for resource names, namespaces, revisions, and any string that's a K8s identifier
- Status colours from CSS variables (success, warning, danger, info) - never hardcoded hex
- Tabler outline icons only
- Light and dark mode are both first-class. Every colour must work in both
