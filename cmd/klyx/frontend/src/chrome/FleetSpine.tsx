import { useState } from "react";
import { IconChevronRight, IconChevronLeft } from "@tabler/icons-react";
import { useFleet } from "../store/fleet";

// spineCodes derives a short (2-char) identifying code per cluster so the
// spine blocks are readable at a glance, not just on hover. First choice is
// the hyphen-segment initials ("homelab-blue" -> "hb", "prd-weu" -> "pw");
// when two clusters collide, those fall back to the first two letters of
// their LAST segment ("bl", "ne"); a final collision falls back to the first
// two letters of the full name. Codes are stable for a given fleet.
export function spineCodes(names: string[]): Record<string, string> {
  const initials = (n: string) => {
    const segs = n.split("-").filter(Boolean);
    if (segs.length === 1) return segs[0].slice(0, 2);
    return (segs[0][0] + segs[segs.length - 1][0]).slice(0, 2);
  };
  const lastSeg = (n: string) => {
    const segs = n.split("-").filter(Boolean);
    return segs[segs.length - 1].slice(0, 2);
  };

  const codes: Record<string, string> = {};
  for (const n of names) codes[n] = initials(n);

  const dupes = (m: Record<string, string>) => {
    const seen = new Map<string, string[]>();
    for (const [n, c] of Object.entries(m)) seen.set(c, [...(seen.get(c) ?? []), n]);
    return [...seen.values()].filter((g) => g.length > 1).flat();
  };

  for (const n of dupes(codes)) codes[n] = lastSeg(n);
  for (const n of dupes(codes)) codes[n] = n.slice(0, 2);
  return codes;
}

// FleetSpine — design principle 1 taken literally: the fleet never leaves the
// screen. A slim strip of one block per cluster, visible from every view, so
// prd-weu going amber is noticed while tailing logs on nelli. Severity comes
// from the conn state that the fleet push loop already streams; when the fleet
// board has been fetched (fleet view visited), a broken-workloads count
// upgrades the block to red. One click switches cluster from anywhere.
export function FleetSpine() {
  const clusters = useFleet((s) => s.clusters);
  const board = useFleet((s) => s.fleetBoard);
  const route = useFleet((s) => s.route);
  const openCluster = useFleet((s) => s.openCluster);
  // Width is the user's call (persisted): slim code blocks, or expanded with
  // full cluster names once the fleet outgrows two-letter codes.
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem("klyx-spine-expanded") === "1"; } catch { return false; }
  });
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try { localStorage.setItem("klyx-spine-expanded", next ? "1" : "0"); } catch { /* noop */ }
  };

  if (clusters.length === 0) return null;
  const selected = route.name === "cluster" ? route.cluster : null;
  const codes = spineCodes(clusters.map((c) => c.name));

  return (
    <div
      data-testid="fleet-spine"
      style={{
        width: expanded ? 118 : 30,
        flexShrink: 0,
        borderRight: "0.5px solid var(--color-border-tertiary)",
        background: "var(--color-background-secondary)",
        display: "flex",
        flexDirection: "column",
        alignItems: expanded ? "stretch" : "center",
        gap: 6,
        padding: expanded ? "10px 6px" : "10px 0",
      }}
    >
      {clusters.map((c) => {
        const unreachable = c.state === "Failed" || c.state === "Unconnected";
        const broken = (board[c.name]?.broken ?? 0) > 0;
        const isSelected = c.name === selected;

        let background = "var(--color-background-success)";
        let border = "0.5px solid var(--color-border-success)";
        let color = "var(--color-text-success)";
        let title = `${c.name} — ${c.state.toLowerCase()}`;
        if (unreachable) {
          background = "transparent";
          border = "0.5px dashed var(--color-border-secondary)";
          color = "var(--color-text-tertiary)";
          title = `${c.name} — ${c.state.toLowerCase()}${c.reason ? `: ${c.reason}` : ""}`;
        } else if (broken) {
          background = "var(--color-background-danger)";
          border = "0.5px solid var(--color-border-danger)";
          color = "var(--color-text-danger)";
          title = `${c.name} — ${board[c.name]!.broken} broken workload${board[c.name]!.broken === 1 ? "" : "s"}`;
        } else if (c.state === "Degraded") {
          background = "var(--color-background-warning)";
          border = "0.5px solid var(--color-border-warning)";
          color = "var(--color-text-warning)";
        }

        if (expanded) {
          const brokenCount = board[c.name]?.broken ?? null;
          return (
            <button
              key={c.name}
              onClick={() => openCluster(c.name)}
              aria-label={`cluster ${c.name}`}
              aria-current={isSelected ? "true" : undefined}
              title={title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 6px",
                borderRadius: 4,
                cursor: "pointer",
                background: "transparent",
                border: "0.5px solid transparent",
                boxShadow: isSelected ? "inset 2px 0 0 var(--color-text-info)" : undefined,
                textAlign: "left",
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0, background, border }} />
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1,
                color: unreachable ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
              }}>{c.name}</span>
              {brokenCount != null && brokenCount > 0 && (
                <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--color-text-danger)", flexShrink: 0 }}>{brokenCount}</span>
              )}
            </button>
          );
        }
        return (
          <button
            key={c.name}
            onClick={() => openCluster(c.name)}
            aria-label={`cluster ${c.name}`}
            aria-current={isSelected ? "true" : undefined}
            title={title}
            style={{
              width: 22,
              height: 18,
              borderRadius: 4,
              padding: 0,
              cursor: "pointer",
              background,
              border,
              color,
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              lineHeight: 1,
              // Selection is a ring, not a color change - severity stays honest.
              boxShadow: isSelected ? "0 0 0 1.5px var(--color-text-info)" : undefined,
            }}
          >
            {codes[c.name]}
          </button>
        );
      })}
      <button
        onClick={toggle}
        aria-label={expanded ? "collapse fleet spine" : "expand fleet spine"}
        title={expanded ? "collapse" : "expand"}
        style={{
          marginTop: "auto",
          alignSelf: "center",
          width: 20, height: 20,
          padding: 0, border: "none", background: "transparent",
          cursor: "pointer", color: "var(--color-text-tertiary)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {expanded ? <IconChevronLeft size={13} stroke={1.5} /> : <IconChevronRight size={13} stroke={1.5} />}
      </button>
    </div>
  );
}
