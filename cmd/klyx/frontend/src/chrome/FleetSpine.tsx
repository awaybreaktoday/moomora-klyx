import { useFleet } from "../store/fleet";

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

  if (clusters.length === 0) return null;
  const selected = route.name === "cluster" ? route.cluster : null;

  return (
    <div
      data-testid="fleet-spine"
      style={{
        width: 30,
        flexShrink: 0,
        borderRight: "0.5px solid var(--color-border-tertiary)",
        background: "var(--color-background-secondary)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "10px 0",
      }}
    >
      {clusters.map((c) => {
        const unreachable = c.state === "Failed" || c.state === "Unconnected";
        const broken = (board[c.name]?.broken ?? 0) > 0;
        const isSelected = c.name === selected;

        let background = "var(--color-background-success)";
        let border = "0.5px solid var(--color-border-success)";
        let title = `${c.name} — ${c.state.toLowerCase()}`;
        if (unreachable) {
          background = "transparent";
          border = "0.5px dashed var(--color-border-secondary)";
          title = `${c.name} — ${c.state.toLowerCase()}${c.reason ? `: ${c.reason}` : ""}`;
        } else if (broken) {
          background = "var(--color-background-danger)";
          border = "0.5px solid var(--color-border-danger)";
          title = `${c.name} — ${board[c.name]!.broken} broken workload${board[c.name]!.broken === 1 ? "" : "s"}`;
        } else if (c.state === "Degraded") {
          background = "var(--color-background-warning)";
          border = "0.5px solid var(--color-border-warning)";
        }

        return (
          <button
            key={c.name}
            onClick={() => openCluster(c.name)}
            aria-label={`cluster ${c.name}`}
            aria-current={isSelected ? "true" : undefined}
            title={title}
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              padding: 0,
              cursor: "pointer",
              background,
              border,
              // Selection is a ring, not a color change - severity stays honest.
              boxShadow: isSelected ? "0 0 0 1.5px var(--color-text-info)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
