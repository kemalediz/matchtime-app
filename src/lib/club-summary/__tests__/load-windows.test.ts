/**
 * The loader's windows are MIRRORS of the scheduler's and the months'
 * constants (load.ts does not import bot-scheduler.ts). This fails the
 * moment either side changes without the other. Read from the source text,
 * so the scheduler's module graph is not loaded into a unit test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CANCELLED_HOLD_LOOKBACK_MS, CLOSED_MONTH_GATE_DAYS, POST_MATCH_LOOKBACK_DAYS } from "../load";

const LIB = path.resolve(__dirname, "../..");
const src = (f: string) => readFileSync(path.join(LIB, f), "utf8");

describe("the loader's windows equal the scheduler's", () => {
  const scheduler = src("bot-scheduler.ts");

  it("POST_MATCH_LOOKBACK_DAYS = MOM_ANNOUNCE_MAX_AGE_DAYS + 1", () => {
    expect(scheduler).toMatch(/export const POST_MATCH_LOOKBACK_DAYS = MOM_ANNOUNCE_MAX_AGE_DAYS \+ 1;/);
    const mom = Number(/export const MOM_ANNOUNCE_MAX_AGE_DAYS = (\d+);/.exec(scheduler)?.[1]);
    expect(POST_MATCH_LOOKBACK_DAYS).toBe(mom + 1);
  });

  it("CANCELLED_HOLD_LOOKBACK_MS is 24 hours", () => {
    expect(scheduler).toMatch(/const CANCELLED_HOLD_LOOKBACK_MS = 24 \* 60 \* 60 \* 1000;/);
    expect(CANCELLED_HOLD_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("CLOSED_MONTH_GATE_DAYS matches monthly-week.ts", () => {
    const days = Number(/const CLOSED_MONTH_GATE_DAYS = (\d+);/.exec(src("monthly-week.ts"))?.[1]);
    expect(CLOSED_MONTH_GATE_DAYS).toBe(days);
  });

  it("the match window's where is getMatchesForScheduler's", () => {
    const fn = scheduler.slice(scheduler.indexOf("async function getMatchesForScheduler"));
    const where = fn.slice(0, fn.indexOf("include:"));
    expect(where).toContain('isHistorical: false');
    expect(where).toContain('{ status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } }');
    expect(where).toContain('{ status: "COMPLETED", date: { gte: windowStart } }');
    expect(where).toContain('{ status: "CANCELLED", date: { gte: new Date(now.getTime() - CANCELLED_HOLD_LOOKBACK_MS) } }');
  });
});
