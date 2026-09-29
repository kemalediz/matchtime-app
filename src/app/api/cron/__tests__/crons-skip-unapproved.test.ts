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
 *                     directly: each must filter on APPROVED_CLUB_WHERE.
 *   close-ratings     is a no-op and selects nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findMany: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/email", () => ({ sendRatingEmails: vi.fn(() => Promise.resolve()) }));

import { completeFinishedMatches } from "@/lib/match-completion";
import { APPROVED_CLUB_WHERE } from "@/lib/club-approval";

describe("completeFinishedMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.match.findMany.mockResolvedValue([]);
  });

  it("only looks at matches of approved clubs", async () => {
    await completeFinishedMatches(new Date("2026-09-29T22:00:00Z"));
    const where = dbMock.match.findMany.mock.calls[0][0].where;
    expect(where.activity).toEqual({ org: APPROVED_CLUB_WHERE });
    // The existing filters are untouched.
    expect(where.status).toEqual({ in: ["TEAMS_PUBLISHED", "TEAMS_GENERATED", "UPCOMING"] });
  });
});

describe("crons that select organisations filter on approval", () => {
  const CRON = path.resolve(__dirname, "..");
  for (const name of ["bot-health", "extract-squads", "none-bucket-shadow"]) {
    it(`${name} selects only approved clubs`, () => {
      const src = readFileSync(path.join(CRON, name, "route.ts"), "utf8");
      const orgQueries = src.match(/db\.organisation\.findMany\(\{[\s\S]*?where:\s*\{[^}]*\}/g) ?? [];
      expect(orgQueries.length).toBeGreaterThan(0);
      for (const q of orgQueries) expect(q).toContain("...APPROVED_CLUB_WHERE");
    });
  }
});
