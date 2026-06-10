// Pure, dependency-free fuzzy subsequence matcher for the command palette.
//
// fuzzyMatch returns null when `query` is not a (case-insensitive) subsequence
// of `target`; otherwise a score plus the matched character positions (for
// highlight). Higher score = better match. The scoring is deliberately simple
// and tuned by tests:
//   - consecutive run bonus: +3 per matched char that immediately follows the
//     previous match (rewards contiguous substrings like a prefix)
//   - start-of-target bonus: +5 when the first matched char is target[0]
//   - start-of-word bonus:   +2 per matched char that begins a "word" (the char
//     before it is a separator: '-', '/', '.', or space)
//   - shorter-target tiebreak: + up to 2, scaled 1/length, so a tight match on a
//     short target edges out the same match on a long one

export type FuzzyResult = { score: number; positions: number[] } | null;

const SEPARATORS = new Set(["-", "/", ".", " "]);

function isWordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  return SEPARATORS.has(target[i - 1]);
}

export function fuzzyMatch(query: string, target: string): FuzzyResult {
  // Empty query matches everything with a neutral score.
  if (query.length === 0) return { score: 0, positions: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prevMatch = -2; // ensures the first match is never "consecutive"

  for (let qi = 0; qi < q.length; qi++) {
    const qc = q[qi];
    // Advance through the target until we find the next occurrence of qc.
    while (ti < t.length && t[ti] !== qc) ti++;
    if (ti >= t.length) return null; // ran out of target -> not a subsequence

    positions.push(ti);

    if (ti === prevMatch + 1) score += 3; // consecutive run bonus
    if (ti === 0) score += 5; // start-of-target bonus
    if (isWordStart(target, ti)) score += 2; // start-of-word bonus

    prevMatch = ti;
    ti++;
  }

  // Shorter-target tiebreak: up to +2, scaled by 1/length.
  score += 2 / target.length;

  return { score, positions };
}
