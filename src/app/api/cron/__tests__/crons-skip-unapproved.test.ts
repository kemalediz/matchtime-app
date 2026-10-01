/**
 * CRONS SKIP CLUBS THAT ARE NOT APPROVED (self-join slice 1, plan 4.3 layer 6).
 *
 * A self-join club waiting for approval must cost nothing and post
 * nothing, and no cron may act for it on its own initiative. Every club
 * that predates self-join is "approved" by the column default, so none
 * of this changes anything for Sutton FC.
 *
 *   generate-matches  pinned by src/lib/__tests__/org-lifecycle.test.ts
 *                     (the rule) and e2e/api/self-join-silence.spec.ts
 *                     (the wiring).
 *   complete-matches  and the noon backstop both go through
 *   / generate-teams  `completeFinishedMatches`: asserted below on the
 *                     query it sends.
 *   bot-health, extract-squads, none-bucket-shadow select organisations
 *                     directly: each must filter on `servingClubWhere()`.
 *   rolling-squad     `seedDueRollingSquads`: asserted below on its query.
 *   close-ratings     is a no-op and selects nothing.
 *
 * CLUB FEE BILLING (slice B1, plan 4.3 point 6): the same queries now use
 * `servingClubWhere()`, approved AND not billing-paused. With
 * BILLING_ENABLED off that IS `APPROVED_CLUB_WHERE`, so the queries are
 * exactly today's; both are asserted.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findMany: vi.fn(), update: vi.fn() },
  organisation: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/email", () => ({ sendRatingEmails: vi.fn(() => Promise.resolve()) }));

import { completeFinishedMatches } from "@/lib/match-completion";
import { seedDueRollingSquads } from "@/lib/rolling-squad";
import { APPROVED_CLUB_WHERE, SERVING_CLUB_WHERE } from "@/lib/club-approval";

const BILLING = process.env.BILLING_ENABLED;
afterEach(() => {
  if (BILLING === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = BILLING;
});

describe("completeFinishedMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.match.findMany.mockResolvedValue([]);
  });

  it("only looks at matches of approved clubs (flag off: exactly today's query)", async () => {
    delete process.env.BILLING_ENABLED;
    await completeFinishedMatches(new Date("2026-09-29T22:00:00Z"));
    const where = dbMock.match.findMany.mock.calls[0][0].where;
    expect(where.activity).toEqual({ org: APPROVED_CLUB_WHERE });
    expect(where.activity).toEqual({ org: { approvalStatus: "approved" } });
    // The existing filters are untouched.
    expect(where.status).toEqual({ in: ["TEAMS_PUBLISHED", "TEAMS_GENERATED", "UPCOMING"] });
  });

  it("flag on: skips billing-paused clubs too", async () => {
    process.env.BILLING_ENABLED = "1";
    await completeFinishedMatches(new Date("2026-09-29T22:00:00Z"));
    expect(dbMock.match.findMany.mock.calls[0][0].where.activity).toEqual({ org: SERVING_CLUB_WHERE });
  });
});

describe("seedDueRollingSquads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.organisation.findMany.mockResolvedValue([]);
  });
  it("flag off: exactly today's query", async () => {
    delete process.env.BILLING_ENABLED;
    await seedDueRollingSquads(new Date("2026-09-29T22:00:00Z"));
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({
      approvalStatus: "approved",
      rollingSquadEnabled: true,
      dormantAt: null,
    });
  });
  it("flag on: skips billing-paused clubs", async () => {
    process.env.BILLING_ENABLED = "1";
    await seedDueRollingSquads(new Date("2026-09-29T22:00:00Z"));
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({
      approvalStatus: "approved",
      billingStatus: { not: "paused" },
      rollingSquadEnabled: true,
      dormantAt: null,
    });
  });
});

describe("crons that select organisations filter on serving clubs", () => {
  const CRON = path.resolve(__dirname, "..");
  for (const name of ["bot-health", "extract-squads", "none-bucket-shadow"]) {
    it(`${name} selects only served (approved, not billing-paused) clubs`, () => {
      const src = readFileSync(path.join(CRON, name, "route.ts"), "utf8");
      const orgQueries = src.match(/db\.organisation\.findMany\(\{[\s\S]*?where:\s*\{[^}]*\}/g) ?? [];
      expect(orgQueries.length).toBeGreaterThan(0);
      for (const q of orgQueries) expect(q).toContain("...servingClubWhere()");
    });
  }
});
