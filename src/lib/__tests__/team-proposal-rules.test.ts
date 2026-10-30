/**
 * Teams proposed and approved in a club's admin group (2026-10-14): the
 * pure half. The teams extractor's facts as a command, the name
 * resolver against the teams, the timing of the proposal and the
 * reminder, the sheet diff after approval, and the words.
 */
import { describe, expect, it } from "vitest";
import {
  REMINDER_LEAD_MS,
  buildChangeNotice,
  buildTeamsText,
  diffSheets,
  isProposalDue,
  isReminderDue,
  effectiveTeamsReadyTime,
  normaliseTeamsReadyTime,
  teamCommandFromFacts,
  planTeamChange,
  bestSwap,
  resolveSheetName,
  resolveSwap,
  teamsReadyAt,
  unevenSides,
  type SheetPlayer,
  type SheetSlot,
} from "../team-proposal-rules";

describe("unevenSides: an even total splits exactly, an odd one may be one apart", () => {
  it.each([
    [9, 9, false],
    [8, 10, true],
    [9, 8, false],
    [7, 10, true],
    [10, 8, true],
    [0, 0, false],
  ])("%i v %i: %s", (red, yellow, uneven) => {
    expect(unevenSides(red, yellow)).toBe(uneven);
  });

  it("the proposal names the counts; final teams and an even split do not", () => {
    const base = { lang: "en", announce: true, redLabel: "Red", yellowLabel: "Yellow", unseated: [], kickoff: "20:30", venue: "Powerleague" };
    const n = (k: number) => Array.from({ length: k }, (_, i) => ({ name: `P${i}` }));
    expect(buildTeamsText({ ...base, final: false, red: n(8), yellow: n(10) })).toContain(
      "⚠️ The sides are uneven: Red 8, Yellow 10. Tell me who to move to even them, in your own words, or reply *YES* twice to keep them.",
    );
    // A player who is out does not count on his side.
    expect(buildTeamsText({ ...base, final: false, red: [...n(9), { name: "X", out: true }], yellow: n(9) })).not.toContain("uneven");
    expect(buildTeamsText({ ...base, final: true, red: n(8), yellow: n(10) })).not.toContain("uneven");
    expect(buildTeamsText({ ...base, lang: "tr", final: false, red: n(8), yellow: n(10) })).toContain(
      "⚠️ Takımlar dengesiz: Red 8, Yellow 10. Dengelemek için kimin diğer takıma geçeceğini kendi cümlelerinizle yazın ya da böyle kalsın diye iki kez *EVET* yazın.",
    );
  });
});

