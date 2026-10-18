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

  // The count says the bench (FNF 2026-10-18). Where the organisers
  // announce the list, the players' group hears how many wait, not who.
  it("the count still answers, with the bench counted but not named", () => {
    const sp: SpeechIntent = { kind: "answer_count", messageId: "c", statedCount: null };
    const before = say(world({ confirmed: FOURTEEN, bench: ["erdal"] }), sp);
    const after = say(organisers(), sp);
    expect(before[0].text).toMatch(/, 1 on the bench \(.+\) ✅ full squad\.$/);
    expect(after).toEqual([{ ...before[0], text: before[0].text.replace(/ \(.+\) ✅/, " ✅") }]);
    expect(after[0].text).toMatch(/, 1 on the bench ✅ full squad\.$/);
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

// ── Rehearsal fixes (2026-10-14, PR #264's FNF rehearsal) ─────────────
//   A confirmed player's OUT used to post "X is out, 17 of 18 for Fri
//   20:30. One slot open, say *IN* to take it." in the players' group.
//   In organisers mode that line goes to the organisers instead
//   (`adminNotices`, sent on the admin channel by the analyze route), and
//   nothing else in the players' group carries a squad count.

function composed(state: SquadState, ...speech: SpeechIntent[]) {
  const result: EngineResult = { outcomes: [], writes: [], nextState: state, speech, degradations: [] };
  return compose(result);
}

const THIRTEEN = FOURTEEN.slice(0, 13);

describe("compose(): the organisers announce, a slot opens", () => {
  it("nothing in the players' group; one line for the organisers instead (EN)", () => {
    const out = composed(
      world({ confirmed: THIRTEEN, dropped: ["wasim"], features: { listAnnouncer: "organisers" } }),
      { kind: "slot_opened", messageId: "m1", outNames: ["Wasim Akhtar"] },
    );
    expect(out.utterances).toEqual([]);
    expect(out.adminNotices).toEqual([
      "📋 Wasim is out of Tue 21:30: 13 of 14 in, 1 place open. MatchTime has not posted this in the players' group.",
    ]);
  });

  it("several out, two places, Turkish", () => {
    const out = composed(
      world({ confirmed: FOURTEEN.slice(0, 12), dropped: ["zair", "wasim"], features: { language: "tr", listAnnouncer: "organisers" } }),
      { kind: "slot_opened", messageId: "m1", outNames: ["Wasim Akhtar", "Zair Malik"] },
    );
    expect(out.utterances).toEqual([]);
    expect(out.adminNotices).toEqual([
      "📋 Wasim ve Zair, Tue 21:30 maçından çıktı: 14 kişilik kadroda 12 kişi var, 2 yer boş. MatchTime bunu oyuncu grubunda paylaşmadı.",
    ]);
  });

  it("a slot opened with nobody out (a move to the bench) leads with the count", () => {
    const out = composed(world({ confirmed: THIRTEEN, bench: ["wasim"], features: { listAnnouncer: "organisers" } }), {
      kind: "slot_opened",
      messageId: "m1",
      outNames: [],
    });
    expect(out.adminNotices).toEqual([
      "📋 A place opened for Tue 21:30: 13 of 14 in, 1 place open. MatchTime has not posted this in the players' group.",
    ]);
  });

  it("an organiser-pick club: no 'say IN to go on the bench' in the players' group either", () => {
    const out = composed(
      world({ confirmed: THIRTEEN, dropped: ["wasim"], features: { listAnnouncer: "organisers", benchPickMode: "organiser" } }),
      { kind: "slot_opened", messageId: "m1", outNames: ["Wasim Akhtar"] },
    );
    expect(out.utterances).toEqual([]);
    expect(out.adminNotices).toHaveLength(1);
  });

  it("a bench claim that lost the race: thanked without the squad count", () => {
    const out = composed(world({ confirmed: FOURTEEN, bench: ["erdal"], features: { listAnnouncer: "organisers" } }), {
      kind: "bench_claim_too_late",
      messageId: "m1",
      userId: "u-erdal",
    });
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).not.toMatch(/\d+\s*\/\s*\d+|\d+ of \d+/);
    expect(out.utterances[0].text).toContain("someone got there first");
    const tr = composed(world({ confirmed: FOURTEEN, bench: ["erdal"], features: { language: "tr", listAnnouncer: "organisers" } }), {
      kind: "bench_claim_too_late",
      messageId: "m1",
      userId: "u-erdal",
    });
    expect(tr.utterances[0].text).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it("MatchTime announces: the slot line is in the players' group as before, nothing for the organisers", () => {
    const out = composed(world({ confirmed: THIRTEEN, dropped: ["wasim"] }), {
      kind: "slot_opened",
      messageId: "m1",
      outNames: ["Wasim Akhtar"],
    });
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toContain("One slot open");
    expect(out.adminNotices).toEqual([]);
  });
});
