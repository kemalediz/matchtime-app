/**
 * "@Match Time help badges" (Kemal, 2026-10-01): a help topic that lists
 * every badge and, with a badge name, explains its exact rules. Which
 * badge was asked about is the question extractor's `badge` (2026-10-28);
 * the words are written here, with no model. The numbers in the text come from the SAME constants
 * the badges are computed with, so help can never disagree with the
 * stats page.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BADGES,
  BADGE_NUMBERS,
  REGULAR_MIN_GAMES,
  IRON_MAN_MIN_MATCHES,
  MOM_MACHINE_MIN_WINS,
  MASTERCLASS_MIN_GAME_AVG,
  ABOVE_CURVE_MIN_RATED_GAMES,
  MR_RELIABLE_EXAMPLE_STEADY,
  MR_RELIABLE_EXAMPLE_SWINGING,
  resolveBadgeName,
  type BadgeKey,
} from "@/lib/badge-rules";
import { HELP_BADGES } from "@/lib/pipeline/types";
import {
  MR_RELIABLE_MAX_SPREAD,
  MR_RELIABLE_MIN_AVG,
  MR_RELIABLE_MIN_GAMES,
  earnsMrReliable,
} from "@/lib/mr-reliable";
import {
  buildHelpReply,
  helpPagesNeeded,
  type HelpFeatures,
} from "@/lib/onboarding-conversation";

const ALL_ON: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: true,
};
const MINIMAL: HelpFeatures = { ...ALL_ON, teamBalancing: false, momVoting: false, playerRating: false, statsQa: false, reminders: false, bench: false, paymentTracking: false };

const KEYS: BadgeKey[] = ["first-game", "ten-games", "ironman", "first-mom", "mom-machine", "masterclass", "reliable", "above-field"];

const group = (q?: string, lang = "en") => buildHelpReply("badges", ALL_ON, lang, { audience: "group", badgeQuery: q });
const dm = (q?: string, lang = "en") => buildHelpReply("badges", ALL_ON, lang, { audience: "player", badgeQuery: q });

describe("the badge catalogue is the stats page's", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../player-stats.ts"), "utf8");

  it("lists the eight badges in the page's order", () => {
    expect(BADGES.map((b) => b.key)).toEqual(KEYS);
  });

  it("every emoji and name is the one the page shows", () => {
    for (const b of BADGES) {
      expect(src, b.key).toContain(`{ key: "${b.key}", emoji: "${b.emoji}", label: "${b.label}"`);
    }
  });

  it("the page computes each badge from the shared constants, not a copied number", () => {
    const line = (key: string) => src.split("\n").find((l) => l.includes(`key: "${key}"`)) ?? "";
    expect(line("ten-games")).toContain("REGULAR_MIN_GAMES");
    expect(line("ironman")).toContain("IRON_MAN_MIN_MATCHES");
    expect(line("mom-machine")).toContain("MOM_MACHINE_MIN_WINS");
    expect(line("above-field")).toContain("ABOVE_CURVE_MIN_RATED_GAMES");
    expect(src).toMatch(/myAvg >= MASTERCLASS_MIN_GAME_AVG/);
  });

  it("the thresholds are the ones the badges have always used", () => {
    expect([REGULAR_MIN_GAMES, IRON_MAN_MIN_MATCHES, MOM_MACHINE_MIN_WINS, MASTERCLASS_MIN_GAME_AVG, ABOVE_CURVE_MIN_RATED_GAMES]).toEqual([10, 3, 3, 9, 3]);
    expect(BADGE_NUMBERS).toMatchObject({
      regularMinGames: REGULAR_MIN_GAMES,
      ironManMinMatches: IRON_MAN_MIN_MATCHES,
      momMachineMinWins: MOM_MACHINE_MIN_WINS,
      masterclassMinGameAvg: MASTERCLASS_MIN_GAME_AVG,
      aboveCurveMinRatedGames: ABOVE_CURVE_MIN_RATED_GAMES,
      mrReliableMinGames: MR_RELIABLE_MIN_GAMES,
      mrReliableMinAvg: MR_RELIABLE_MIN_AVG,
      mrReliableMaxSpread: MR_RELIABLE_MAX_SPREAD,
    });
  });

  it("the Mr Reliable examples are true under the real rule", () => {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(earnsMrReliable({ perGameAverages: [...MR_RELIABLE_EXAMPLE_STEADY], avgRating: mean([...MR_RELIABLE_EXAMPLE_STEADY]) })).toBe(true);
    expect(earnsMrReliable({ perGameAverages: [...MR_RELIABLE_EXAMPLE_SWINGING], avgRating: mean([...MR_RELIABLE_EXAMPLE_SWINGING]) })).toBe(false);
    // Fails on the spread alone: its average clears the bar.
    expect(mean([...MR_RELIABLE_EXAMPLE_SWINGING])).toBeGreaterThanOrEqual(MR_RELIABLE_MIN_AVG);
  });
});

describe("resolveBadgeName", () => {
  it.each<[string, BadgeKey | null]>([
    ["Mr Reliable", "reliable"],
    ["mr reliable", "reliable"],
    ["MR RELIABLE", "reliable"],
    ["reliable", "reliable"],
    ["reliable", "reliable"],
    ["iron man", "ironman"],
    ["Ironman", "ironman"],
    ["IRON MAN", "ironman"],
    ["mom machine", "mom-machine"],
    ["MoM Machine", "mom-machine"],
    ["mom-machine", "mom-machine"],
    ["man of the match", "first-mom"],
    ["mom", "first-mom"],
    ["first-mom", "first-mom"],
    ["masterclass", "masterclass"],
    ["master class", "masterclass"],
    ["above the curve", "above-field"],
    ["curve", "above-field"],
    ["above-field", "above-field"],
    ["on the board", "first-game"],
    ["first game", "first-game"],
    ["regular", "ten-games"],
    ["ten games", "ten-games"],
    // Turkish
    ["güvenilir", "reliable"],
    ["demir adam", "ironman"],
    ["DEMİR ADAM", "ironman"],
    ["maçın adamı", "first-mom"],
    ["maçın adamı makinesi", "mom-machine"],
    ["ustalık", "masterclass"],
    ["ortalamanın üstünde", "above-field"],
    ["ilk maç", "first-game"],
    ["düzenli", "ten-games"],
    // not a badge
    ["golden boot", null],
    ["", null],
  ])("%s -> %s", (q, key) => {
    expect(resolveBadgeName(q)).toBe(key);
  });
});

describe("a badge question, as the extractor reads it", () => {
  it("the question extractor names a badge by its key: the two lists are the same", () => {
    expect([...HELP_BADGES]).toEqual(BADGES.map((b) => b.key));
  });

  it("the extractor's badge, given as its label, drills into that badge", () => {
    for (const b of BADGES) expect(group(b.label)).toContain(`${b.emoji} *${b.label}*`);
    expect(group("Mr Reliable")).not.toContain("Badges: how to earn them");
  });

  it("badge help never links to an admin page", () => {
    expect(helpPagesNeeded("badges", "admin")).toEqual([]);
    expect(helpPagesNeeded("badges", "group")).toEqual([]);
  });
});

describe("the badge list", () => {
  it("names every badge with its emoji, in one line each, with the real numbers", () => {
    const out = group();
    for (const b of BADGES) expect(out).toContain(`${b.emoji} *${b.label}*: `);
    expect(out).toContain(`${REGULAR_MIN_GAMES} or more games`);
    expect(out).toContain(`at least ${IRON_MAN_MIN_MATCHES}`);
    expect(out).toContain(`${MOM_MACHINE_MIN_WINS} or more times`);
    expect(out).toContain(`${MASTERCLASS_MIN_GAME_AVG} or more in a single game`);
    expect(out).toContain(`at least ${MR_RELIABLE_MIN_GAMES} games, average ${MR_RELIABLE_MIN_AVG} or more`);
    expect(out).toContain(`at least ${ABOVE_CURVE_MIN_RATED_GAMES} games`);
  });

  it("says badges come from all games at the club and which can be lost", () => {
    const out = group();
    expect(out).toMatch(/all .*games at this club/);
    expect(out).toMatch(/Iron Man, Mr Reliable and Above the Curve can be lost/);
  });

  it("shows how to drill down: tagged in the group, plain by DM", () => {
    expect(group()).toContain("*@Match Time help badges Mr Reliable*");
    expect(dm()).toContain("*help badges Mr Reliable*");
    expect(dm()).not.toContain("@Match Time help badges");
  });

  it("is listed in bare help even when every feature is off", () => {
    expect(buildHelpReply(null, MINIMAL)).toContain("*@Match Time help badges*");
    expect(buildHelpReply(null, ALL_ON, "tr")).toContain("*@Match Time yardım rozetler*");
  });

  it("Turkish: every badge, Turkish rules and decimal comma", () => {
    const out = group(undefined, "tr");
    for (const b of BADGES) expect(out).toContain(`${b.emoji} *${b.label}*: `);
    expect(out).toContain("6,5");
    expect(out).toContain("*@Match Time yardım rozetler Mr Reliable*");
    expect(dm(undefined, "tr")).toContain("*yardım rozetler Mr Reliable*");
  });

  it("carries no em or en dash, in either language or audience", () => {
    for (const lang of ["en", "tr"]) {
      for (const q of [undefined, "nonsense", ...KEYS]) {
        expect(group(q, lang)).not.toMatch(/[—–]/);
        expect(dm(q, lang)).not.toMatch(/[—–]/);
      }
    }
  });
});

describe("one badge's rules", () => {
  it("Mr Reliable says exactly what Kemal specified", () => {
    const out = group("Mr Reliable");
    expect(out).toContain("🧱 *Mr Reliable*");
    expect(out).toContain("1. Rated in at least 4 games.");
    expect(out).toContain("2. An average rating of 6.5 or more across all their ratings.");
    expect(out).toContain(
      "3. Steady from game to game: their game-by-game averages don't swing much. In numbers, the spread (standard deviation) is under 1 point. A player who scores 7, 7.5, 6.8, 7.2 qualifies. One who scores 9, 5, 8, 5.5 doesn't, even if the average is similar.",
    );
    expect(out).toMatch(/can be lost/);
    expect(out).toMatch(/all .*games at this club/);
    // Only that badge, not the list.
    expect(out).not.toContain("*Iron Man*");
  });

  it("Mr Reliable in Turkish", () => {
    const out = group("güvenilir", "tr");
    expect(out).toContain("🧱 *Mr Reliable*");
    expect(out).toContain("1. En az 4 maçta puan almış olmak.");
    expect(out).toContain("6,5");
    expect(out).toContain("7; 7,5; 6,8 ve 7,2");
    expect(out).toContain("9; 5; 8 ve 5,5");
  });

  it.each(KEYS)("%s has its own detail with the numbers its rule uses", (key) => {
    const b = BADGES.find((x) => x.key === key)!;
    for (const lang of ["en", "tr"]) {
      const out = group(b.label, lang);
      expect(out.startsWith(`${b.emoji} *${b.label}*`), out).toBe(true);
      for (const other of BADGES) if (other.key !== key) expect(out).not.toContain(`*${other.label}*`);
    }
    const out = group(b.label);
    const nums: Record<BadgeKey, number[]> = {
      "first-game": [],
      "ten-games": [REGULAR_MIN_GAMES],
      ironman: [IRON_MAN_MIN_MATCHES],
      "first-mom": [],
      "mom-machine": [MOM_MACHINE_MIN_WINS],
      masterclass: [MASTERCLASS_MIN_GAME_AVG],
      reliable: [MR_RELIABLE_MIN_GAMES, MR_RELIABLE_MIN_AVG, MR_RELIABLE_MAX_SPREAD],
      "above-field": [ABOVE_CURVE_MIN_RATED_GAMES],
    };
    for (const n of nums[key]) expect(out).toContain(String(n));
  });

  it("Iron Man: every match since joining AND a minimum number of matches; it does not come back", () => {
    const out = group("iron man");
    expect(out).toMatch(/every match at this club since joining/);
    expect(out).toContain(`At least ${IRON_MAN_MIN_MATCHES} matches`);
    expect(out).toMatch(/doesn't come back/);
  });

  it("Man of the Match and MoM Machine: a tie on the most votes is a win for everyone in it", () => {
    expect(group("man of the match")).toMatch(/tie on the most votes/);
    expect(group("mom machine")).toMatch(/tie on the most votes/);
  });

  it("Above the Curve: above the club average with enough rated games, and can be won back", () => {
    const out = group("above the curve");
    expect(out).toMatch(/higher than the club average/);
    expect(out).toContain(`Rated in at least ${ABOVE_CURVE_MIN_RATED_GAMES} games`);
    expect(out).toMatch(/comes back/);
  });

  it("an unknown name gets the list and the drill-down hint", () => {
    const out = group("golden boot");
    expect(out).toContain('"golden boot"');
    for (const b of BADGES) expect(out).toContain(`${b.emoji} *${b.label}*: `);
    expect(out).toContain("*@Match Time help badges Mr Reliable*");
    const outTr = group("altın ayakkabı", "tr");
    expect(outTr).toContain('"altın ayakkabı"');
    expect(outTr).toContain("*@Match Time yardım rozetler Mr Reliable*");
  });
});