describe("teamCommandFromFacts: the shared teams extractor's facts as an admin-group command", () => {
  type Facts = Parameters<typeof teamCommandFromFacts>[0];
  const f = (action: Facts["action"], more: Partial<Facts> = {}) =>
    teamCommandFromFacts({ action, moves: [], swaps: [], pairings: [], swapSides: false, ...more });
  const change = (more: object) => ({ kind: "change", swapSides: false, moves: [], sides: [], together: [], ...more });

  it("show is show; suggest is suggest", () => {
    expect(f("show")).toEqual({ kind: "show" });
    expect(f("suggest")).toEqual({ kind: "suggest" });
  });
  it("generate is a reshuffle that keeps the sides and pairings asked for", () => {
    expect(f("generate")).toEqual({ kind: "reshuffle", sides: [], together: [] });
    expect(f("generate", { pairings: [["Ali", "Habib"]], swaps: [{ personRef: "Sam", team: "YELLOW" }] })).toEqual({
      kind: "reshuffle",
      sides: [{ name: "Sam", to: "YELLOW" }],
      together: [["Ali", "Habib"]],
    });
  });
  it("any number of people with no side named all change side, as ONE change", () => {
    expect(f("swap", { moves: ["Ali", "Bilal Khan"] })).toEqual(change({ moves: ["Ali", "Bilal Khan"] }));
    expect(f("swap", { moves: ["Tom"] })).toEqual(change({ moves: ["Tom"] }));
    const nine = ["Hamzah", "Yorel", "Akram", "Shehryar", "Imz", "Maj", "Mahir", "Habib", "Ali"];
    expect(f("swap", { moves: nine })).toEqual(change({ moves: nine }));
    const sixteen = Array.from({ length: 16 }, (_, i) => `P${i}`);
    expect(f("swap", { moves: sixteen })).toEqual(change({ moves: sixteen }));
  });
  it("the two sides swapped over", () => {
    expect(f("swap", { swapSides: true })).toEqual(change({ swapSides: true }));
  });
  it("people put on a named side, and people put together", () => {
    expect(f("swap", { swaps: [{ personRef: "Sam", team: "YELLOW" }, { personRef: "Ali", team: "RED" }] })).toEqual(
      change({ sides: [{ name: "Sam", to: "YELLOW" }, { name: "Ali", to: "RED" }] }),
    );
    expect(f("swap", { pairings: [["Ali", "Habib"]] })).toEqual(change({ together: [["Ali", "Habib"]] }));
  });
  it("a rename, or a change naming nobody, is unclear", () => {
    expect(f("rename")).toEqual({ kind: "unclear" });
    expect(f("swap")).toEqual({ kind: "unclear" });
  });
  it("an older stub with no moves, pairings or swapSides still reads", () => {
    expect(teamCommandFromFacts({ action: "swap", swaps: [{ personRef: "Sam", team: "RED" }] })).toEqual(change({ sides: [{ name: "Sam", to: "RED" }] }));
  });
});

describe("planTeamChange: a change to teams that already exist", () => {
  // Red: r1..r4, Yellow: y1..y4, all playing. Ratings by id.
  const slots = (n = 4): SheetSlot[] => [
    ...Array.from({ length: n }, (_, i) => ({ slotId: `sr${i + 1}`, userId: `r${i + 1}`, team: "RED" as const, playing: true })),
    ...Array.from({ length: n }, (_, i) => ({ slotId: `sy${i + 1}`, userId: `y${i + 1}`, team: "YELLOW" as const, playing: true })),
  ];
  const R: Record<string, number> = { r1: 8, r2: 6, r3: 5, r4: 3, y1: 8, y2: 6, y3: 5, y4: 3 };
  const rating = (id: string) => R[id] ?? 5;
  const sideOf = (plan: ReturnType<typeof planTeamChange>, id: string) => plan.team.get(id);
  const count = (plan: ReturnType<typeof planTeamChange>, t: "RED" | "YELLOW") => [...plan.team.values()].filter((x) => x === t).length;

  it("named people change side exactly as said, with nobody else moved", () => {
    const plan = planTeamChange({ slots: slots(), moveIds: ["r1", "y2", "y3"], rating });
    expect(sideOf(plan, "r1")).toBe("YELLOW");
    expect(sideOf(plan, "y2")).toBe("RED");
    expect(sideOf(plan, "y3")).toBe("RED");
    expect(plan.moved.sort()).toEqual(["r1", "y2", "y3"]);
    expect(plan.evenedBy).toEqual([]);
  });

  it("the two sides swapped over: everyone changes side", () => {
    const plan = planTeamChange({ slots: slots(), swapSides: true, rating });
    for (const s of slots()) expect(sideOf(plan, s.userId)).toBe(s.team === "RED" ? "YELLOW" : "RED");
    expect(plan.moved).toHaveLength(8);
  });

  it("two people put together: the fewest move, and the sides stay even", () => {
    const plan = planTeamChange({ slots: slots(), together: [["r2", "y2"]], rating });
    expect(sideOf(plan, "r2")).toBe(sideOf(plan, "y2"));
    expect(count(plan, "RED")).toBe(4);
    expect(count(plan, "YELLOW")).toBe(4);
    // One of the pair moved, one other player went back: two moves in all.
    expect(plan.moved.length + plan.evenedBy.length).toBe(2);
  });

  it("the one sent back is the one that keeps the ratings closest", () => {
    // y2 (6) joins r2 on Red (the side of the first named); one Red player
    // goes back. r1 (8) back: Red 20 v Yellow 24; r3 (5) back: 23 v 21;
    // r4 (3) back: 25 v 19. r3 keeps them closest.
    const plan = planTeamChange({ slots: slots(), together: [["r2", "y2"]], rating });
    expect(plan.moved).toEqual(["y2"]);
    expect(plan.evenedBy).toEqual(["r3"]);
  });

  it("a pair already together changes nothing", () => {
    const plan = planTeamChange({ slots: slots(), together: [["r1", "r2"]], rating });
    expect(plan.moved).toEqual([]);
    expect(plan.evenedBy).toEqual([]);
  });

  it("a person put on a named side: moved there, and one comes back to keep it even", () => {
    const plan = planTeamChange({ slots: slots(), sides: [{ userId: "y1", to: "RED" }], rating });
    expect(sideOf(plan, "y1")).toBe("RED");
    expect(count(plan, "RED")).toBe(4);
    expect(plan.evenedBy).toHaveLength(1);
    expect(sideOf(plan, plan.evenedBy[0])).toBe("YELLOW");
  });

  it("two put on opposite named sides: a plain swap, nobody else moves", () => {
    const plan = planTeamChange({ slots: slots(), sides: [{ userId: "r1", to: "YELLOW" }, { userId: "y4", to: "RED" }], rating });
    expect(plan.moved.sort()).toEqual(["r1", "y4"]);
    expect(plan.evenedBy).toEqual([]);
  });

  it("a pair goes to the side a member is put on by name", () => {
    const plan = planTeamChange({ slots: slots(), sides: [{ userId: "r1", to: "YELLOW" }], together: [["r1", "r2"]], rating });
    expect(sideOf(plan, "r1")).toBe("YELLOW");
    expect(sideOf(plan, "r2")).toBe("YELLOW");
    expect(count(plan, "RED")).toBe(4);
  });

  it("nobody out of the game is sent back to even the sides", () => {
    const s = slots().map((x) => (x.userId === "r3" || x.userId === "r4" ? { ...x, playing: false } : x));
    // Red has 2 playing (r1, r2), Yellow 4. y1 joins r1: Red 3 v Yellow 3 already better; nobody is evened back
    // past the even split, and r3, r4 (out) never move.
    const plan = planTeamChange({ slots: s, together: [["r1", "y1"]], rating });
    expect(plan.evenedBy).not.toContain("r3");
    expect(plan.evenedBy).not.toContain("r4");
  });
});

