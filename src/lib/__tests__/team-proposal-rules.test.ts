/**
 * Teams proposed and approved in a club's admin group (2026-10-14): the
 * pure half. The command parser (EN and TR, whole messages only), the name
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
  parseTeamCommand,
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
      "⚠️ The sides are uneven: Red 8, Yellow 10. *move* a player to even them, or reply *YES* twice to keep them.",
    );
    // A player who is out does not count on his side.
    expect(buildTeamsText({ ...base, final: false, red: [...n(9), { name: "X", out: true }], yellow: n(9) })).not.toContain("uneven");
    expect(buildTeamsText({ ...base, final: true, red: n(8), yellow: n(10) })).not.toContain("uneven");
    expect(buildTeamsText({ ...base, lang: "tr", final: false, red: n(8), yellow: n(10) })).toContain(
      "⚠️ Takımlar dengesiz: Red 8, Yellow 10. Dengelemek için bir oyuncuyu *taşı* ile geçirin ya da böyle kalsın diye iki kez *EVET* yazın.",
    );
  });
});

describe("parseTeamCommand: whole-message commands, EN and TR", () => {
  it.each([
    ["teams", { kind: "show" }],
    ["Teams", { kind: "show" }],
    ["TEAMS!", { kind: "show" }],
    ["the teams?", { kind: "show" }],
    ["show teams", { kind: "show" }],
    ["@Match Time teams", { kind: "show" }],
    ["takımlar", { kind: "show" }],
    ["Takımlar", { kind: "show" }],
    ["TAKIMLAR", { kind: "show" }],
    ["takimlar", { kind: "show" }],
    ["takımları göster", { kind: "show" }],
    ["reshuffle", { kind: "reshuffle" }],
    ["Reshuffle.", { kind: "reshuffle" }],
    ["reshuffle the teams", { kind: "reshuffle" }],
    ["shuffle", { kind: "reshuffle" }],
    ["new teams", { kind: "reshuffle" }],
    ["yeniden", { kind: "reshuffle" }],
    ["Yeniden karıştır", { kind: "reshuffle" }],
    ["karıştır", { kind: "reshuffle" }],
  ])("%s", (text, want) => {
    expect(parseTeamCommand(text)).toEqual(want);
  });

  it("swap with a separator gives one pair, names as typed", () => {
    expect(parseTeamCommand("swap Ali and Bilal Khan")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal Khan"]] });
    expect(parseTeamCommand("Swap Ali with Bilal")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("swap Ali & Bilal")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("swap Ali, Bilal")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("swap Ali for Bilal")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
  });

  it("swap without a separator gives every split, left to right", () => {
    expect(parseTeamCommand("swap Ali Bilal")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("swap Ali Khan Bilal")).toEqual({
      kind: "swap",
      pairs: [
        ["Ali", "Khan Bilal"],
        ["Ali Khan", "Bilal"],
      ],
    });
  });

  it("Turkish swap: 'A ile B değiş', with or without the case ending", () => {
    expect(parseTeamCommand("Ali ile Bilal değiş")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("Ali ile Bilal'i değiştir")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("Ali ile Bilal yer değiştir")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("Ali ile Bilal degis")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
    expect(parseTeamCommand("değiş Ali Bilal")).toEqual({ kind: "swap", pairs: [["Ali", "Bilal"]] });
  });

  it("move, EN and TR", () => {
    expect(parseTeamCommand("move Ali")).toEqual({ kind: "move", name: "Ali" });
    expect(parseTeamCommand("Move Ali Khan to the other team")).toEqual({ kind: "move", name: "Ali Khan" });
    expect(parseTeamCommand("move Ali to other side")).toEqual({ kind: "move", name: "Ali" });
    expect(parseTeamCommand("Ali'yi taşı")).toEqual({ kind: "move", name: "Ali" });
    expect(parseTeamCommand("taşı Ali")).toEqual({ kind: "move", name: "Ali" });
    expect(parseTeamCommand("Ali diğer takıma")).toEqual({ kind: "move", name: "Ali" });
  });

  it.each([
    "",
    "   ",
    "yes",
    "Shehryar out",
    "teams look good",
    "what are the teams",
    "can you swap Ali and Bilal please",
    "swap",
    "swap Ali",
    "move",
    "I'll move Ali later",
    "1. Alex\n2. Bilal",
    "swap Ali and",
    `swap ${"a ".repeat(60)}b`,
  ])("not a command: %j", (text) => {
    expect(parseTeamCommand(text)).toBeNull();
  });

  it("is never thrown by a non-string", () => {
    expect(parseTeamCommand(undefined as unknown as string)).toBeNull();
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
        "To change them: *swap Ali Tom* swaps two players, *move Ali* moves one to the other team, *reshuffle* builds new teams.",
        "Reply *YES* when they are final. I won't post them in the players' group.",
      ].join("\n"),
    );
  });

  it("a proposal in Turkish", () => {
    const text = buildTeamsText({ lang: "tr", final: false, announce: true, ...TEAMS, unseated: ["Zara Zest"] });
    expect(text).toContain("📝 *Önerilen takımlar*: 20:00, Goals Sutton");
    expect(text).toContain("2. Bilal Ahmed  (çıktı, yeri boş)");
    expect(text).toContain("Henüz takımı olmayan: Zara Zest.");
    expect(text).toContain("*Ali ile Tom değiş*");
    expect(text).toContain("*Ali taşı*");
    expect(text).toContain("*yeniden*");
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
