/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE INCIDENT (2026-09-14, Sutton FC, live, reported by the owner)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Kemal posted, untagged, to his club group:
 *
 *   "it would be great to have some benchers in case someone drops
 *    tomorrow? Anybody else interested"
 *
 * MatchTime replied, in the group:
 *
 *   "The squad for *Tuesday 7-a-side* is already full — no open spots to
 *    recruit for."
 *
 * That is backwards. Benchers are wanted PRECISELY BECAUSE the squad is
 * full. The reply talked the volunteers he was asking for out of
 * volunteering, and the match went to kick-off at 14 of 14 with an empty
 * bench.
 *
 * The production audit row:
 *
 *   by=attendance-engine  intent=replacement_request  action=none+recruit:0
 *   why: attendance-engine (offer): side-request:recruit; no claims
 *        extracted | admin recruit — invited 0 recent players
 *
 * So nothing misfired: the router, the extractor and the engine all read
 * the message correctly as a recruit side-request. `inviteRecentPlayers`'
 * CAPACITY GUARD is what produced the sentence, and the defect is that
 * the guard is BENCH-BLIND — it treats "squad full" as "nothing to do",
 * when with `featureBench` on there is something very useful to do.
 *
 * ── WHAT THIS FILE PINS ──────────────────────────────────────────────
 *
 *   1. bench ON  + full squad → the bench invitation, and NEVER the
 *      incident sentence.
 *   2. bench OFF + full squad → the incident sentence, unchanged. For
 *      an org with no bench it is the truth (`bot-scheduler.ts:772`
 *      refuses to post a bench prompt without the feature), so the
 *      branch is explicit rather than incidental.
 *   3. squad NOT full → the blast runs exactly as it does today. This
 *      is the regression that matters most, and it is asserted on the
 *      same fake as the other two.
 *
 * DMs ARE COUNTED IN ALL THREE. `db.botJob.create` is the only way a
 * message leaves this product, and it is a `vi.fn()` here, so "MatchTime
 * DM'd nobody" is a measurement rather than a claim. The full-squad
 * branches must queue ZERO — see `recruit-lookback.ts` for why a mass DM
 * is the most dangerous thing this codebase can do.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const membershipFindMany = vi.fn();
const matchFindFirst = vi.fn();
const matchFindMany = vi.fn();
const sentFindUnique = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();
const getOrgFeatures = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findFirst: (...a: unknown[]) => matchFindFirst(...a),
      findMany: (...a: unknown[]) => matchFindMany(...a),
    },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    sentNotification: {
      findUnique: (...a: unknown[]) => sentFindUnique(...a),
      create: (...a: unknown[]) => sentCreate(...a),
    },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: () => "tok",
  MAGIC_LINK_TTL: { actionNudge: 1 },
}));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async () => "https://s/x" }));
vi.mock("@/lib/london-time", () => ({ formatLondon: () => "Tue 15 Sept, 21:30" }));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: (...a: unknown[]) => getOrgFeatures(...a),
}));

import { inviteRecentPlayers } from "@/lib/recruit";

const ORG = "org-sutton";

/** The incident sentence, verbatim from the production reply. */
const INCIDENT_SENTENCE = "is already full — no open spots to recruit for.";

/** 14 confirmed players, exactly as Sutton FC stood on 2026-09-14. */
const FULL_SQUAD = Array.from({ length: 14 }, (_, i) => ({
  userId: `in-${i}`,
  status: "CONFIRMED" as const,
}));

function upcoming(attendances: Array<{ userId: string; status: string }>) {
  return {
    id: "match-next",
    date: new Date("2026-09-15T20:30:00Z"),
    maxPlayers: 14,
    activity: { name: "Tuesday 7-a-side" },
    attendances,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Everything on, the Sutton shape. Each test overrides `bench`.
  getOrgFeatures.mockResolvedValue({ attendance: true, bench: true });
  matchFindFirst.mockResolvedValue(upcoming(FULL_SQUAD));
  // Two recent players who have NOT responded to the upcoming match —
  // a real pool, so a blast is possible and "zero DMs" means the guard
  // stopped it rather than there being nobody to ask.
  matchFindMany.mockResolvedValue([
    {
      attendances: [
        { userId: "p-1", user: { id: "p-1", name: "Recent One", phoneNumber: "+447700900001" } },
        { userId: "p-2", user: { id: "p-2", name: "Recent Two", phoneNumber: "+447700900002" } },
      ],
    },
  ]);
  membershipFindMany.mockResolvedValue([]);
  sentFindUnique.mockResolvedValue(null);
  sentCreate.mockResolvedValue({});
  botJobCreate.mockResolvedValue({ id: "job-1" });
});