describe("bestSwap: the one swap that evens the ratings most", () => {
  const s = (team: "RED" | "YELLOW", userId: string, playing = true): SheetSlot => ({ slotId: userId, userId, team, playing });
  it("finds the swap that closes the gap", () => {
    // Red 9+7+6=22, Yellow 5+4+3=12: swapping 9 and 4 gives 17 v 17.
    const R: Record<string, number> = { a: 9, b: 7, e: 6, c: 5, d: 4, f: 3 };
    const sheet = [s("RED", "a"), s("RED", "b"), s("RED", "e"), s("YELLOW", "c"), s("YELLOW", "d"), s("YELLOW", "f")];
    expect(bestSwap(sheet, (id) => R[id])).toEqual({ red: "a", yellow: "d" });
  });
  it("none when no swap makes it fairer", () => {
    const R: Record<string, number> = { a: 6, b: 4, c: 6, d: 4 };
    expect(bestSwap([s("RED", "a"), s("RED", "b"), s("YELLOW", "c"), s("YELLOW", "d")], (id) => R[id])).toBeNull();
  });
  it("only players still playing are swapped", () => {
    // Red a 9 + e 8 = 17 (b, out, does not count), Yellow c 5 + d 4 = 9.
    const R: Record<string, number> = { a: 9, e: 8, b: 1, c: 5, d: 4 };
    expect(bestSwap([s("RED", "a"), s("RED", "e"), s("RED", "b", false), s("YELLOW", "c"), s("YELLOW", "d")], (id) => R[id])).toEqual({ red: "a", yellow: "c" });
  });
});

