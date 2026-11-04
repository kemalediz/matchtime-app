/**
 * The loader's windows ARE the scheduler's (slice A1): one definition, in
 * scheduler-windows.ts, read by the scheduler, the months and the loader.
 * In A0 the loader mirrored them; this fails if a copy comes back. Read
 * from the source text, so the scheduler's module graph is not loaded.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANCELLED_HOLD_LOOKBACK_MS,
  CLOSED_MONTH_GATE_DAYS,
  MOM_ANNOUNCE_MAX_AGE_DAYS,
  POST_MATCH_LOOKBACK_DAYS,
  closedLatelyWhere,
  schedulerMatchWhere,
} from "../../scheduler-windows";

const LIB = path.resolve(__dirname, "../..");
const src = (f: string) => readFileSync(path.join(LIB, f), "utf8");

describe("the scheduler's windows, one definition", () => {
  it("the values are today's", () => {
    expect(MOM_ANNOUNCE_MAX_AGE_DAYS).toBe(9);
    expect(POST_MATCH_LOOKBACK_DAYS).toBe(MOM_ANNOUNCE_MAX_AGE_DAYS + 1);
    expect(CANCELLED_HOLD_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
    expect(CLOSED_MONTH_GATE_DAYS).toBe(14);
  });

  it("no module keeps a copy of them", () => {
    for (const f of ["bot-scheduler.ts", "monthly-week.ts", "club-summary/load.ts"]) {
      const text = src(f);
      expect(text, f).not.toMatch(/const (MOM_ANNOUNCE_MAX_AGE_DAYS|POST_MATCH_LOOKBACK_DAYS|CANCELLED_HOLD_LOOKBACK_MS|CLOSED_MONTH_GATE_DAYS) =/);
    }
  });

  it("the scheduler and the loader read the same match window and the same closed months", () => {
    const scheduler = src("bot-scheduler.ts");
    const fn = scheduler.slice(scheduler.indexOf("async function getMatchesForScheduler"));
    expect(fn.slice(0, fn.indexOf("include:"))).toContain("where: schedulerMatchWhere(orgId, now)");
    const load = src("club-summary/load.ts");
    expect(load).toContain("where: schedulerMatchWhere(orgId, now)");
    expect(load).toContain("closedLatelyWhere(now)");
    expect(src("monthly-week.ts")).toContain("const closedLately = closedLatelyWhere;");
  });

  it("the match window: every live match, completed ones of the lookback, cancelled ones of the last day, never historical", () => {
    const now = new Date("2026-11-04T12:00:00.000Z");
    expect(schedulerMatchWhere("org-x", now)).toEqual({
      activity: { orgId: "org-x" },
      isHistorical: false,
      OR: [
        { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
        { status: "COMPLETED", date: { gte: new Date("2026-10-25T12:00:00.000Z") } },
        { status: "CANCELLED", date: { gte: new Date("2026-11-03T12:00:00.000Z") } },
      ],
    });
    expect(closedLatelyWhere(now)).toEqual({ status: "closed", closedAt: { gte: new Date("2026-10-21T12:00:00.000Z") } });
  });
});
