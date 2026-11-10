/** Moving a game by WhatsApp: the copy obeys the house rules in both languages. */
import { describe, it, expect } from "vitest";
import { gameMoveCopy, type GameStayReason } from "../game-move";

const REASONS: GameStayReason[] = ["started", "set-by-hand", "into-the-past", "other-month", "unreadable-time", "unchanged", "gone"];
const render = (lang: "en" | "tr"): string[] => {
  const c = gameMoveCopy(lang);
  const day = lang === "tr" ? "16 Kasım Pazartesi" : "Mon 16 Nov";
  return [
    c.movedOne({ day, toDay: null, time: "20:15", was: "20:30" }),
    c.movedOne({ day, toDay: lang === "tr" ? "18 Kasım Çarşamba" : "Wed 18 Nov", time: "20:30", was: "20:30" }),
    ...REASONS.map((reason) => c.stayedOne({ reason, day, time: "20:30", to: "20:15" })),
    c.movedWeekly({ name: "Monday Vets", weekday: lang === "tr" ? "Pazartesi" : "Monday", time: "20:15", moved: [day], stayed: REASONS.map((reason) => ({ day, reason })) }),
    c.movedWeekly({ name: "Monday Vets", weekday: "Monday", time: "20:15", moved: [], stayed: [] }),
    c.weeklyUnchanged({ name: "Monday Vets", weekday: "Monday", time: "20:15" }),
    c.which({ options: ["Mon 16 Nov 20:30 (Monday Vets)", "Thu 19 Nov 19:00 (Thursday 7s)"], change: "20:15" }),
    c.whichWeekly({ options: ["Monday Vets", "Thursday 7s"], change: "20:15" }),
    c.sayWhat,
    c.noGames,
    c.invalid,
  ];
};

describe("moving a game by WhatsApp: copy", () => {
  it.each(["en", "tr"] as const)("%s: no dashes, no separator slashes, never waiting list", (lang) => {
    for (const line of render(lang)) {
      expect(line).not.toMatch(/[–—]/);
      expect(line).not.toMatch(/\//);
      expect(line.toLowerCase()).not.toMatch(/waiting list|bekleme listesi/);
    }
  });

  it("Turkish is never the English", () => {
    const en = render("en");
    render("tr").forEach((line, i) => expect(line).not.toBe(en[i]));
  });

  it("a move says what moved, and that nothing was posted in the players' group", () => {
    const en = gameMoveCopy("en");
    expect(en.movedOne({ day: "Mon 16 Nov", toDay: null, time: "20:15", was: "20:30" })).toBe(
      "✅ Done: the game on Mon 16 Nov is now at 20:15 (it was 20:30).\nI haven't posted anything in the players' group.",
    );
    expect(gameMoveCopy("tr").movedOne({ day: "16 Kasım Pazartesi", toDay: null, time: "20:15", was: "20:30" })).toBe(
      "✅ Tamam: 16 Kasım Pazartesi maçının saati artık 20:15 (önceden 20:30).\nOyuncu grubuna bir şey yazmadım.",
    );
  });

  it("the weekly move lists what moved and what stayed, and why", () => {
    expect(
      gameMoveCopy("en").movedWeekly({ name: "Monday Vets", weekday: "Monday", time: "20:15", moved: ["Mon 23 Nov"], stayed: [{ day: "Mon 16 Nov", reason: "started" }] }),
    ).toBe(
      "✅ Done: *Monday Vets* kicks off at 20:15 every Monday from now on.\nMoved: Mon 23 Nov.\nLeft as they were: Mon 16 Nov (already kicked off).\nI haven't posted anything in the players' group.",
    );
  });
});
