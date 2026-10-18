/**
 * The two rating reminders (Kemal, 2026-10-18): a first one and a last
 * one, in English and Turkish. The last one says it is the last and that
 * ratings close soon. A club whose organisers pick Man of the Match
 * (#317, `organisersPickMom`) is never asked to vote for it.
 */
import { describe, it, expect } from "vitest";
import { buildRatingReminderDm } from "../dm-copy";

const base = {
  playerName: "Sait Demir",
  activityName: "Tuesday 7-a-side",
  mvpLabel: "Man of the Match",
  url: "https://mt.example/s/rate",
};

const ALL = (["en", "tr"] as const).flatMap((lang) =>
  (["first", "last"] as const).flatMap((reminder) =>
    [true, false].map((momVote) => ({ lang, reminder, momVote })),
  ),
);

describe("both reminders, both languages", () => {
  it.each(ALL)("$lang $reminder momVote=$momVote: names the player, the match and the link, no dashes", ({ lang, reminder, momVote }) => {
    const text = buildRatingReminderDm({ ...base, reminder, lang, ...(momVote ? {} : { momVote: false }) });
    expect(text).toContain("Sait");
    expect(text).not.toContain("Demir");
    expect(text).toContain("*Tuesday 7-a-side*");
    expect(text.endsWith("\nhttps://mt.example/s/rate")).toBe(true);
    expect(text).not.toMatch(/[–—]/);
  });

  it.each(ALL)("$lang $reminder momVote=$momVote: Man of the Match only when players vote for it", ({ lang, reminder, momVote }) => {
    const text = buildRatingReminderDm({ ...base, reminder, lang, ...(momVote ? {} : { momVote: false }) });
    if (momVote) expect(text).toContain("Man of the Match");
    else expect(text).not.toContain("Man of the Match");
  });
});

describe("the two variants read differently", () => {
  it("English: the last says it is the last and that ratings close soon; the first does not", () => {
    const first = buildRatingReminderDm({ ...base, reminder: "first", lang: "en" });
    const last = buildRatingReminderDm({ ...base, reminder: "last", lang: "en" });
    expect(last).toMatch(/last reminder/i);
    expect(last).toMatch(/close soon/i);
    expect(first).not.toMatch(/last reminder/i);
    expect(first).not.toEqual(last);
  });

  it("Turkish: the last says it is the last (son hatırlatma) and that ratings close soon (yakında kapanıyor)", () => {
    const first = buildRatingReminderDm({ ...base, reminder: "first", lang: "tr" });
    const last = buildRatingReminderDm({ ...base, reminder: "last", lang: "tr" });
    expect(last).toMatch(/son hatırlatma/i);
    expect(last).toContain("yakında kapanıyor");
    expect(first).not.toMatch(/son hatırlatma/i);
    expect(first).not.toEqual(last);
  });

  it("no name: English says mate, Turkish leaves the name out", () => {
    for (const reminder of ["first", "last"] as const) {
      expect(buildRatingReminderDm({ ...base, playerName: null, reminder, lang: "en" })).toContain("mate");
      expect(buildRatingReminderDm({ ...base, playerName: null, reminder, lang: "tr" })).not.toContain("null");
    }
  });
});
