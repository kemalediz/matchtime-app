import { describe, expect, it } from "vitest";
import { parsePlayStyle, playStyleShown } from "../play-style";
import { poolSwitchEnv } from "../flags";

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
    expect(playStyleShown({ featurePlayerPool: true }, poolSwitchEnv(true))).toBe(true);
    // The platform switch off (or never resolved) hides it, whatever the club says.
    expect(playStyleShown({ featurePlayerPool: true }, poolSwitchEnv(false))).toBe(false);
    expect(playStyleShown({ featurePlayerPool: true }, {})).toBe(false);
    expect(playStyleShown({ featurePlayerPool: false }, poolSwitchEnv(true))).toBe(false);
    expect(playStyleShown(null, poolSwitchEnv(true))).toBe(false);
  });
});
