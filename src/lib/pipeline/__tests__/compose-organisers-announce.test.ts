/**
 * `compose()` for a club whose organisers announce the list and teams
 * (2026-10-14, list-announcer.ts). In the players' group:
 *
 *   an IN or OUT        the reaction only, no squad post;
 *   "who's playing?"    "The organisers will post the list." (EN, TR);
 *   "show the teams"    "The organisers will post the teams." (EN, TR);
 *   a replacement that inherited a slot on the sheet: no team post.
 *
 * And everything else (counts, stats, scores) is untouched, as is a club on
 * "matchtime".
 */
import { describe, it, expect } from "vitest";
import { compose } from "../compose";
import type { EngineResult, SpeechIntent, SquadState } from "../types";
import { world } from "./helpers";

const FOURTEEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "usama", "karahan", "zair", "wasim"];

function say(state: SquadState, ...speech: SpeechIntent[]) {
  const result: EngineResult = { outcomes: [], writes: [], nextState: state, speech, degradations: [] };
  return compose(result).utterances;
}

function organisers(lang: "en" | "tr" = "en", withTeams = false): SquadState {
  const teams: Record<string, "RED" | "YELLOW"> = {};
  if (withTeams) FOURTEEN.forEach((k, i) => (teams[k] = i % 2 === 0 ? "RED" : "YELLOW"));
  return world({ confirmed: FOURTEEN, bench: ["erdal"], teams, features: { language: lang, listAnnouncer: "organisers" } });
}

describe("compose(): the organisers announce", () => {
  it("an IN's squad post is not composed at all", () => {
    expect(say(organisers(), { kind: "squad_status", messageId: null })).toEqual([]);
  });

  it("who's playing, who's on the bench, is X playing: the organisers will post the list", () => {
    for (const sp of [
      { kind: "answer_squad", messageId: "q1" },
      { kind: "answer_bench", messageId: "q2" },
      { kind: "answer_person_status", messageId: "q3", personRef: "Sait", userId: null },
    ] as SpeechIntent[]) {
      expect(say(organisers(), sp)).toEqual([{ messageId: (sp as { messageId: string }).messageId, text: "The organisers will post the list." }]);
    }
    expect(say(organisers("tr"), { kind: "answer_squad", messageId: "q1" })[0].text).toBe("Listeyi organizatörler paylaşacak.");
  });

  it("show the teams, or no teams yet: the organisers will post the teams", () => {
    expect(say(organisers("en", true), { kind: "teams_post", messageId: "t1" })).toEqual([
      { messageId: "t1", text: "The organisers will post the teams." },
    ]);
    expect(say(organisers(), { kind: "teams_not_generated", messageId: "t2" })[0].text).toBe("The organisers will post the teams.");
    expect(say(organisers("tr", true), { kind: "teams_post", messageId: "t1" })[0].text).toBe("Takımları organizatörler paylaşacak.");
  });

  it("a replacement inheriting a slot posts no team sheet", () => {
    const out = say(organisers("en", true), {
      kind: "replacement_teams_post",
      messageId: "m1",
      swaps: [{ outName: "Wasim Akhtar", inName: "Erdal Ozkan", team: "YELLOW", outWentOut: true }],
    });
    expect(out).toEqual([]);
  });

  it("other answers are unchanged: the count", () => {
    const sp: SpeechIntent = { kind: "answer_count", messageId: "c", statedCount: null };
    const before = say(world({ confirmed: FOURTEEN, bench: ["erdal"] }), sp);
    expect(say(organisers(), sp)).toEqual(before);
  });
});

describe("compose(): MatchTime announces (default) is unchanged", () => {
  it("explicit 'matchtime' composes exactly what an absent setting does", () => {
    const speech: SpeechIntent[] = [
      { kind: "squad_status", messageId: null },
      { kind: "answer_squad", messageId: "q1" },
      { kind: "teams_post", messageId: "t1" },
    ];
    const teams: Record<string, "RED" | "YELLOW"> = {};
    FOURTEEN.forEach((k, i) => (teams[k] = i % 2 === 0 ? "RED" : "YELLOW"));
    const absent = say(world({ confirmed: FOURTEEN, teams }), ...speech);
    const explicit = say(world({ confirmed: FOURTEEN, teams, features: { listAnnouncer: "matchtime" } }), ...speech);
    expect(explicit).toEqual(absent);
    expect(absent).toHaveLength(3);
  });
});
