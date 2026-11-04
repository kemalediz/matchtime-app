/** A game's sizes: the copy obeys the house rules in both languages, and says what Kemal approved. */
import { describe, it, expect } from "vitest";
import { flexFormatCopy, type RangeRefusal } from "../flex-format";
import { composeSquadStateReply } from "../../group-copy";

const URL = "https://matchtime.ai/admin/activities";
const render = (lang: "en" | "tr"): string[] => {
  const c = flexFormatCopy(lang);
  const day = lang === "tr" ? "Pazartesi" : "Monday";
  const refusals: RangeRefusal[] = ["odd", "too-low", "too-high", "min-above-places", "max-below-places", "not-a-number"];
  return [
    c.side(8),
    c.sides([6, 7, 8]),
    c.rangeSet({ activityName: "Vets 7s", min: 12, max: 16, sides: [6, 7, 8], up: true }),
    c.rangeSet({ activityName: "Vets 7s", min: 12, max: 14, sides: [6, 7], up: false }),
    c.rangeCleared({ activityName: "Vets 7s", places: 14, perSide: 7 }),
    c.rangeUnchanged({ activityName: "Vets 7s", min: 12, max: 16, sides: [6, 7, 8] }),
    ...refusals.map((error) => c.rangeRefused({ error, field: "min", activityName: "Vets 7s", places: 14, ceiling: 30, url: URL })),
    c.noNumbers({ url: URL }),
    c.whichGame({ names: ["Monday 7s", "Thursday 5s"], url: URL }),
    c.noGame({ url: URL }),
    c.minLabel,
    c.maxLabel,
    c.minHint({ full: 14 }),
    c.maxHint({ full: 14 }),
    c.allows({ min: 12, max: 16, sides: [6, 7, 8] }),
    c.allows({ min: 14, max: 14, sides: [7] }),
    c.row({ sides: [6, 7, 8] }),
    c.switched({ day, perSide: 8, places: 16, promoted: ["Shane", "Tom"], demoted: [], teamsCleared: true }),
    c.switched({ day, perSide: 6, places: 12, promoted: [], demoted: ["Rob", "Gus"], teamsCleared: false }),
    c.switched({ day, perSide: 8, places: 16, promoted: [], demoted: [], teamsCleared: false, pickOpen: 2 }),
    c.activitySwitched({ day, perSide: 5, places: 10 }),
    c.suggestionStale({ day, perSide: 8 }),
    c.rangeBlocked({ activityName: "Vets 7s", day, perSide: 8, backTo: 7 }),
    c.alreadyThat({ day, perSide: 8 }),
    c.notAllowed({ activityName: "Vets 7s", perSide: 9, sides: [6, 7, 8], url: URL }),
    c.noRange({ activityName: "Vets 7s", perSide: 7, url: URL }),
    c.noSize,
    c.noMatch,
    c.tooLate,
    c.monthlyKeepsGame({ activityName: "Vets 7s" }),
    c.suggestUp({ total: 16, bench: 2, day, perSide: 8, admins: "Davide" }),
    c.dmIn({ day, perSide: 8, price: null }),
    c.dmIn({ day, perSide: 8, price: "£8" }),
    c.dmBench({ day, perSide: 6, places: 12 }),
    c.rosterHeader({ day, perSide: 8, places: 16 }),
    c.rosterPlaying({ confirmed: 16, places: 16 }),
    c.rosterBench,
    c.rosterNobody,
    c.pageSizesLabel,
    c.pageSizeButton({ perSide: 8, places: 16 }),
    c.pageCurrent({ perSide: 7, places: 14, confirmed: 14 }),
    c.pageWillPromote({ count: 2 }),
    c.pageWillBench({ count: 2 }),
    c.pageConfirm,
    c.pageDone,
    c.pageInvalid,
  ];
};

describe("a game's sizes: copy", () => {
  it.each(["en", "tr"] as const)("%s: no dashes, no separator slashes, never waiting list", (lang) => {
    for (const line of render(lang)) {
      expect(line).not.toMatch(/[–—]/);
      expect(line.replace(/https?:\/\/\S+/g, "")).not.toMatch(/\//);
      expect(line.toLowerCase()).not.toMatch(/waiting list|bekleme listesi/);
    }
  });

  it("Turkish is never the English", () => {
    const en = render("en");
    render("tr").forEach((line, i) => expect(line, en[i]).not.toBe(en[i]));
  });

  it("the words Kemal approved", () => {
    const en = flexFormatCopy("en");
    expect(en.suggestUp({ total: 16, bench: 2, day: "Monday", perSide: 8, admins: "Davide" })).toBe(
      "We've got 16 for Monday, 2 on the bench. Shall we go 8-a-side? Davide, reply *yes* to this message and I'll switch it.",
    );
    expect(en.dmIn({ day: "Monday", perSide: 8, price: null })).toBe("We're going 8-a-side on Monday, you're in. Can't make it after all? Reply OUT.");
    expect(en.allows({ min: 12, max: 16, sides: [6, 7, 8] })).toBe("With 12 to 16 players you can play 6, 7 or 8 a side.");
  });

  it("Turkish reads the number aloud for its ending", () => {
    const tr = flexFormatCopy("tr");
    expect([5, 6, 7, 8, 9, 10, 11, 20].map(tr.side)).toEqual(["5'e 5", "6'ya 6", "7'ye 7", "8'e 8", "9'a 9", "10'a 10", "11'e 11", "20'ye 20"]);
    expect(tr.sides([6, 7, 8])).toBe("6'ya 6, 7'ye 7 ya da 8'e 8");
  });
});

describe("the players' group reply guard leaves the replies alone", () => {
  // `contradictsSquadState` replaces a reply that claims a total above the
  // places beside a squad word: the Vets sandbox caught "12 to 16 players
  // ... bench" on a 14-place match being swapped for the squad post.
  const truth: Parameters<typeof composeSquadStateReply>[1] = { maxPlayers: 14, confirmed: [], bench: [] } as Parameters<typeof composeSquadStateReply>[1];
  it.each(["en", "tr"] as const)("%s", (lang) => {
    const c = flexFormatCopy(lang);
    for (const reply of [
      c.rangeSet({ activityName: "Vets 7s", min: 12, max: 16, sides: [6, 7, 8], up: true }),
      c.rangeUnchanged({ activityName: "Vets 7s", min: 12, max: 16, sides: [6, 7, 8] }),
      c.rangeCleared({ activityName: "Vets 7s", places: 14, perSide: 7 }),
      c.notAllowed({ activityName: "Vets 7s", perSide: 9, sides: [6, 7, 8], url: "https://x" }),
    ]) {
      expect(composeSquadStateReply(reply, truth, lang), reply).toEqual({ text: reply, composed: false });
    }
  });
});
