import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildHelpReply, type HelpFeatures } from "@/lib/onboarding-conversation";

/**
 * THE SCORE, WHATEVER A CLUB CALLS ITS TEAMS (2026-11-17, Vets): every
 * feature is explained in the WhatsApp help AND the web guide. The guide
 * pages are read as text, like help-guides-oct31.test.ts.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const text = (src: string) =>
  src
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\{" "\}/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");
const section = (src: string, id: string) => {
  const start = src.indexOf(`id="${id}"`);
  if (start === -1) return "";
  const next = src.indexOf("<h2", start + 1);
  return text(src.slice(start, next === -1 ? undefined : next));
};
const PLAYER = read("src/app/help/player/page.tsx");
const ADMIN = read("src/app/help/admin/page.tsx");

describe("the player guide: after the match", () => {
  const s = section(PLAYER, "after-match");
  it.each([
    ["the club's own names", /bibs 9, no bibs 4/],
    ["a player's team", /Dan's team won 5-3/],
    ["asks once", /asks once/],
    ["the question", /Which team was "bibs": Red or Yellow\?/],
    ["asks again next time, with last time's answer", /next time it asks again and says what it was last time/],
    ["unless the teams are named", /unless an admin has named the teams in the settings/],
  ])("%s", (_l, re) => expect(s).toMatch(re));
  it("no long dashes", () => expect(s).not.toMatch(/[–—]/));
});

describe("the admin guide: after the match", () => {
  const s = text(ADMIN);
  it("says names like bibs are asked about once and remembered for the club", () => {
    expect(s).toMatch(/bibs 9, no bibs 4/);
    expect(s).toMatch(/asks once per game which team it was, and says what it was last time/);
    expect(s).toMatch(/Name the teams in the settings/);
    expect(s).not.toMatch(/remembers it for the club's next games/);
  });
});

describe("the WhatsApp help: teams", () => {
  const on: HelpFeatures = {
    attendance: true,
    teamBalancing: true,
    momVoting: true,
    playerRating: true,
    statsQa: true,
    reminders: true,
    bench: true,
    paymentTracking: false,
    paymentCollection: false,
  };
  it("English", () => {
    const r = buildHelpReply("teams", on, "en", { audience: "group" });
    expect(r).toContain("After the game, tag me with the score in your own words, whatever you call the teams");
    expect(r).toContain("I ask once for that game and say what it was last time");
  });
  it("Turkish", () => {
    const r = buildHelpReply("teams", on, "tr", { audience: "group" });
    expect(r).toContain("Maçtan sonra skoru, takımlara ne derseniz deyin");
    expect(r).toContain("o maç için bir kez sorarım ve geçen sefer hangisi olduğunu söylerim");
  });
});
