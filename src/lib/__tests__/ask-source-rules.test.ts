/**
 * Where the players come from when an organiser asks in HQ (Kemal,
 * 2026-10-28: "stricter"; ask when in limbo). Pure.
 */
import { describe, expect, it } from "vitest";
import {
  askSourceRef,
  decideRecruitSource,
  namedSource,
  parseAskSourceRef,
  sourceFromAnswer,
  sourceQuestionAnswered,
  type SourcesAvailable,
} from "../ask-source-rules";
import type { AdminFacts } from "../pipeline/types";
import type { HqLogRow } from "../admin-group-log";

const BOTH: SourcesAvailable = { partners: true, pool: true };
const PARTNERS_ONLY: SourcesAvailable = { partners: true, pool: false };
const POOL_ONLY: SourcesAvailable = { partners: false, pool: true };
const NEITHER: SourcesAvailable = { partners: false, pool: false };
const CLUBS: Array<[string, SourcesAvailable]> = [
  ["partners and the pool", BOTH],
  ["partners only", PARTNERS_ONLY],
  ["the pool only", POOL_ONLY],
  ["neither", NEITHER],
];

const pool = { pool: true as const };
const partners = { partnerClubs: true };
const unsaid = { sourceUnsaid: true as const };
const club = {};

describe("namedSource: what the words named", () => {
  it("the pool, the partners, the club's own players, or nothing", () => {
    expect(namedSource(pool)).toBe("pool");
    expect(namedSource(partners)).toBe("partners");
    expect(namedSource(club)).toBe("club");
    expect(namedSource(unsaid)).toBeNull();
  });
});

describe("decideRecruitSource: for every club shape", () => {
  it.each(CLUBS)("an explicit pool ask goes to the pool (%s): its own door says when it is not open", (_n, available) => {
    expect(decideRecruitSource(pool, available)).toEqual({ kind: "source", source: "pool" });
  });

  it.each(CLUBS)("an explicit partner ask goes to the partners (%s): their door says when there are none", (_n, available) => {
    expect(decideRecruitSource(partners, available)).toEqual({ kind: "source", source: "partners" });
  });

  it.each(CLUBS)("an ask to the club's own players stays the players' group (%s)", (_n, available) => {
    expect(decideRecruitSource(club, available)).toEqual({ kind: "source", source: "club" });
  });

  it("nowhere said, partners and the pool: ask, naming all three", () => {
    expect(decideRecruitSource(unsaid, BOTH)).toEqual({ kind: "ask-which", options: ["club", "partners", "pool"] });
  });

  it("nowhere said, partners only: ask, the group or the partners (never the pool)", () => {
    expect(decideRecruitSource(unsaid, PARTNERS_ONLY)).toEqual({ kind: "ask-which", options: ["club", "partners"] });
  });

  it("nowhere said, the pool only: ask, the group or the pool (never the partners)", () => {
    expect(decideRecruitSource(unsaid, POOL_ONLY)).toEqual({ kind: "ask-which", options: ["club", "pool"] });
  });

  it("nowhere said, neither: the players' group as before, nothing to ask", () => {
    expect(decideRecruitSource(unsaid, NEITHER)).toEqual({ kind: "source", source: "club" });
  });

  it("never the pool or the partners from words that did not name them", () => {
    for (const [, available] of CLUBS) {
      const d = decideRecruitSource(unsaid, available);
      expect(d).not.toEqual({ kind: "source", source: "pool" });
      expect(d).not.toEqual({ kind: "source", source: "partners" });
    }
  });
});

describe("the question's ref", () => {
  it("round-trips the options it offered", () => {
    expect(askSourceRef(["club", "partners", "pool"])).toBe("ask-source:club+partners+pool");
    expect(parseAskSourceRef("ask-source:club+pool")).toEqual(["club", "pool"]);
  });

  it("any other ref, or nothing it knows, is not this question", () => {
    expect(parseAskSourceRef("pool-ask:m1")).toBeNull();
    expect(parseAskSourceRef("ask-source:")).toBeNull();
    expect(parseAskSourceRef("ask-source:moon")).toBeNull();
    expect(parseAskSourceRef(null)).toBeNull();
  });
});

describe("sourceFromAnswer: the organiser's answer, as the model read it", () => {
  const admin = (f: Partial<AdminFacts>): AdminFacts => ({ kind: "admin", action: "recruit", ...f });
  it("a recruit naming a source is the answer", () => {
    expect(sourceFromAnswer(admin({ pool: true }))).toBe("pool");
    expect(sourceFromAnswer(admin({ partnerClubs: true }))).toBe("partners");
    expect(sourceFromAnswer(admin({}))).toBe("club");
  });

  it("still nowhere said, not a recruit, or nothing read: not an answer", () => {
    expect(sourceFromAnswer(admin({ sourceUnsaid: true }))).toBeNull();
    expect(sourceFromAnswer(admin({ action: "other" }))).toBeNull();
    expect(sourceFromAnswer(null)).toBeNull();
  });
});

describe("sourceQuestionAnswered: the safe-YES rule's positional tests on the question", () => {
  const ASKED = new Date("2026-10-28T09:00:00Z");
  const Q = "Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?";
  const mins = (m: number) => new Date(ASKED.getTime() + m * 60_000);
  const question = (at = ASKED, ref = "ask-source:club+partners+pool", id = "mt:ask-source:1"): HqLogRow => ({
    waMessageId: id,
    fromMatchTime: true,
    senderUserId: null,
    text: Q,
    askRef: ref,
    createdAt: at,
  });
  const said = (at: Date, text = "who has the bibs?"): HqLogRow => ({ waMessageId: `wa-${at.getTime()}`, fromMatchTime: false, senderUserId: "u-2", text, askRef: null, createdAt: at });
  const ask = (at: Date): HqLogRow => ({ ...said(at, "@Match Time we need 2 players"), waMessageId: "wa-ask" });

  it("the next message, within the window: the options offered", () => {
    expect(sourceQuestionAnswered({ quoted: null, log: [ask(ASKED), question()], now: mins(2) })).toEqual(["club", "partners", "pool"]);
  });

  it("somebody spoke in between: not in the place of an answer", () => {
    expect(sourceQuestionAnswered({ quoted: null, log: [question(), said(mins(1))], now: mins(2) })).toBeNull();
  });

  it("after the window: not an answer", () => {
    expect(sourceQuestionAnswered({ quoted: null, log: [question()], now: mins(16) })).toBeNull();
  });

  it("a newer MatchTime question (the teams) came after it: not an answer", () => {
    const teams: HqLogRow = { ...question(mins(1), "teams:m1", "mt:teams:1"), text: "📝 Proposed teams" };
    expect(sourceQuestionAnswered({ quoted: null, log: [question(), teams], now: mins(2) })).toBeNull();
  });

  it("a reply quoting the question, after other chat and past the window: the options", () => {
    const log = [question(), said(mins(5)), said(mins(30))];
    expect(sourceQuestionAnswered({ quoted: { messageId: "mt:ask-source:1", fromMatchTime: true, text: Q }, log, now: mins(40) })).toEqual(["club", "partners", "pool"]);
  });

  it("a reply quoting something else (another organiser, an older post): not an answer", () => {
    const log = [said(mins(-5), "anyone free Friday?"), question()];
    expect(sourceQuestionAnswered({ quoted: { messageId: `wa-${mins(-5).getTime()}`, text: "anyone free Friday?" }, log, now: mins(1) })).toBeNull();
  });

  it("no such question in the log: null", () => {
    expect(sourceQuestionAnswered({ quoted: null, log: [said(ASKED)], now: mins(1) })).toBeNull();
  });
});
