/**
 * THE DM Q&A CONTEXT, AS TEXT (2026-09-17).
 *
 * `formatScopedContext` is the pure half of `buildScopedContext`: the
 * database rows already read, the block the model sees returned.
 *
 * WHY IT EXISTS. In a live Turkish dry run one answer in thirty called a
 * Friday match "Cumartesi". The context carried the history dates in
 * English ("04 Sept 2026") with no weekday, and the model was left to
 * translate them and to work weekdays out. The fix hands the model every
 * date already written in the org's language, with its weekday, so it
 * copies rather than translates.
 *
 * ENGLISH IS BYTE FOR BYTE WHAT IT WAS. The first test is the old
 * builder's output for the same rows, written out literally.
 */
import { describe, it, expect } from "vitest";
import { formatScopedContext, type ScopedContextInput } from "../dm-qa";

/** Fri 18 Sep 2026, 21:00 London. */
const FRI = new Date("2026-09-18T20:00:00.000Z");

const INPUT: ScopedContextInput = {
  orgName: "Cuma Futbol",
  match: {
    activityName: "Cuma Maçı",
    date: FRI,
    venue: "Sim Arena",
    maxPlayers: 14,
    confirmed: ["Erdal Özkan", "Mehmet Yılmaz"],
    bench: ["Volkan Erdem"],
    myStatus: "CONFIRMED",
  },
  stats: {
    gamesPlayed: 6,
    totalOrgMatches: 8,
    attendanceRate: 75,
    avgRating: 7.2,
    fieldAvgSeason: 6.8,
    momCount: 2,
    record: { w: 4, d: 1, l: 1 },
    form: { last5Avg: 7.4, trend: "up" },
    bestPartner: "Ali Çelik",
    nemesis: null,
  },
  history: {
    totalCompletedMatches: 2,
    recentMatches: [
      {
        id: "m1",
        date: new Date("2026-09-04T20:00:00.000Z"),
        redLabel: "Kırmızı",
        yellowLabel: "Sarı",
        redScore: 5,
        yellowScore: 3,
        scoreLabel: "Kırmızı 5 - 3 Sarı",
        momLabel: "Erdal Özkan",
      },
      {
        id: "m2",
        date: new Date("2026-09-11T20:00:00.000Z"),
        redLabel: "Kırmızı",
        yellowLabel: "Sarı",
        redScore: 2,
        yellowScore: 2,
        scoreLabel: "Kırmızı 2 - 2 Sarı",
        momLabel: "Mehmet Yılmaz",
      },
    ],
    momLeaderboard: [],
    attendanceLeaderboard: [],
    eloTop: [],
    eloBottom: [],
  },
};

const HISTORY_EN = [
  "## Recent History",
  "Completed matches: 2 total. Use this block as the source of truth for ANY historical question — MoM winners, scores, attendance, current form. Never invent numbers; if the answer isn't here, say \"I don't have that one yet\" rather than guessing.",
  "",
  "Completed matches (oldest first):",
  "  - 04 Sept 2026: Kırmızı 5 - 3 Sarı | MoM: Erdal Özkan",
  "  - 11 Sept 2026: Kırmızı 2 - 2 Sarı | MoM: Mehmet Yılmaz",
].join("\n");

describe("formatScopedContext, English", () => {
  it("is byte for byte the block the builder produced before the split", () => {
    expect(formatScopedContext(INPUT, "en")).toBe(
      [
        "GROUP: Cuma Futbol",
        "",
        "UPCOMING MATCH:",
        "- Cuma Maçı on Fri 18 Sep at 21:00 (UK time)",
        "- Venue: Sim Arena",
        "- Squad: 2/14 confirmed, 1 on the bench",
        "- You are currently: CONFIRMED",
        "- Confirmed players: Erdal Özkan, Mehmet Yılmaz",
        "- Bench: Volkan Erdem",
        "",
        "YOUR STATS:",
        "- Games played: 6/8 (75% attendance)",
        "- Average rating: 7.2 (squad avg 6.8)",
        "- Man of the Match: 2",
        "- Record: 4W 1D 1L",
        "- Form (last 5): 7.4 (up)",
        "- Best partnership: Ali Çelik",
        "",
        HISTORY_EN,
      ].join("\n"),
    );
  });

  it("keeps the old shapes for an empty match, no stats and no history", () => {
    expect(formatScopedContext({ orgName: "Sutton FC", match: null, stats: null, history: null }, "en")).toBe(
      ["GROUP: Sutton FC", "", "UPCOMING MATCH: none scheduled right now."].join("\n"),
    );
    const noSquad = formatScopedContext(
      { ...INPUT, match: { ...INPUT.match!, confirmed: [], bench: [], myStatus: null, venue: null }, stats: null, history: null },
      "en",
    );
    expect(noSquad).toContain("- Confirmed players: (none yet)");
    expect(noSquad).toContain("- You are currently: not signed up");
    expect(noSquad).not.toContain("- Bench:");
    expect(noSquad).not.toContain("- Venue:");
  });
});

describe("formatScopedContext, Turkish: every date is already written, with its weekday", () => {
  const tr = formatScopedContext(INPUT, "tr");

  it("gives the match's day, date and kickoff as separate, ready-made pieces", () => {
    expect(tr).toContain("- Day: Cuma");
    expect(tr).toContain("- Date: 18 Eylül");
    expect(tr).toContain("- Kickoff: 21:00 (UK time)");
    expect(tr).toContain('"18 Eylül Cuma 21:00"');
  });

  it("writes the history dates in Turkish, each with its (correct) weekday", () => {
    expect(tr).toContain("  - 4 Eylül 2026 Cuma: Kırmızı 5 - 3 Sarı | MoM: Erdal Özkan");
    expect(tr).toContain("  - 11 Eylül 2026 Cuma: Kırmızı 2 - 2 Sarı | MoM: Mehmet Yılmaz");
  });

  it("contains no English month or weekday for the model to translate", () => {
    expect(tr).not.toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/);
    expect(tr).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(day)?\b/);
  });

  it("names no weekday but the right one (every date here is a Friday)", () => {
    const days = tr.match(/Pazartesi|Salı|Çarşamba|Perşembe|Cumartesi|Pazar(?!tesi)/g);
    expect(days).toBeNull();
  });

  it("keeps everything else the English block says", () => {
    for (const line of [
      "GROUP: Cuma Futbol",
      "- Venue: Sim Arena",
      "- Squad: 2/14 confirmed, 1 on the bench",
      "- You are currently: CONFIRMED",
      "- Confirmed players: Erdal Özkan, Mehmet Yılmaz",
      "- Bench: Volkan Erdem",
      "- Average rating: 7.2 (squad avg 6.8)",
    ]) {
      expect(tr).toContain(line);
    }
  });
});
