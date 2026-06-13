# Klyx

A platform-engineer-grade Kubernetes desktop client.

## Why

Every existing Kubernetes GUI (Lens, FreeLens, Headlamp, K9s, Aptakube, Portainer, Rancher) has the same problems:

- Single-cluster mindset - the fleet is a kubeconfig dropdown
- GitOps state hidden behind a plugin (or absent entirely)
- CRDs dumped as a flat alphabetical list with no API group structure
- Gateway API CRDs rendered as raw YAML, not the data path they describe
- No ClusterMesh awareness
- Electron - slow startup, 150MB+ binaries
- Either single-user OR enterprise SaaS, nothing in between

Klyx is opinionated about all of these. See `CLAUDE.md` for the full brief.

## Tech stack

- Go + Wails (native binary, no Electron)
- TypeScript + React in the webview
- client-go informer-based data layer
- Builds for macOS, Linux, Windows

## Repository layout

```
klyx/
├── CLAUDE.md                    # primary brief for AI-assisted work
├── README.md                    # this file
├── docs/
│   ├── design-principles.md     # full design philosophy
│   ├── brainstorm-questions.md  # open architectural questions
│   ├── example-prompts.md       # Claude Code prompts per phase
│   └── mockups.html             # six UI mockups (open in browser)
├── cmd/klyx/                    # Wails desktop app and React frontend
├── cmd/klyxctl/                 # CLI entry point
└── internal/                    # fleet, capability, GitOps, Gateway, metrics, and bridge layers
```

## Status

Klyx is implemented beyond the initial foundation: fleet overview, Flux and
Argo CD lenses, CRD/resource browsing, Gateway topology, inline metrics, and
daily-driver Kubernetes operations are present. See `AGENTS.md` and the
`docs/superpowers/plans/` history for the current milestone context.
