/**
 * READING OUR OWN MAN OF THE MATCH POST BACK (review of #608, 2026-11-16),
 * for `scripts/backfill-mom-announcements.ts`. Every post since 2026-10-20
 * stored its exact words (`SentNotification.text`). This is OUR output, not
 * people's words: the parser takes it apart by the template's structure and
 * accepts it only when our own builder renders the parsed result back to the
 * very same text. Anything else is no result, never a guess.
 *
 * Every case below is real template output, rendered by the composer.
 */
import { describe, expect, it } from "vitest";
import { buildMomAnnouncement, buildMomPickedAnnouncement } from "../mom-announcement";
import { RETIRED_TROPHY_LINES, matchMomPostToRoster, parseMomAnnouncementText, type ParsedMomPost } from "../mom-announcement-parse";

/** The parsed tally of a voted post; null for anything else. */
const tallyOf = (p: ParsedMomPost | null) => (p?.kind === "vote" ? p.tally : null);

const vote = (lang: "en" | "tr", tally: Array<[string, number]>, mvpLabel = "Man of the Match", activityName = "Tuesday 7-a-side") =>
  buildMomAnnouncement({ mvpLabel, activityName, lang, tally: tally.map(([name, votes]) => ({ name, votes })) });

describe("parseMomAnnouncementText: every variant of the template", () => {
  it("a single winner, English", () => {
    expect(parseMomAnnouncementText(vote("en", [["Mojib", 5], ["Habib", 3], ["Sait", 1]]))).toEqual({
      lang: "en",
      kind: "vote",
      tally: [{ name: "Mojib", votes: 5 }, { name: "Habib", votes: 3 }, { name: "Sait", votes: 1 }],
    });
  });

  it("one vote in total (the singular 'vote'), English", () => {
    expect(parseMomAnnouncementText(vote("en", [["Mojib", 1]]))).toEqual({ lang: "en", kind: "vote", tally: [{ name: "Mojib", votes: 1 }] });
  });

  it("shared by two and by three, English", () => {
    expect(tallyOf(parseMomAnnouncementText(vote("en", [["Habib", 2], ["Mojib", 2], ["Sait", 1]])))).toEqual([
      { name: "Habib", votes: 2 },
      { name: "Mojib", votes: 2 },
      { name: "Sait", votes: 1 },
    ]);
    expect(tallyOf(parseMomAnnouncementText(vote("en", [["Ali", 1], ["Ben", 1], ["Cem", 1]])))?.map((t) => t.name)).toEqual(["Ali", "Ben", "Cem"]);
  });

  it("the Turkish template: single and shared", () => {
    expect(parseMomAnnouncementText(vote("tr", [["Erdal Özkan", 4], ["Kemal", 2]], "Maçın Adamı", "Salı Maçı"))).toEqual({
      lang: "tr",
      kind: "vote",
      tally: [{ name: "Erdal Özkan", votes: 4 }, { name: "Kemal", votes: 2 }],
    });
    expect(tallyOf(parseMomAnnouncementText(vote("tr", [["Burak", 2], ["Ozgur", 2]], "Maçın Adamı", "Salı Maçı")))?.map((t) => t.name)).toEqual([
      "Burak",
      "Ozgur",
    ]);
  });

  it("an organisers' pick, English and Turkish", () => {
    expect(parseMomAnnouncementText(buildMomPickedAnnouncement({ mvpLabel: "Man of the Match", activityName: "FNF", name: "Akram", lang: "en" }))).toEqual({
      lang: "en",
      kind: "pick",
      name: "Akram",
    });
    expect(parseMomAnnouncementText(buildMomPickedAnnouncement({ mvpLabel: "Maçın Adamı", activityName: "Cuma", name: "Erdal", lang: "tr" }))).toEqual({
      lang: "tr",
      kind: "pick",
      name: "Erdal",
    });
  });

  it("a post from before 2026-10-31 that still ended on the trophy line", () => {
    const en = `${vote("en", [["Mojib", 3]])}\n\n${RETIRED_TROPHY_LINES.en}`;
    expect(tallyOf(parseMomAnnouncementText(en))).toEqual([{ name: "Mojib", votes: 3 }]);
    const pick = `${buildMomPickedAnnouncement({ mvpLabel: "Maçın Adamı", activityName: "Cuma", name: "Erdal", lang: "tr" })}\n\n${RETIRED_TROPHY_LINES.tr}`;
    expect(parseMomAnnouncementText(pick)).toEqual({ lang: "tr", kind: "pick", name: "Erdal" });
  });

  it("awkward names and labels survive: brackets, colons, commas, an MVP label", () => {
    const text = vote("en", [["Ali (GK)", 2], ["J. Smith-Jones", 1]], "Player of the Match", "Sunday: 5s, Hall 2");
    expect(tallyOf(parseMomAnnouncementText(text))).toEqual([{ name: "Ali (GK)", votes: 2 }, { name: "J. Smith-Jones", votes: 1 }]);
  });

  it("anything that is not exactly our post is NO result: truncated, edited, re-ordered, foreign", () => {
    const full = vote("en", [["Mojib", 5], ["Habib", 3]]);
    expect(parseMomAnnouncementText(full.slice(0, full.length - 3))).toBeNull();
    expect(parseMomAnnouncementText(full.replace("(5/8 votes)", "(5/9 votes)"))).toBeNull();
    expect(parseMomAnnouncementText(full.replace("• Mojib (5)\n• Habib (3)", "• Habib (3)\n• Mojib (5)"))).toBeNull();
    expect(parseMomAnnouncementText(`${full}\n\nsee you next week`)).toBeNull();
    expect(parseMomAnnouncementText("Congrats Mojib!")).toBeNull();
    expect(parseMomAnnouncementText("")).toBeNull();
  });
});

describe("matchMomPostToRoster: every name must be exactly one of the match's people", () => {
  const roster = [
    { userId: "u-mojib", name: "Mojib" },
    { userId: "u-habib", name: "Habib" },
    { userId: "u-ali-1", name: "Ali" },
    { userId: "u-ali-2", name: "Ali" },
  ];

  it("a vote: each name to its user, the record as stored", () => {
    expect(matchMomPostToRoster({ lang: "en", kind: "vote", tally: [{ name: "Mojib", votes: 5 }, { name: "Habib", votes: 3 }] }, roster)).toEqual({
      ok: true,
      result: { v: 1, kind: "vote", tally: [{ userId: "u-mojib", name: "Mojib", votes: 5 }, { userId: "u-habib", name: "Habib", votes: 3 }], winners: ["u-mojib"] },
    });
  });

  it("a pick", () => {
    expect(matchMomPostToRoster({ lang: "en", kind: "pick", name: "Habib" }, roster)).toEqual({
      ok: true,
      result: { v: 1, kind: "pick", winner: { userId: "u-habib", name: "Habib" } },
    });
  });

  it("a name nobody has, or two people have, is skipped with the reason", () => {
    expect(matchMomPostToRoster({ lang: "en", kind: "pick", name: "Zed" }, roster)).toEqual({ ok: false, reason: 'no one at the match is called "Zed"' });
    expect(matchMomPostToRoster({ lang: "en", kind: "vote", tally: [{ name: "Ali", votes: 2 }] }, roster)).toEqual({
      ok: false,
      reason: '2 people at the match are called "Ali"',
    });
  });

  it("exact names only: no trimming, no case folding", () => {
    expect(matchMomPostToRoster({ lang: "en", kind: "pick", name: "mojib" }, roster).ok).toBe(false);
  });
});
