/**
 * A GUEST'S DM ANSWER SEES HIS GAME ONLY (review of #621, item 5): the
 * time, the venue and address, the format, the fee, who is playing and
 * the bench. Never the club's member list, stats tables, results, ratings
 * or anybody's payments.
 */
import { describe, expect, it } from "vitest";
import { buildUnifiedContext, type UnifiedAnswerInput } from "../../pipeline/unified-answer";
import { NOW, fullName, world } from "../../pipeline/__tests__/helpers";
import { formatGuestGameBlock, guestView } from "../context";

const BLOCK = formatGuestGameBlock(
  {
    club: "Riverside FC",
    kickoff: new Date("2026-09-01T20:00:00Z"),
    format: "Football 7-a-side",
    venue: "Goals North Cheam",
    address: "Cheam Common Rd, Worcester Park KT4 8RH",
    mapUrl: "https://www.google.com/maps/search/?api=1&query=51.37%2C-0.23",
    fee: { kind: "amount", amount: "£6" },
    monthly: false,
  },
  "CONFIRMED",
);

function input(): UnifiedAnswerInput {
  const st = world({ confirmed: ["kemal", "sait"], bench: ["erdal"], dropped: ["zair"] });
  return {
    audience: "dm",
    state: {
      ...st,
      club: { collectorName: "Elvin Aliyev", feePerPlayer: 6, feeSplitTotal: false, teamsReady: "18:00" },
      completedMatch: { id: "m0", kickoffLabel: "Tue 25 Aug", redScore: 5, yellowScore: 3, status: "COMPLETED", isHistorical: false } as never,
    },
    squadKnown: true,
    stats: {
      fullTableUrl: "https://matchtime.ai/profile/stats",
      ratings: [{ userId: "u-erdal", name: fullName("erdal"), avg: 7.4, games: 9, rank: 1, delta: 1 }],
      mom: [],
      elo: [],
      teamOfSeason: null,
      mrReliable: [],
      aliases: [],
      chemistry: {},
      appearances: [],
      recordsStart: { matches: null, mom: null },
      completedMatches: 14,
      generic: {},
      periods: {},
    },
    person: { userId: "u-abu", self: true },
    results: { since: null, more: false, rows: [{ dayLabel: "Tue 25 Aug", redLabel: "Red", yellowLabel: "Yellow", red: 5, yellow: 3 }] },
    payments: { kind: "counted", chargeable: 13, unpaid: 4, kickoffLabel: "Tue 21:30" },
    ratingProgress: null,
    own: ["THE ASKER'S OWN PAYMENTS: £12 owed"],
    history: [],
    lastBotPost: null,
    reply: null,
    now: NOW,
    question: "who else is playing?",
    askerUserId: "u-abu",
    askerName: "Abu Ayoub",
  };
}

describe("guestView", () => {
  it("keeps his game, the squad and the bench", () => {
    const { text } = buildUnifiedContext(guestView(input(), BLOCK));
    expect(text).toContain("THE ASKER IS A GUEST of the club");
    expect(text).toContain("Cheam Common Rd");
    expect(text).toContain(fullName("kemal"));
    expect(text).toContain(fullName("erdal"));
  });
  it("drops the member list, stats, results, payments and anyone out", () => {
    const { text } = buildUnifiedContext(guestView(input(), BLOCK));
    // The money collector stays named: a guest pays him.
    for (const k of ["habib", "najib", "zair"]) expect(text, k).not.toContain(fullName(k));
    expect(text).toMatch(/MEMBERS, the players registered with the club \(3\)/);
    expect(text).not.toContain("club rating");
    expect(text).not.toContain("LAST MATCH PLAYED");
    expect(text).not.toContain("Tue 25 Aug");
    expect(text).not.toContain("£12 owed");
    expect(text).not.toMatch(/4 of the 13/);
  });
});
