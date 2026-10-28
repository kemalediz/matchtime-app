/**
 * The ask's door remembers a refusal the club can fix (2026-10-28): only
 * when the caller asks it to (an organiser's ask in words), with the ask's
 * own facts; the retry and a YES to a notice never do. The store's
 * `rememberRefusedAsk` keeps only the refusals `ASK_RETRY_REFUSALS` names.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ match: { findUnique: vi.fn() } }));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("../admin-group-log", () => ({ hqQuestionsSince: vi.fn() }));
const squad = vi.hoisted(() => ({ loadSquadState: vi.fn() }));
vi.mock("../pipeline/load-state", () => squad);
const round = vi.hoisted(() => ({ requestPoolAsk: vi.fn(), placesOpenOf: vi.fn() }));
vi.mock("../pool/round", () => round);
vi.mock("../pool/auto-ask", () => ({ openPartnerRoundOf: vi.fn().mockResolvedValue(null) }));
vi.mock("../pool/panel", () => ({ poolNoticeBand: vi.fn() }));
vi.mock("../pool/club-invitation", () => ({ invitationsAwaitingClub: vi.fn(), answerAsClub: vi.fn() }));
const retry = vi.hoisted(() => ({ rememberRefusedPoolAsk: vi.fn() }));
vi.mock("../pool-ask-retry", () => retry);

import { askPoolFromWords } from "../pool-ask-words";

const NOW = new Date("2026-10-28T15:37:00Z");
const ENV = { MT_POOL_OPEN: "1" };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findUnique.mockResolvedValue({ id: "m1", date: new Date("2026-10-30T19:00:00Z") });
  squad.loadSquadState.mockResolvedValue({ matchId: "m1" });
  round.placesOpenOf.mockResolvedValue(2);
  round.requestPoolAsk.mockResolvedValue({ ok: false, refusal: "no-venue" });
});

describe("askPoolFromWords remembers a refused ask only when asked to", () => {
  it("an organiser's ask in the players' group, refused no-venue: remembered with the ask's facts, the reply unchanged", async () => {
    const r = await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", where: "group", lang: "en", now: NOW, env: ENV, remember: { askMessageId: "wa-1" } });
    expect(retry.rememberRefusedPoolAsk).toHaveBeenCalledWith({
      orgId: "o1",
      matchId: "m1",
      askedByUserId: "u-owner",
      askedIn: "group",
      askMessageId: "wa-1",
      places: 2,
      refusal: "no-venue",
      now: NOW,
    });
    expect(r.outcome).toBe("hq-pool-not-asked");
  });

  it("in HQ (no `where`): remembered as asked in HQ", async () => {
    await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV, remember: { askMessageId: null } });
    expect(retry.rememberRefusedPoolAsk).toHaveBeenCalledWith(expect.objectContaining({ askedIn: "hq", askMessageId: null }));
  });

  it("without `remember` (the retry itself, a YES to a notice): never remembered", async () => {
    await askPoolFromWords({ orgId: "o1", matchId: "m1", userId: "u-owner", via: "words", where: "group", lang: "en", now: NOW, env: ENV });
    expect(retry.rememberRefusedPoolAsk).not.toHaveBeenCalled();
  });

  it("asked: nothing remembered", async () => {
    round.requestPoolAsk.mockResolvedValue({ ok: true, askId: "a1", waveSent: true });
    await askPoolFromWords({ orgId: "o1", userId: "u-owner", via: "words", lang: "en", now: NOW, env: ENV, remember: { askMessageId: "wa-1" } });
    expect(retry.rememberRefusedPoolAsk).not.toHaveBeenCalled();
  });
});
