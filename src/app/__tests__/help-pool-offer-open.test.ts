import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { t } from "@/lib/i18n/t";

/**
 * A POOL OFFER STAYS OPEN UNTIL KICKOFF (Kemal, 2026-11-09), said where a
 * player reads how the pool works: the "help pool" topic (EN and TR) and
 * the player guide's pool section (`pool/waves.ts` `offerEndsAt`).
 */
const ROOT = path.resolve(__dirname, "../../..");
const PLAYER = readFileSync(path.join(ROOT, "src/app/help/player/page.tsx"), "utf8").replace(/&apos;/g, "'").replace(/\s+/g, " ");
const help = (lang: "en" | "tr", audience: "group" | "player") =>
  t(lang).onbHelpPool({ audience, platformOpen: true, clubFlag: true, open: true, url: "https://mt.example/s/pool", poolLabel: "Pool" });

describe("the pool offer's open window, in the help and the guide", () => {
  it("help pool (players and group): open until kickoff, or until the places are filled", () => {
    for (const audience of ["group", "player"] as const) {
      expect(help("en", audience)).toContain("An offer stays open until kickoff, or until the places are filled.");
      expect(help("tr", audience)).toContain("Teklif maç başlayana ya da yerler dolana kadar açık kalır.");
    }
  });
  it("the player guide says the same, and never a number of hours", () => {
    expect(PLAYER).toContain("The offer stays open until kickoff, or until the places are filled.");
    expect(PLAYER).not.toMatch(/\b(6|six) hours\b/i);
  });
});
