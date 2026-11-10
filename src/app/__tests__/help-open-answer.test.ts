import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildHowToUseMe } from "@/lib/onboarding-conversation";
import { buildHqHelp } from "@/lib/admin-group-help";

/**
 * THE OPEN ANSWER IN THE HELP AND THE GUIDES (2026-11-10, Kemal's rule: every
 * feature is in the WhatsApp help, EN and TR, and in the web guide). A tagged
 * question that fits no set answer is answered from what MatchTime knows
 * (`pipeline/open-answer.ts`).
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

const FEATURES = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: false,
};

describe("@Match Time help", () => {
  it("says MatchTime answers anything else from what it knows, in English", () => {
    expect(buildHowToUseMe(FEATURES, "en")).toContain(
      "❓ Anything else? Tag me and ask in your own words: I'll answer from what I know about the club, or tell you if I don't know.",
    );
  });
  it("and in Turkish", () => {
    expect(buildHowToUseMe(FEATURES, "tr")).toContain("❓ Başka bir şey mi soracaksınız?");
  });
  it("the admin group's menu says it too, EN and TR", () => {
    const p = { squad: true, graphics: false, picks: false, paid: false };
    expect(buildHqHelp({ ...p, lang: "en" })).toMatch(/❓ Anything else: ask in your own words\..*I change nothing\./);
    expect(buildHqHelp({ ...p, lang: "tr" })).toMatch(/❓ Başka bir şey: kendi cümlelerinizle sorun\..*hiçbir şeyi değiştirmem\./);
  });
});

describe("the web guides", () => {
  const PLAYER = text(read("src/app/help/player/page.tsx"));
  const ADMIN = text(read("src/app/help/admin/page.tsx"));
  it("the player guide's questions section has it", () => {
    expect(PLAYER).toMatch(/Anything else\? Tag it and ask in your own words/);
    expect(PLAYER).toMatch(/doesn't know\. Asking never changes anything\./);
  });
  it("the organiser guide's FAQ has it, and the organisers-post-the-list rule", () => {
    expect(ADMIN).toMatch(/something it has no set answer for/);
    expect(ADMIN).toMatch(/never names the squad when your organisers post the list/);
  });
  it("no long dashes", () => {
    expect(PLAYER + ADMIN).not.toMatch(/[–—]/);
  });
});
