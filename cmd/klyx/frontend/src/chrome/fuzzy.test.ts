import { describe, it, expect } from "vitest";
import { fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence", () => {
    const r = fuzzyMatch("kp", "kube-prom");
    expect(r).not.toBeNull();
    expect(r!.positions).toEqual([0, 5]);
  });

  it("returns null when not a subsequence", () => {
    expect(fuzzyMatch("zz", "kube-prom")).toBeNull();
    expect(fuzzyMatch("pk", "kp")).toBeNull(); // order matters
  });

  it("empty query matches everything with neutral score", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("is case-insensitive", () => {
    const r = fuzzyMatch("KP", "Kube-Prom");
    expect(r).not.toBeNull();
    expect(r!.positions).toEqual([0, 5]);
  });

  it("ranks start-of-word/start-of-target match above a scattered one", () => {
    // "kp": kube-prom hits k@0 (target+word) and p@5 (word). backpack hits
    // k@3, p@4 (consecutive only). The word-aligned match must win.
    const a = fuzzyMatch("kp", "kube-prom")!;
    const b = fuzzyMatch("kp", "backpack")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("ranks an exact prefix above a scattered match", () => {
    const prefix = fuzzyMatch("git", "gitops")!;
    const scattered = fuzzyMatch("git", "great-it-thing")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it("matches gitops with query go", () => {
    const r = fuzzyMatch("go", "gitops");
    expect(r).not.toBeNull();
    expect(r!.positions).toEqual([0, 3]); // g@0, o@3
  });

  it("rewards consecutive runs", () => {
    const consec = fuzzyMatch("ub", "kube")!; // u@1,b@3? no: u@1, b@... "kube" = k,u,b,e -> u@1,b@2 consecutive
    expect(consec.positions).toEqual([1, 2]);
  });

  it("tiebreaks toward the shorter target on otherwise equal matches", () => {
    const short = fuzzyMatch("ab", "ab")!;
    const long = fuzzyMatch("ab", "ab-xxxxxxxxxx")!;
    expect(short.score).toBeGreaterThan(long.score);
  });

  it("reports correct positions for highlight across separators", () => {
    const r = fuzzyMatch("knp", "kube-node-pinger")!;
    // k@0, n@5 (after '-'), p@10 (after '-')
    expect(r.positions).toEqual([0, 5, 10]);
  });
});