const P = (userId: string, name: string, aliases: string[] = []): SheetPlayer => ({ userId, name, aliases });
const PLAYERS = [
  P("u-ali", "Ali Khan"),
  P("u-ali2", "Ali Rahman"),
  P("u-bilal", "Bilal Ahmed", ["bilo"]),
  P("u-sheh", "Shehryar Malik"),
  P("u-tom", "Tom Third"),
];

describe("resolveSheetName: the club's own rules, against the teams only", () => {
  it("the whole name", () => {
    expect(resolveSheetName("ali khan", PLAYERS)).toEqual({ kind: "one", userId: "u-ali" });
  });
  it("an alias", () => {
    expect(resolveSheetName("Bilo", PLAYERS)).toEqual({ kind: "one", userId: "u-bilal" });
  });
  it("a unique first name, or a prefix of three letters or more", () => {
    expect(resolveSheetName("Bilal", PLAYERS)).toEqual({ kind: "one", userId: "u-bilal" });
    expect(resolveSheetName("Sheh", PLAYERS)).toEqual({ kind: "one", userId: "u-sheh" });
  });
  it("two players: ambiguous, with both names", () => {
    expect(resolveSheetName("Ali", PLAYERS)).toEqual({ kind: "ambiguous", names: ["Ali Khan", "Ali Rahman"] });
  });
  it("nobody on the teams: unknown", () => {
    expect(resolveSheetName("Zara", PLAYERS)).toEqual({ kind: "unknown" });
    expect(resolveSheetName("", PLAYERS)).toEqual({ kind: "unknown" });
  });
});

describe("resolveSwap: the first split where both names land on one player", () => {
  it("picks the split that resolves", () => {
    expect(
      resolveSwap(
        [
          ["Ali", "Khan Bilal"],
          ["Ali Khan", "Bilal"],
        ],
        PLAYERS,
      ),
    ).toEqual({ kind: "ok", a: "u-ali", b: "u-bilal" });
  });
  it("one name unclear: the problem names it", () => {
    expect(resolveSwap([["Ali", "Bilal"]], PLAYERS)).toEqual({
      kind: "problem",
      problems: [{ raw: "Ali", res: { kind: "ambiguous", names: ["Ali Khan", "Ali Rahman"] } }],
    });
  });
  it("both unknown: both named", () => {
    expect(resolveSwap([["Zed", "Yan"]], PLAYERS)).toEqual({
      kind: "problem",
      problems: [
        { raw: "Zed", res: { kind: "unknown" } },
        { raw: "Yan", res: { kind: "unknown" } },
      ],
    });
  });
  it("the same player twice is not a swap", () => {
    expect(resolveSwap([["Bilal", "Bilo"]], PLAYERS)).toMatchObject({ kind: "problem" });
  });
});