describe("inviteRecentPlayers — a full squad with the BENCH feature ON", () => {
  it("invites the group onto the bench instead of refusing (the 2026-09-14 incident)", async () => {
    getOrgFeatures.mockResolvedValue({ attendance: true, bench: true });

    const res = await inviteRecentPlayers(ORG);

    expect(res.ok).toBe(true);
    const reply = res.reason ?? "";
    // THE SENTENCE THAT CAUSED THE INCIDENT MUST NEVER APPEAR AGAIN.
    expect(reply).not.toContain(INCIDENT_SENTENCE);
    expect(reply).not.toContain("no open spots");
    // …and what replaced it must describe what the system ACTUALLY does:
    // say IN into a full squad and `attendance.ts` writes a BENCH row,
    // then a drop opens a BenchSlotOffer that the first to reply IN takes.
    expect(reply).toContain("Tuesday 7-a-side");
    expect(reply.toLowerCase()).toContain("bench");
    expect(reply).toContain("*IN*");
    expect(reply.toLowerCase()).toContain("first");
    // The honest count, the way the group saw it: 14 of 14.
    expect(reply).toContain("14 of 14");
  });

  it("DMs NOBODY — a group reply reaches the same people at no risk", async () => {
    getOrgFeatures.mockResolvedValue({ attendance: true, bench: true });

    const res = await inviteRecentPlayers(ORG);

    expect(botJobCreate).not.toHaveBeenCalled();
    expect(res.invited).toBe(0);
    expect(res.invitedNames).toEqual([]);
  });
});

describe("inviteRecentPlayers — a full squad with the BENCH feature OFF", () => {
  it("keeps the old sentence, because for that org it is TRUE", async () => {
    getOrgFeatures.mockResolvedValue({ attendance: true, bench: false });

    const res = await inviteRecentPlayers(ORG);

    expect(res.ok).toBe(true);
    expect(res.reason).toBe(
      "The squad for *Tuesday 7-a-side* is already full — no open spots to recruit for.",
    );
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});

describe("inviteRecentPlayers — a squad that is NOT full (the working path)", () => {
  it("still blasts the recent non-responders, bench feature or no bench feature", async () => {
    for (const bench of [true, false]) {
      vi.clearAllMocks();
      botJobCreate.mockResolvedValue({ id: "job-1" });
      sentFindUnique.mockResolvedValue(null);
      sentCreate.mockResolvedValue({});
      membershipFindMany.mockResolvedValue([]);
      getOrgFeatures.mockResolvedValue({ attendance: true, bench });
      // 12 of 14 — two spots open.
      matchFindFirst.mockResolvedValue(upcoming(FULL_SQUAD.slice(0, 12)));

      const res = await inviteRecentPlayers(ORG);

      expect(res.invited, `bench=${bench}`).toBe(2);
      expect(res.need, `bench=${bench}`).toBe(2);
      expect(res.reason, `bench=${bench}`).toBeUndefined();
      // The blast itself, on the injected fake: two DMs, to the two
      // recent non-responders, byte-identical to today's copy.
      expect(botJobCreate, `bench=${bench}`).toHaveBeenCalledTimes(2);
      const jobs = botJobCreate.mock.calls.map(
        (c) => (c[0] as { data: { phone: string; text: string } }).data,
      );
      expect(jobs.map((j) => j.phone).sort()).toEqual(["447700900001", "447700900002"]);
      for (const j of jobs) {
        expect(j.text).toContain("putting the squad together");
        expect(j.text).toContain("2 spots left");
        expect(j.text).toContain("reply *IN*");
      }
    }
  });
});
