// SkeletonRows — shimmer placeholder rows shown while a list loads, replacing
// bare "Loading…" strings. Bar widths vary deterministically per row so the
// shimmer reads as a table, not a uniform block. role=status + aria-label keep
// it announced (and testable) as a loading state.
const WIDTHS = [
  ["18%", "34%", "12%", "22%"],
  ["22%", "28%", "10%", "26%"],
  ["16%", "38%", "14%", "18%"],
  ["20%", "30%", "12%", "24%"],
];

export function SkeletonRows({ rows = 6, label = "loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} style={{ paddingTop: 2 }}>
      {Array.from({ length: rows }, (_, i) => {
        const w = WIDTHS[i % WIDTHS.length];
        return (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 14,
              alignItems: "center",
              padding: "9px 8px",
              borderBottom: "0.5px solid var(--color-border-tertiary)",
              // Stagger the pulse so the table breathes instead of blinking.
              opacity: 1,
            }}
          >
            <span className="klyx-skeleton" style={{ width: 8, height: 8, borderRadius: "50%", animationDelay: `${i * 90}ms` }} />
            {w.map((width, j) => (
              <span key={j} className="klyx-skeleton" style={{ width, height: 10, animationDelay: `${i * 90}ms` }} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