describe("Teams ready: the setting and the timing", () => {
  it("normalises the setting", () => {
    expect(normaliseTeamsReadyTime("10:00")).toBe("10:00");
    expect(normaliseTeamsReadyTime("9:05")).toBe("09:05");
    expect(normaliseTeamsReadyTime(" off ")).toBe("off");
    expect(normaliseTeamsReadyTime("OFF")).toBe("off");
    expect(normaliseTeamsReadyTime("24:00")).toBeNull();
    expect(normaliseTeamsReadyTime("10:60")).toBeNull();
    expect(normaliseTeamsReadyTime("ten")).toBeNull();
    expect(normaliseTeamsReadyTime(null)).toBeNull();
  });

  // Friday 16 Oct 2026, kickoff 20:00 London (BST, 19:00 UTC).
  const KICKOFF = new Date("2026-10-16T19:00:00.000Z");

  it("the London wall clock on the match's own day, DST-aware", () => {
    expect(teamsReadyAt(KICKOFF, "10:00")?.toISOString()).toBe("2026-10-16T09:00:00.000Z");
    // A winter Friday: GMT.
    expect(teamsReadyAt(new Date("2026-12-04T20:00:00.000Z"), "10:00")?.toISOString()).toBe("2026-12-04T10:00:00.000Z");
    expect(teamsReadyAt(KICKOFF, "off")).toBeNull();
    expect(teamsReadyAt(KICKOFF, "nonsense")).toBeNull();
  });

  it("due from the ready time until kickoff, never before, never off", () => {
    const at = (iso: string) => isProposalDue({ now: new Date(iso), kickoff: KICKOFF, readyTime: "10:00" });
    expect(at("2026-10-16T08:59:00.000Z")).toBe(false);
    expect(at("2026-10-16T09:00:00.000Z")).toBe(true);
    expect(at("2026-10-16T18:59:00.000Z")).toBe(true);
    expect(at("2026-10-16T19:00:00.000Z")).toBe(false);
    // The day before at 10:00 is not match day.
    expect(at("2026-10-15T09:30:00.000Z")).toBe(false);
    expect(isProposalDue({ now: new Date("2026-10-16T12:00:00.000Z"), kickoff: KICKOFF, readyTime: "off" })).toBe(false);
  });

  it("a ready time after kickoff never fires", () => {
    expect(isProposalDue({ now: new Date("2026-10-16T18:30:00.000Z"), kickoff: KICKOFF, readyTime: "21:00" })).toBe(false);
  });

  it("the reminder: from kickoff minus 2 hours until kickoff", () => {
    expect(REMINDER_LEAD_MS).toBe(2 * 60 * 60 * 1000);
    const at = (iso: string) => isReminderDue({ now: new Date(iso), kickoff: KICKOFF });
    expect(at("2026-10-16T16:59:00.000Z")).toBe(false);
    expect(at("2026-10-16T17:00:00.000Z")).toBe(true);
    expect(at("2026-10-16T18:59:59.000Z")).toBe(true);
    expect(at("2026-10-16T19:00:00.000Z")).toBe(false);
  });
});

describe("effectiveTeamsReadyTime: the default follows who announces", () => {
  it("nothing stored: 10:00 when the organisers announce, Off when MatchTime does", () => {
    expect(effectiveTeamsReadyTime(null, true)).toBe("10:00");
    expect(effectiveTeamsReadyTime(null, false)).toBe("off");
    expect(effectiveTeamsReadyTime(undefined, true)).toBe("10:00");
  });
  it("an explicit setting always wins", () => {
    expect(effectiveTeamsReadyTime("11:30", false)).toBe("11:30");
    expect(effectiveTeamsReadyTime("off", true)).toBe("off");
  });
  it("a stored value that is not a time is Off, never a guess", () => {
    expect(effectiveTeamsReadyTime("nonsense", true)).toBe("off");
  });
});

const S = (slotId: string, userId: string, team: "RED" | "YELLOW", playing = true): SheetSlot => ({ slotId, userId, team, playing });

describe("diffSheets: what changed in the teams since the admin group was told", () => {
  const before = [S("s1", "a", "RED"), S("s2", "b", "RED"), S("s3", "c", "YELLOW"), S("s4", "d", "YELLOW")];

  it("nothing changed", () => {
    expect(diffSheets(before, before)).toEqual([]);
  });
  it("a replacement inherits the slot", () => {
    const after = [S("s1", "a", "RED"), S("s2", "x", "RED"), S("s3", "c", "YELLOW"), S("s4", "d", "YELLOW")];
    expect(diffSheets(before, after)).toEqual([{ kind: "replaced", team: "RED", fromUserId: "b", toUserId: "x" }]);
  });
  it("a drop-out with nobody yet: the place is open", () => {
    const after = [S("s1", "a", "RED"), S("s2", "b", "RED", false), S("s3", "c", "YELLOW"), S("s4", "d", "YELLOW")];
    expect(diffSheets(before, after)).toEqual([{ kind: "out", team: "RED", userId: "b" }]);
  });
  it("back in", () => {
    const was = [S("s1", "a", "RED", false)];
    expect(diffSheets(was, [S("s1", "a", "RED")])).toEqual([{ kind: "back", team: "RED", userId: "a" }]);
  });
  it("moved to the other team", () => {
    const after = [S("s1", "a", "YELLOW"), S("s2", "b", "RED"), S("s3", "c", "YELLOW"), S("s4", "d", "YELLOW")];
    expect(diffSheets(before, after)).toEqual([{ kind: "moved", team: "YELLOW", userId: "a" }]);
  });
  it("added and removed slots", () => {
    const after = [S("s1", "a", "RED"), S("s2", "b", "RED"), S("s3", "c", "YELLOW"), S("s5", "e", "RED")];
    expect(diffSheets(before, after)).toEqual([
      { kind: "removed", team: "YELLOW", userId: "d" },
      { kind: "added", team: "RED", userId: "e" },
    ]);
  });
});

