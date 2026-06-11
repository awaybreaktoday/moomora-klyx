// EmptyState — the designed "nothing here" block: muted icon, one-line title,
// optional hint. Replaces bare "No pods." strings so empty views read as
// intentional, not unfinished. Honesty rule: the title states what IS (no
// pods), the hint says what would change it - never a cheerful filler.
export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div
      data-testid="empty-state"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "56px 20px",
        textAlign: "center",
      }}
    >
      {icon && <div style={{ color: "var(--color-text-tertiary)", opacity: 0.6, marginBottom: 2 }}>{icon}</div>}
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", maxWidth: 400, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}
