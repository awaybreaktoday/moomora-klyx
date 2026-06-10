import { describe, it, expect } from "vitest";
import { stripAnsi, parseLine, splitHighlight } from "./logline";

describe("stripAnsi", () => {
  it("removes colour sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;32mgreen\x1b[0m text")).toBe("green text");
  });

  it("removes erase-to-EOL sequences", () => {
    expect(stripAnsi("hello\x1b[K world")).toBe("hello world");
  });

  it("passes through plain strings unchanged", () => {
    expect(stripAnsi("no ansi here")).toBe("no ansi here");
  });
});

describe("parseLine — klog", () => {
  it("I → info with dim prefix at ]", () => {
    const raw = "I0609 22:26:09.484068  1 controller.go:75] starting loop";
    const p = parseLine(raw);
    expect(p.level).toBe("info");
    expect(p.dimPrefixLen).toBe(raw.indexOf("]") + 1);
  });

  it("W → warn", () => {
    const p = parseLine("W0609 22:26:09.000000  1 foo.go:1] watch expired");
    expect(p.level).toBe("warn");
  });

  it("E → error", () => {
    const p = parseLine("E0609 22:26:09.000000  1 bar.go:99] failed to connect");
    expect(p.level).toBe("error");
  });

  it("F → error (fatal)", () => {
    const p = parseLine("F0609 22:26:09.000000  1 main.go:1] fatal startup");
    expect(p.level).toBe("error");
  });
});

describe("parseLine — structured level= key", () => {
  it("level=error → error", () => {
    const p = parseLine('time="2024-06-09T22:26:09Z" level=error msg="boom"');
    expect(p.level).toBe("error");
  });

  it('"level":"warn" → warn', () => {
    const p = parseLine('{"level":"warn","msg":"degraded"}');
    expect(p.level).toBe("warn");
  });

  it('"level":"debug" → debug', () => {
    const p = parseLine('{"level":"debug","msg":"tick"}');
    expect(p.level).toBe("debug");
  });

  it('"level":"info" → info', () => {
    const p = parseLine('{"level":"info","msg":"ready"}');
    expect(p.level).toBe("info");
  });
});

describe("parseLine — ISO/RFC3339 timestamp prefix dim", () => {
  it("ISO prefix is dimmed, level from token after prefix", () => {
    const raw = "2024-06-09T22:26:09.123Z WARN something degraded";
    const p = parseLine(raw);
    expect(p.dimPrefixLen).toBeGreaterThan(0);
    // prefix includes the timestamp + trailing space
    expect(raw.slice(0, p.dimPrefixLen)).toMatch(/^2024-06-09/);
    expect(p.level).toBe("warn");
  });

  it("ISO prefix with no level token → level none but prefix dimmed", () => {
    const raw = "2024-06-09 22:26:09 some neutral message";
    const p = parseLine(raw);
    expect(p.dimPrefixLen).toBeGreaterThan(0);
    expect(p.level).toBe("none");
  });
});

describe("parseLine — bare token", () => {
  it("bare ERROR token near start → error, no dim", () => {
    const p = parseLine("ERROR: connection refused");
    expect(p.level).toBe("error");
    expect(p.dimPrefixLen).toBe(0);
  });

  it("bare debug → debug", () => {
    const p = parseLine("[debug] cache miss");
    expect(p.level).toBe("debug");
  });
});

describe("parseLine — plain line", () => {
  it("plain line → none, 0 prefix", () => {
    const p = parseLine("some completely neutral log line");
    expect(p.level).toBe("none");
    expect(p.dimPrefixLen).toBe(0);
  });

  it("empty string → none, 0", () => {
    const p = parseLine("");
    expect(p.level).toBe("none");
    expect(p.dimPrefixLen).toBe(0);
  });
});

describe("splitHighlight", () => {
  it("no search → single plain segment", () => {
    expect(splitHighlight("hello world", "")).toEqual([{ value: "hello world", match: false }]);
  });

  it("single match in middle", () => {
    const segs = splitHighlight("hello world", "world");
    expect(segs).toEqual([
      { value: "hello ", match: false },
      { value: "world", match: true },
    ]);
  });

  it("match at start", () => {
    const segs = splitHighlight("world hello", "world");
    expect(segs[0]).toEqual({ value: "world", match: true });
  });

  it("multiple matches", () => {
    const segs = splitHighlight("ab ab ab", "ab");
    const matches = segs.filter((s) => s.match);
    expect(matches.length).toBe(3);
  });

  it("case-insensitive: search lowercased, value preserves original casing", () => {
    const segs = splitHighlight("Hello World", "world");
    const match = segs.find((s) => s.match);
    expect(match?.value).toBe("World"); // original case
  });

  it("no match → single plain segment", () => {
    expect(splitHighlight("hello", "xyz")).toEqual([{ value: "hello", match: false }]);
  });
});