const TEAMS = {
  redLabel: "Red",
  yellowLabel: "Yellow",
  red: [{ name: "Ali Khan" }, { name: "Bilal Ahmed", out: true }],
  yellow: [{ name: "Tom Third" }, { name: "Shehryar Malik" }],
  unseated: [] as string[],
  kickoff: "20:00",
  venue: "Goals Sutton",
};

describe("the words", () => {
  it("a proposal in English, quiet mode: teams, how to change, YES, and that nothing goes to the players", () => {
    expect(buildTeamsText({ lang: "en", final: false, announce: true, ...TEAMS })).toBe(
      [
        "📝 *Proposed teams*: 20:00 at Goals Sutton",
        "",
        "*Red*:",
        "1. Ali Khan",
        "2. Bilal Ahmed  (out, place open)",
        "",
        "*Yellow*:",
        "1. Tom Third",
        "2. Shehryar Malik",
        "",
        "To change them, just tell me in your own words (for example *swap Ali and Tom*, *move Ali to the other team* or *shuffle them again*).",
        "Reply *YES* when they are final. I won't post them in the players' group.",
      ].join("\n"),
    );
  });

  it("a proposal in Turkish", () => {
    const text = buildTeamsText({ lang: "tr", final: false, announce: true, ...TEAMS, unseated: ["Zara Zest"] });
    expect(text).toContain("📝 *Önerilen takımlar*: 20:00, Goals Sutton");
    expect(text).toContain("2. Bilal Ahmed  (çıktı, yeri boş)");
    expect(text).toContain("Henüz takımı olmayan: Zara Zest.");
    expect(text).toContain("*Ali ile Tom yer değiştirsin*");
    expect(text).toContain("*Ali diğer takıma geçsin*");
    expect(text).toContain("kendi cümlelerinizle");
    expect(text).toContain("Kesinleşince *EVET* yazın. Oyuncu grubuna ben göndermeyeceğim.");
  });

  it("not in quiet mode, YES says the teams go to the players' group", () => {
    expect(buildTeamsText({ lang: "en", final: false, announce: false, ...TEAMS })).toContain(
      "Reply *YES* when they are final and I'll post them in the players' group.",
    );
  });

  it("final teams say so", () => {
    const text = buildTeamsText({ lang: "en", final: true, announce: true, ...TEAMS });
    expect(text.startsWith("✅ *Final teams*: 20:00 at Goals Sutton")).toBe(true);
    expect(text).not.toContain("YES");
  });

  it("a change notice lists what changed, then the teams", () => {
    const text = buildChangeNotice({
      lang: "en",
      items: [
        { kind: "replaced", team: "Red", from: "Bilal Ahmed", to: "Zara Zest" },
        { kind: "out", team: "Yellow", name: "Tom Third" },
      ],
      teamsText: "TEAMS",
    });
    expect(text).toBe("🔄 *Team change*: Zara Zest replaces Bilal Ahmed on Red; Tom Third is out, Yellow has a place open.\n\nTEAMS");
  });

  it("no long dashes in any rendering", () => {
    for (const lang of ["en", "tr"]) {
      for (const final of [true, false]) {
        for (const announce of [true, false]) {
          expect(buildTeamsText({ lang, final, announce, ...TEAMS, unseated: ["X"] })).not.toMatch(new RegExp("[\\u2013\\u2014]"));
        }
      }
    }
  });
});
