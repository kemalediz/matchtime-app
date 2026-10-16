/**
 * The safe-YES rule in a club's admin group (Kemal, 2026-10-16): a YES
 * approves only what it is clearly about. Pure, no database, no model.
 */
import { describe, expect, it } from "vitest";
import { CONFIRM_WINDOW_MS, WHICH_ASK_REF, decideApproval, matchQuoted, type PendingItem } from "../admin-group-confirm-rules";
import type { HqLogRow } from "../admin-group-log";

const T0 = new Date("2026-10-16T09:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const TEAMS: PendingItem = { ref: "teams:m1", kind: "teams" };
const LIST: PendingItem = { ref: "list:wa-paste", kind: "list" };
const TEAMS_TEXT = "📝 *Proposed teams*: 20:00 at Goals Sutton\n\n*Red*:\n1. Ali Khan\n2. Bilal Ahmed";

const mt = (min: number, askRef: string, text = TEAMS_TEXT, confirm = false): HqLogRow => ({
  waMessageId: `mt:${confirm ? "ask:" : ""}${askRef}:${min}`,
  fromMatchTime: true,
  senderUserId: null,
  text,
  askRef,
  createdAt: at(min),
});
const org = (min: number, text = "who is bringing the bibs?"): HqLogRow => ({
  waMessageId: `wa-${min}`,
  fromMatchTime: false,
  senderUserId: "u-other",
  text,
  askRef: null,
  createdAt: at(min),
});

describe("a WhatsApp reply", () => {
  it("quoting MatchTime's teams proposal approves the teams, even hours later and after other chat", () => {
    const d = decideApproval({
      pending: [TEAMS],
      quoted: { fromMatchTime: true, text: TEAMS_TEXT },
      log: [mt(0, TEAMS.ref), org(5), org(30)],
      now: at(180),
    });
    expect(d).toEqual({ kind: "approve", item: TEAMS, why: "quoted" });
  });

  it("the quote is matched on MatchTime's own text even when the Pi could not tell whose it was", () => {
    const d = decideApproval({ pending: [TEAMS], quoted: { text: TEAMS_TEXT }, log: [mt(0, TEAMS.ref)], now: at(2) });
    expect(d).toMatchObject({ kind: "approve", why: "quoted" });
  });

  it("quoting another organiser: their conversation, nothing and no reply", () => {
    const d = decideApproval({ pending: [TEAMS], quoted: { fromMatchTime: false, text: "shall we start at 8?" }, log: [mt(0, TEAMS.ref)], now: at(1) });
    expect(d).toEqual({ kind: "silent", why: "reply-to-organiser" });
  });

  it("quoting MatchTime with nothing waiting: says so", () => {
    expect(decideApproval({ pending: [], quoted: { fromMatchTime: true, text: "Teams are final." }, log: [], now: at(1) })).toEqual({ kind: "nothing-waiting" });
  });

  it("quoting a MatchTime message that asked about nothing still waiting: asks", () => {
    const d = decideApproval({ pending: [TEAMS], quoted: { fromMatchTime: true, text: "🛠️ MatchTime in your admin group" }, log: [mt(0, TEAMS.ref)], now: at(1) });
    expect(d).toEqual({ kind: "ask", item: TEAMS });
  });

  it("with two waiting, the quote picks the one it quotes", () => {
    const listText = "Adding: Bilal. Removing: Shehryar. Reply YES to apply.";
    const d = decideApproval({
      pending: [TEAMS, LIST],
      quoted: { fromMatchTime: true, text: listText },
      log: [mt(0, TEAMS.ref), mt(3, LIST.ref, listText)],
      now: at(4),
    });
    expect(d).toEqual({ kind: "approve", item: LIST, why: "quoted" });
  });
});

describe("not a reply", () => {
  it("the next message after the question, within the window: approves", () => {
    expect(decideApproval({ pending: [TEAMS], quoted: null, log: [mt(0, TEAMS.ref)], now: at(14) })).toEqual({
      kind: "approve",
      item: TEAMS,
      why: "next-message",
    });
  });

  it("the message that caused the question (same instant) is not conversation in between", () => {
    expect(decideApproval({ pending: [TEAMS], quoted: null, log: [org(0, "swap Ali and Can"), mt(0, TEAMS.ref)], now: at(1) })).toMatchObject({ kind: "approve" });
  });

  it("after other conversation in between: asks once", () => {
    expect(decideApproval({ pending: [TEAMS], quoted: null, log: [mt(0, TEAMS.ref), org(2)], now: at(3) })).toEqual({ kind: "ask", item: TEAMS });
  });

  it("a stale proposal (asked more than the window ago, nothing since): asks", () => {
    const d = decideApproval({ pending: [TEAMS], quoted: null, log: [mt(0, TEAMS.ref)], now: new Date(at(0).getTime() + CONFIRM_WINDOW_MS + 1) });
    expect(d).toEqual({ kind: "ask", item: TEAMS });
  });

  it("a proposal from before the log (no question on record): asks", () => {
    expect(decideApproval({ pending: [TEAMS], quoted: null, log: [], now: at(1) })).toEqual({ kind: "ask", item: TEAMS });
  });

  it("the answer straight after MatchTime's 'Is that YES to the teams?' approves them", () => {
    const log = [mt(0, TEAMS.ref), org(2), mt(3, TEAMS.ref, "Is that YES to the proposed teams for Fri 16 Oct?", true)];
    expect(decideApproval({ pending: [TEAMS], quoted: null, log, now: at(4) })).toMatchObject({ kind: "approve", item: TEAMS });
  });

  it("asked once: another unclear YES within the window gets no second question", () => {
    const log = [mt(0, TEAMS.ref), org(2), mt(3, TEAMS.ref, "Is that YES to the proposed teams for Fri 16 Oct?", true), org(4)];
    expect(decideApproval({ pending: [TEAMS], quoted: null, log, now: at(5) })).toEqual({ kind: "silent", why: "asked-already" });
  });

  it("two items waiting and the YES is not clearly about either: asks which", () => {
    const log = [mt(0, TEAMS.ref), mt(1, LIST.ref, "Reply YES to apply."), org(2)];
    expect(decideApproval({ pending: [TEAMS, LIST], quoted: null, log, now: at(3) })).toEqual({ kind: "ask-which", items: [TEAMS, LIST] });
    const asked = [...log, mt(4, WHICH_ASK_REF, "Which one is that YES for?", true), org(5)];
    expect(decideApproval({ pending: [TEAMS, LIST], quoted: null, log: asked, now: at(6) })).toEqual({ kind: "silent", why: "asked-already" });
  });

  it("nothing waiting: silent (a yes between organisers)", () => {
    expect(decideApproval({ pending: [], quoted: null, log: [org(1)], now: at(2) })).toEqual({ kind: "silent", why: "nothing-waiting" });
  });

  it("the last question was about something no longer waiting: asks about what is", () => {
    expect(decideApproval({ pending: [LIST], quoted: null, log: [mt(0, TEAMS.ref)], now: at(1) })).toEqual({ kind: "ask", item: LIST });
  });
});

describe("matchQuoted", () => {
  it("matches MatchTime's own text whitespace-folded, never an organiser's", () => {
    const rows = [org(0, TEAMS_TEXT), mt(1, TEAMS.ref)];
    expect(matchQuoted(TEAMS_TEXT.replace(/\n/g, " \n "), rows)?.askRef).toBe(TEAMS.ref);
    expect(matchQuoted("Proposed", rows)).toBeNull();
    expect(matchQuoted("", rows)).toBeNull();
  });
});

describe("the window", () => {
  it("is 15 minutes", () => {
    expect(CONFIRM_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});
