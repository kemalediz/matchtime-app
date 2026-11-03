/** The fewest players a game is played with: the copy obeys the house rules in both languages. */
import { describe, it, expect } from "vitest";
import { minPlayersCopy } from "../min-players";

const render = (lang: "en" | "tr"): string[] => {
  const c = minPlayersCopy(lang);
  const nudge = { activityName: "Vets 7s", signInUrl: "https://matchtime.ai/t/abc", pageUrl: "https://matchtime.ai/admin/matches/m1/cancel" };
  return [
    c.lowNumbers({ ...nudge, confirmed: 11, maxPlayers: 14, switchTo: "Football 5-a-side", switchPlayers: 10, audience: "dm" }),
    c.lowNumbers({ ...nudge, confirmed: 11, maxPlayers: 14, switchTo: "Football 5-a-side", switchPlayers: 10, audience: "group" }),
    c.matchInTrouble({ ...nudge, confirmed: 11, minimum: 12, audience: "dm" }),
    c.matchInTrouble({ ...nudge, confirmed: 11, minimum: 12, audience: "group" }),
  ];
};

describe("minimum players copy", () => {
  it.each(["en", "tr"] as const)("%s: no dashes, no separator slashes, never waiting list", (lang) => {
    for (const line of render(lang)) {
      expect(line).not.toMatch(/[–—]/);
      expect(line.replace(/https?:\/\/\S+/g, "")).not.toMatch(/\//);
      expect(line.toLowerCase()).not.toMatch(/waiting list|bekleme listesi/);
    }
  });

  it("Turkish is never the English", () => {
    const en = render("en");
    render("tr").forEach((line, i) => expect(line).not.toBe(en[i]));
  });

  it("the 18:00 nudge names the minimum it used", () => {
    const [, , dm] = render("en");
    expect(dm).toContain("only *11* confirmed");
    expect(dm).toContain("below the minimum to play (12)");
    expect(render("tr")[2]).toContain("en az 12 kişi");
  });

  it("the 10:00 nudge says 11 of 14, not 11/14", () => {
    expect(render("en")[0]).toContain("11 of 14 confirmed");
  });
});
