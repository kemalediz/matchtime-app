import { describe, expect, it } from "vitest";
import { parsePlayStyle, playStyleShown } from "../play-style";

describe("the club's style of play (slice L5b)", () => {
  it("accepts the three styles, and empty as 'not set'", () => {
    expect(parsePlayStyle("casual")).toEqual({ ok: true, value: "casual" });
    expect(parsePlayStyle("competitive")).toEqual({ ok: true, value: "competitive" });
    expect(parsePlayStyle("mixed")).toEqual({ ok: true, value: "mixed" });
    expect(parsePlayStyle("")).toEqual({ ok: true, value: null });
    expect(parsePlayStyle(null)).toEqual({ ok: true, value: null });
  });
  it("refuses anything else", () => {
    expect(parsePlayStyle("serious")).toEqual({ ok: false });
    expect(parsePlayStyle(3)).toEqual({ ok: false });
  });
  it("the setting shows only while the club may ask the pool", () => {
    expect(playStyleShown({ featurePlayerPool: true })).toBe(true);
    expect(playStyleShown({ featurePlayerPool: false })).toBe(false);
    expect(playStyleShown(null)).toBe(false);
  });
});
