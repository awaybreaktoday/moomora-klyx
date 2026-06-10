export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 11, cursor: "pointer",
      border: on ? "0.5px solid var(--color-text-info)" : "0.5px solid var(--color-border-tertiary)",
      background: on ? "var(--color-background-info, transparent)" : "transparent",
      color: on ? "var(--color-text-info)" : "var(--color-text-tertiary)" }}>{children}</button>
  );
}
