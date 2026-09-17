/**
 * THE ENGLISH COPY ONLY TELLS A GROUP TO TYPE WHAT THE BOT ACTS ON
 * (2026-09-17). The English twin of `tr-team-commands.test.ts`.
 *
 * The English group posts told players to type "generate teams",
 * "regenerate teams" and `swap X Y` with NO tag. A team command without
 * "@Match Time" is refused by the interaction contract, so a player who
 * did exactly what the bot said got silence. The Turkish copy was fixed
 * in PR #97; this pins the English to the same rule: every quoted team
 * command carries the tag, one form per action.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { en } from "../strings.en";
import { messageTagsBot } from "../../interaction-contract";
import { parseSwapNames } from "../../team-slot-swap";
import { looksLikeColourSwapPhrase } from "../../team-colour-swap";

const TAG = "@Match Time";
const C = {
  generate: "generate the teams",
  regenerate: "regenerate the teams",
  swapPlayers: "swap X with Y",
} as const;

describe("the English strings quote the chosen forms, tagged", () => {
  const cases: Array<[string, string, string]> = [
    ["match_day_locked_line", en.match_day_locked_line, C.generate],
    ["teams_not_generated", en.teams_not_generated, C.generate],
    ["swap_deferred", en.swap_deferred({ a: "Kemal Ediz", b: "Sait Demir" }), C.generate],
    ["swap_refused_teams_not_generated", en.swap_refused_teams_not_generated, C.generate],
    ["bench_claim_team", en.bench_claim_team({ claimer: "Erdal", dropped: "Sait", teamLabel: "Red" }), C.regenerate],
    ["intro_teams (generate)", en.intro_teams, C.generate],
    ["intro_teams (swap)", en.intro_teams, C.swapPlayers],
    ["teams_post_footer", en.teams_post_footer, C.swapPlayers],
    ["help: teams (generate)", en.onbHelpExplainer({ topic: "teams" }), C.generate],
  ];
  for (const [name, text, command] of cases) {
    it(`${name} says "${TAG} ${command}"`, () => {
      expect(text).toContain(`${TAG} ${command}`);
    });
  }

  it("no untagged or differently spelled team command is left in the English table", () => {
    const code = readFileSync(path.resolve(__dirname, "../strings.en.ts"), "utf8")
      .split("\n")
      .filter((line) => {
        const l = line.trim();
        return !(l.startsWith("//") || l.startsWith("*") || l.startsWith("/*"));
      })
      .join("\n");
    expect(code).not.toMatch(/swap X Y/);
    // "@MatchTime" is read as a tag too, but it is not the form the copy
    // settled on. Only team commands are held to it here; the reminder
    // line's "@MatchTime remind me" is out of this file's scope.
    expect(code).not.toMatch(/@MatchTime (?:re)?generate|@MatchTime swap/);
    // A quoted generate command must be the tagged one: the character
    // before it is the tag's trailing space, never a quote or a star.
    expect(code).not.toMatch(/["'*`](?:re)?generate (?:the )?teams/);
  });
});

describe("the bot reads the forms the English copy quotes", () => {
  const typed = (command: string) => `${TAG} ${command}`;

  for (const command of Object.values(C)) {
    it(`"${typed(command)}" tags the bot`, () => {
      expect(messageTagsBot({ body: typed(command) })).toBe(true);
    });
  }

  it("the player swap parses to the two names", () => {
    expect(parseSwapNames(typed(C.swapPlayers.replace("X", "David").replace("Y", "Ali")))).toEqual({
      a: "david",
      b: "ali",
    });
    expect(looksLikeColourSwapPhrase(typed("swap David with Ali"))).toBe(false);
  });

  for (const command of [C.generate, C.regenerate]) {
    it(`"${typed(command)}" is left for the router and the teams extractor`, () => {
      expect(looksLikeColourSwapPhrase(typed(command))).toBe(false);
      expect(parseSwapNames(typed(command))).toBeNull();
    });
  }
});
