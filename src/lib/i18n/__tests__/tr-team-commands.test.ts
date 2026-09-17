/**
 * THE TURKISH COPY ONLY TELLS A GROUP TO TYPE WHAT THE BOT UNDERSTANDS.
 *
 * Before 2026-09-17 the Turkish posts quoted "takımları oluştur", the
 * help block quoted "takımları kur", and the swap line quoted the English
 * `swap X Y`. One form per action now, held in `TR_TEAM_COMMANDS`, and
 * this file pins two things:
 *
 *   1. every Turkish string that quotes a team command quotes THAT form,
 *      tagged, and no other form survives anywhere in the table;
 *   2. the deterministic half of the bot reads each form the way the copy
 *      promises: the tag is seen, the player swap parses to two names,
 *      the colour swap is recognised, and generate / show are left for
 *      the router and the teams extractor (which the live dry run
 *      measures: `TEAMS=1 ONLY=TT1,…` in `scripts/dryrun-pipeline.ts`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tr, TR_TEAM_COMMANDS as C } from "../strings.tr";
import { buildHowToUseMe } from "../../onboarding-conversation";
import { messageTagsBot } from "../../interaction-contract";
import { parseSwapNames } from "../../team-slot-swap";
import { looksLikeColourSwapPhrase } from "../../team-colour-swap";

const TAG = "@Match Time";
const ALL_ON = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: true,
};

describe("TR_TEAM_COMMANDS: one form per action", () => {
  it("is the chosen set", () => {
    expect(C).toEqual({
      generate: "takımları kur",
      regenerate: "takımları yeniden kur",
      show: "takımları göster",
      swapPlayers: "X ile Y'yi değiştir",
      swapPlayersExample: "Ali ile Can'ı değiştir",
      swapColours: "renkleri değiştir",
    });
  });
});

describe("the Turkish strings quote the chosen forms, tagged", () => {
  const cases: Array<[string, string, string]> = [
    ["match_day_locked_line", tr.match_day_locked_line, C.generate],
    ["teams_not_generated", tr.teams_not_generated, C.generate],
    ["swap_deferred", tr.swap_deferred({ a: "Kemal Ediz", b: "Sait Demir" }), C.generate],
    ["bench_claim_team", tr.bench_claim_team({ claimer: "Erdal", dropped: "Sait", teamLabel: "Kırmızı" }), C.regenerate],
    ["intro_teams (generate)", tr.intro_teams, C.generate],
    ["intro_teams (swap)", tr.intro_teams, C.swapPlayers],
    ["teams_post_footer", tr.teams_post_footer, C.swapPlayers],
    ["help: teams (generate)", tr.onbHelpExplainer({ topic: "teams" }), C.generate],
    ["help: teams (show)", tr.onbHelpExplainer({ topic: "teams" }), C.show],
    ["help: teams (swap)", tr.onbHelpExplainer({ topic: "teams" }), C.swapPlayersExample],
    ["help: teams (colours)", tr.onbHelpExplainer({ topic: "teams" }), C.swapColours],
  ];
  for (const [name, text, command] of cases) {
    it(`${name} says "${TAG} ${command}"`, () => {
      expect(text).toContain(`${TAG} ${command}`);
    });
  }

  it("the how-to block lists generate and show", () => {
    const block = buildHowToUseMe(ALL_ON, "tr");
    expect(block).toContain(`${C.generate} / ${C.show}`);
  });

  it("no other form of a team command is left in the Turkish table", () => {
    const code = readFileSync(path.resolve(__dirname, "../strings.tr.ts"), "utf8")
      .split("\n")
      .filter((line) => {
        const l = line.trim();
        return !(l.startsWith("//") || l.startsWith("*") || l.startsWith("/*"));
      })
      .join("\n");
    expect(code).not.toMatch(/oluştur/);
    expect(code).not.toMatch(/swap X Y/);
    expect(code).not.toMatch(/@MatchTime/);
  });
});

describe("the bot reads every form the copy quotes", () => {
  const typed = (command: string) => `${TAG} ${command}`;

  for (const command of Object.values(C)) {
    it(`"${typed(command)}" tags the bot`, () => {
      expect(messageTagsBot({ body: typed(command) })).toBe(true);
    });
  }

  it("the player swap parses to the two names, placeholder or example", () => {
    expect(parseSwapNames(typed(C.swapPlayersExample))).toEqual({ a: "ali", b: "can" });
    expect(parseSwapNames(typed(C.swapPlayers.replace("X", "David").replace("Y", "Ali")))).toEqual({
      a: "david",
      b: "ali",
    });
    expect(looksLikeColourSwapPhrase(typed(C.swapPlayersExample))).toBe(false);
  });

  it("the colour swap is the colour pre-peel's, never a player swap", () => {
    expect(looksLikeColourSwapPhrase(typed(C.swapColours))).toBe(true);
    expect(parseSwapNames(typed(C.swapColours))).toBeNull();
  });

  for (const command of [C.generate, C.regenerate, C.show]) {
    it(`"${typed(command)}" is left for the router and the teams extractor`, () => {
      expect(looksLikeColourSwapPhrase(typed(command))).toBe(false);
      expect(parseSwapNames(typed(command))).toBeNull();
    });
  }
});
