import type { CSSProperties } from "react";

type KlyxMarkProps = {
  size?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
};

export function KlyxMark({ size = 28, title, className, style }: KlyxMarkProps) {
  const labelled = Boolean(title);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {title && <title>{title}</title>}
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="1.6" fill="#14243a" stroke="#6fa7e8" strokeWidth="1.3" />
      <path d="M12 5.25 16.4 7.8v8.4L12 18.75 7.6 16.2V7.8L12 5.25Z" fill="none" stroke="#9fcaff" strokeWidth="1.15" strokeLinejoin="round" />
      <path d="M10.75 8.35v7.3M10.75 12l3.45-2.55M10.75 12l3.45 2.55" fill="none" stroke="#9fcaff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
