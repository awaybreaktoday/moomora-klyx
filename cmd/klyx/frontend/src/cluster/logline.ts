/**
 * logline.ts — pure log-line parsing helpers.
 *
 * No React, no side-effects. Runs per rendered line (≤2000).
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "none";

export interface ParsedLine {
  level: LogLevel;
  /** Number of leading characters to render dimmed (timestamp / klog prefix). 0 = no dim. */
  dimPrefixLen: number;
  /** Raw text (ANSI already stripped by callers if desired). */
  text: string;
}

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

// Matches ESC [ ... m colour sequences and ESC [ K (erase-to-EOL).
const RE_ANSI = /\x1b\[[0-9;]*[mK]/g;

export function stripAnsi(s: string): string {
  return s.replace(RE_ANSI, "");
}

// ---------------------------------------------------------------------------
// Level detection
// ---------------------------------------------------------------------------

// klog prefix: I/W/E/F followed by 4 digits and a space  e.g. "I0609 22:26:09.484068  1 controller.go:75]"
const RE_KLOG_PREFIX = /^([IWEF])\d{4}\s/;

// ISO 8601 / RFC 3339 timestamp prefix, e.g. "2024-06-09T22:26:09.123Z " or "2024-06-09 22:26:09 "
// Matches: YYYY-MM-DD followed by T or space and a time component.
const RE_ISO_PREFIX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/;

// klog prefix ends at the first ']' character
function klogPrefixLen(raw: string): number {
  const idx = raw.indexOf("]");
  return idx >= 0 ? idx + 1 : 0;
}

// structured `level=` or `"level":"` patterns (checked against first 200 chars)
const RE_LEVEL_KEY = /(?:^|\s)"?level"?\s*[:=]\s*"?(\w+)"?/i;

// bare level tokens near the start of the line (first 80 chars)
const RE_LEVEL_TOKEN = /\b(error|fatal|panic|warn|warning|debug|trace|info)\b/i;

function tokenToLevel(tok: string): LogLevel {
  const t = tok.toLowerCase();
  if (t === "error" || t === "fatal" || t === "panic") return "error";
  if (t === "warn" || t === "warning") return "warn";
  if (t === "debug" || t === "trace") return "debug";
  if (t === "info") return "info";
  return "none";
}

export function parseLine(raw: string): ParsedLine {
  // 1. klog prefix check (cheapest, most common in this codebase)
  const klm = RE_KLOG_PREFIX.exec(raw);
  if (klm) {
    const ch = klm[1];
    const level: LogLevel =
      ch === "I" ? "info" :
      ch === "W" ? "warn" :
      (ch === "E" || ch === "F") ? "error" :
      "none";
    return { level, dimPrefixLen: klogPrefixLen(raw), text: raw };
  }

  // 2. structured level= / "level": key
  const head200 = raw.length > 200 ? raw.slice(0, 200) : raw;
  const lkm = RE_LEVEL_KEY.exec(head200);
  if (lkm) {
    const level = tokenToLevel(lkm[1]);
    // dim only if there's also an ISO prefix
    const isom = RE_ISO_PREFIX.exec(raw);
    return { level, dimPrefixLen: isom ? isom[0].length : 0, text: raw };
  }

  // 3. ISO/RFC3339 prefix — detect level from token after the prefix
  const isom = RE_ISO_PREFIX.exec(raw);
  if (isom) {
    const rest80 = raw.slice(isom[0].length, isom[0].length + 80);
    const tm = RE_LEVEL_TOKEN.exec(rest80);
    const level = tm ? tokenToLevel(tm[1]) : "none";
    return { level, dimPrefixLen: isom[0].length, text: raw };
  }

  // 4. bare token near start of line (first 80 chars)
  const head80 = raw.length > 80 ? raw.slice(0, 80) : raw;
  const tm = RE_LEVEL_TOKEN.exec(head80);
  if (tm) {
    return { level: tokenToLevel(tm[1]), dimPrefixLen: 0, text: raw };
  }

  return { level: "none", dimPrefixLen: 0, text: raw };
}

// ---------------------------------------------------------------------------
// Highlight helpers
// ---------------------------------------------------------------------------

/**
 * Split `text` into alternating plain/match segments for search highlighting.
 * Returns an array of { value: string; match: boolean }.
 */
export interface Segment {
  value: string;
  match: boolean;
}

export function splitHighlight(text: string, searchLc: string): Segment[] {
  if (!searchLc) return [{ value: text, match: false }];
  const segments: Segment[] = [];
  const textLc = text.toLowerCase();
  let pos = 0;
  while (pos < text.length) {
    const idx = textLc.indexOf(searchLc, pos);
    if (idx === -1) {
      segments.push({ value: text.slice(pos), match: false });
      break;
    }
    if (idx > pos) segments.push({ value: text.slice(pos, idx), match: false });
    segments.push({ value: text.slice(idx, idx + searchLc.length), match: true });
    pos = idx + searchLc.length;
  }
  return segments;
}
