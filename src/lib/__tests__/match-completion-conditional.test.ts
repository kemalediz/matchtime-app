/**
 * Review of #437, 5: the completion cron flips a finished match to
 * COMPLETED only from the status it read, so a game marked as not played
 * (CANCELLED) between the read and the write is never completed again, and
 * nothing after the game (rating emails, Elo) follows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ match: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const email = vi.hoisted(() => ({ sendRatingEmails: vi.fn() }));
vi.mock("@/lib/email", () => email);
const elo = vi.hoisted(() => ({ reconcileMatchElo: vi.fn() }));
vi.mock("@/lib/match-elo", () => elo);

import { completeFinishedMatches } from "../match-completion";

const NOW = new Date("2026-10-27T23:00:00Z");
const row = { id: "tue", date: new Date("2026-10-27T21:15:00Z"), status: "TEAMS_PUBLISHED", redScore: 5, yellowScore: 3, activity: { name: "Tuesday 5-a-side", matchDurationMins: 60 }, attendances: [] };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findMany.mockResolvedValue([row]);
  email.sendRatingEmails.mockResolvedValue(undefined);
});

describe("completeFinishedMatches", () => {
  it("writes COMPLETED only where the status is still the one read", async () => {
    dbMock.match.updateMany.mockResolvedValue({ count: 1 });
    expect(await completeFinishedMatches(NOW)).toEqual({ completed: 1 });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({ where: { id: "tue", status: "TEAMS_PUBLISHED" }, data: { status: "COMPLETED" } });
    expect(dbMock.match.update).not.toHaveBeenCalled();
  });

  it("cancelled in between: not completed, no Elo, no rating emails", async () => {
    dbMock.match.updateMany.mockResolvedValue({ count: 0 });
    expect(await completeFinishedMatches(NOW)).toEqual({ completed: 0 });
    expect(elo.reconcileMatchElo).not.toHaveBeenCalled();
    expect(email.sendRatingEmails).not.toHaveBeenCalled();
  });
});
