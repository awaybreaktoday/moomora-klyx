# Example Claude Code prompts

Use these as starting points. Each is calibrated for a different phase of work. Adapt freely.

## Starting fresh - first session

```
Read CLAUDE.md, docs/design-principles.md, and docs/brainstorm-questions.md before responding.

Then walk me through your understanding of what Klyx is, what makes it different from existing tools, and what the M1 milestone requires. Push back on anything in the brief that seems weak or under-specified. Identify the three biggest risks you see in the design.

Do not write any code yet. I want to align on direction first.
```

## Brainstorming the data layer architecture

```
Read CLAUDE.md and docs/brainstorm-questions.md sections Q1-Q3.

Brainstorm the data layer architecture. Specifically:

- One informer factory per cluster vs a shared client with multiplexed watches
- Memory and CPU profile for 6-cluster fleet view with ~500 pods, ~50 deployments, ~100 services per cluster
- How to handle cluster connection failures without cascading into other clusters
- Lazy informer initialisation - only spin up watches for resource types currently being viewed

Sketch the Go package layout you would use. Identify the trade-offs. Give me three options ranked from "safest" to "most efficient" with the reasoning.

No code yet - I want the design discussion first.
```

## Brainstorming capability detection

```
Read CLAUDE.md and docs/brainstorm-questions.md Q4 and Q5.

Brainstorm the capability detection layer. The minimum viable version is "is CRD X installed in the cluster". The realistic version needs to handle:

- Tool installed but controller crashlooping (Flux present but useless)
- Tool installed with reduced functionality (Flux without Notification controller)
- Multiple tools providing overlapping functionality (Flux AND Argo, or Cilium AND another CNI)

Sketch a Go interface for the Capability type and the CapabilityDetector. Identify what information needs to flow from detection to the view layer to drive conditional rendering. Show how the GitOpsCapability and NetworkCapability would differ in shape.

Push back if the design principles do not give you enough to decide. List the open questions.
```

## Starting the build - M1 skeleton

```
Read CLAUDE.md.

Create the project skeleton for the M1 milestone:

1. Go module structure with cmd/klyx/main.go
2. Wails v3 application setup with a sidebar layout, header, and command palette
3. A minimal data layer package that loads kubeconfig and connects to one cluster via client-go
4. A capability detector that checks for Flux, Argo, Cilium, Gateway API CRDs
5. A fleet view that renders a single cluster card with name, node count, pod count, and capabilities detected

Use the visual language from docs/mockups.html. Light and dark mode both required.

Lay out the directory structure before writing files. Confirm the structure with me before generating code.
```

## Building the fleet view

```
Read CLAUDE.md, docs/design-principles.md, and docs/mockups.html (mockup 1 and mockup 4 are the fleet view).

Implement the fleet view. The data layer is already in place - it exposes a ClusterStore that provides live cluster state across N clusters via informers.

I need:
- A FleetView React component that renders the grid of cluster cards
- A ClusterCard component matching the mockup design
- Filter pills for environment, region, and provider
- A search input that filters by cluster name
- Loading skeleton for clusters that have not finished initial sync
- An error state for clusters that are unreachable

Use CSS variables for theming. Tabler outline icons only. Sentence case throughout.

Show me the component tree and prop interfaces before writing the implementation.
```

## Building the GitOps view with coexistence

```
Read CLAUDE.md, docs/design-principles.md principle 8, and docs/mockups.html (mockups 2 and 6).

Implement the GitOps view including Flux/Argo coexistence mode.

Detection logic:
- Flux present if kustomize.toolkit.fluxcd.io and helm.toolkit.fluxcd.io CRDs exist
- Argo present if argoproj.io CRDs exist
- Coexistence if both
- Split-brain detection: a resource carrying both kustomize.toolkit.fluxcd.io/name and argocd.argoproj.io/instance labels

UI requirements:
- Two summary cards (Flux, Argo) when coexistence detected
- Filter pills All / Flux / Argo / Conflicts
- Resource list with per-row owner icon and tag
- Split-brain banner at top when conflicts exist
- Resolve workflow side panel showing both reconcilers' rendered manifests

Speak each tool's vocabulary correctly. Flux uses "ready/drift", Argo uses "synced/degraded".

Sketch the data model first. Confirm before implementing.
```

## Reviewing a design decision

```
Read CLAUDE.md and docs/design-principles.md.

I am considering [paste design decision here].

Walk through whether this aligns with the design principles. Identify which principles it strengthens and which it weakens. If it conflicts with a principle, tell me directly - do not soften it.

Recommend a path forward, or recommend rejecting the change. Justify your recommendation.
```

## Stress-testing a feature design

```
Read CLAUDE.md and docs/design-principles.md.

I am proposing the following feature: [paste feature description here].

Stress-test this design. Find the failure modes. Specifically check:

- Does it violate any of the non-negotiable principles?
- Does it work across AKS, EKS, k3s, kind, and homelab clusters?
- Does it handle capability gaps gracefully (cluster missing the relevant CRDs)?
- Does it scale to 30 clusters / 100 namespaces per cluster / 1000 resources per namespace?
- Does it scale down to a single-node homelab?
- Does it speak the correct tool vocabulary?
- Is the keyboard-first navigation path obvious?

Push back hard if any of these checks fail.
```

## Code review style prompt

```
Read CLAUDE.md and docs/design-principles.md.

Review the diff I am about to share. Focus on:

- Whether the change is consistent with the design principles
- Whether it introduces a runtime dependency we cannot ship
- Whether it adds an Electron-style abstraction we are deliberately avoiding
- Whether it handles capability gaps gracefully
- Whether it speaks the correct tool vocabulary
- Whether dark mode works
- Whether keyboard-only users can reach the new functionality

If something does not match the design principles, say so directly. Suggest the principled alternative.

Here is the diff:

[paste diff]
```
