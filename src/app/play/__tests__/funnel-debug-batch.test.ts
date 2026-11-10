/**
 * The /play funnel diagnostic's server half (TEMPORARY, 2026-11-10): what
 * a debug batch may carry, the log line it becomes and the per-IP cap.
 * Small JSON only, known fields only, short strings only: whatever a page
 * sends, the log never holds what a person typed.
 */
import { describe, expect, it } from "vitest";
import { FUNNEL_DEBUG_LOG_MAX, createRateLimiter, funnelDebugLogLine, readFunnelDebugBatch } from "../funnel-debug-batch";

const GOOD = { v: 1, sid: "abc123def456", seq: 2, why: "tick", prev: "fetch:204", ev: [{ t: 12, k: "input", tr: true, it: "insertText", len: 1, ch: true, nm: "name" }] };

describe("readFunnelDebugBatch", () => {
  it("keeps a well-formed batch", () => {
    expect(readFunnelDebugBatch(GOOD)).toEqual(GOOD);
  });

  it("refuses anything that is not a batch", () => {
    for (const bad of [
      null,
      "x",
      3,
      [],
      {},
      { ...GOOD, v: 2 },
      { ...GOOD, sid: "has space" },
      { ...GOOD, sid: "" },
      { ...GOOD, seq: -1 },
      { ...GOOD, seq: 1.5 },
      { ...GOOD, ev: "no" },
      { ...GOOD, ev: new Array(201).fill({ t: 1, k: "x" }) },
    ]) {
      expect(readFunnelDebugBatch(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });

  it("drops unknown fields, long or odd strings, and a one-character key (that would be what he typed)", () => {
    const got = readFunnelDebugBatch({
      ...GOOD,
      extra: "x",
      ev: [{ t: 1, k: "keydown", key: "a", value: "Kemal", nm: "x".repeat(60), it: "insert Text<script>", kc: 65 }, { k: 5 }, "nope", { t: 2, k: "keydown", key: "Backspace" }],
    });
    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty("extra");
    expect(got!.ev).toEqual([
      { t: 1, k: "keydown", kc: 65 },
      { t: 2, k: "keydown", key: "Backspace" },
    ]);
  });

  it("keeps a short error message on an error record only", () => {
    const got = readFunnelDebugBatch({
      ...GOOD,
      ev: [
        { t: 1, k: "error", msg: "Hydration failed" },
        { t: 2, k: "input", msg: "Kemal" },
      ],
    });
    expect(got!.ev).toEqual([
      { t: 1, k: "error", msg: "Hydration failed" },
      { t: 2, k: "input" },
    ]);
  });
});

describe("funnelDebugLogLine", () => {
  it("one line: the prefix, then JSON with the user agent and the batch", () => {
    const line = funnelDebugLogLine(readFunnelDebugBatch(GOOD)!, "Mozilla/5.0 [FB_IAB/FB4A;FBAV/586.0]");
    expect(line.startsWith("[pool-funnel-debug] ")).toBe(true);
    const parsed = JSON.parse(line.slice("[pool-funnel-debug] ".length));
    expect(parsed).toMatchObject({ ua: "Mozilla/5.0 [FB_IAB/FB4A;FBAV/586.0]", sid: "abc123def456", seq: 2, ev: GOOD.ev });
    expect(line).not.toContain("\n");
  });

  it("is cut to a few KB", () => {
    const many = { ...GOOD, ev: Array.from({ length: 200 }, (_, i) => ({ t: i, k: "compositionupdate", tr: true, it: "insertCompositionText", len: i, nm: "name" })) };
    const line = funnelDebugLogLine(readFunnelDebugBatch(many)!, "UA");
    expect(line.length).toBeLessThanOrEqual(FUNNEL_DEBUG_LOG_MAX);
    expect(line.endsWith("…(truncated)")).toBe(true);
  });
});

describe("createRateLimiter", () => {
  it("allows the limit per key per window, then refuses until the window passes", () => {
    const allow = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect([allow("a", 0), allow("a", 1), allow("a", 2), allow("a", 3)]).toEqual([true, true, true, false]);
    expect(allow("b", 3)).toBe(true);
    expect(allow("a", 1001)).toBe(true);
  });
});
