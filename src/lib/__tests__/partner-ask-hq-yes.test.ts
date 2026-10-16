/**
 * A partner club's ask in the asked club's admin group (cross-club ask,
 * slice S2, plan 3.3 step 4): the safe-YES rule approves ONLY the ask a
 * YES quotes, or the one MatchTime asked about last when the YES is the
 * next message within the window. A YES quoting the teams never posts an
 * ask, and a YES quoting the ask never approves the teams.
 */
import { describe, expect, it } from "vitest";
import { CONFIRM_WINDOW_MS, decideApproval, type PendingItem } from "../admin-group-confirm-rules";
import type { HqLogRow } from "../admin-group-log";
import { organisersContext } from "../admin-group-context";
import { parsePartnerAskRef, partnerAskRef } from "../partner-ask";

const T0 = new Date("2026-10-16T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const TEAMS: PendingItem = { ref: "teams:m1", kind: "teams" };
const ASK: PendingItem = { ref: partnerAskRef("ask1"), kind: "partner-ask" };
const ASK_TEXT = "🤝 *FNF* ask if one of your players can play for them: Fri 16 Oct, 20:30 at Goals Sutton (9-a-side, £8).";
const row = (over: Partial<HqLogRow>): HqLogRow => ({
  waMessageId: `mt:${Math.random()}`,
  fromMatchTime: true,
  senderUserId: null,
  text: "",
  askRef: null,
  createdAt: T0,
  ...over,
});
const log = [
  row({ text: "📋 Proposed teams for Fri 16 Oct", askRef: TEAMS.ref, createdAt: at(0) }),
  row({ text: ASK_TEXT, askRef: ASK.ref, createdAt: at(5) }),
];

describe("the safe YES and a partner club's ask", () => {
  it("the ref names the ask and reads back", () => {
    expect(partnerAskRef("ask1")).toBe("xask:ask1");
    expect(parsePartnerAskRef("xask:ask1")).toBe("ask1");
    expect(parsePartnerAskRef("teams:m1")).toBeNull();
  });

  it("a YES quoting the ask approves the ask, not the teams", () => {
    const d = decideApproval({ pending: [TEAMS, ASK], quoted: { fromMatchTime: true, text: ASK_TEXT }, log, now: at(30) });
    expect(d).toEqual({ kind: "approve", item: ASK, why: "quoted" });
  });

  it("a YES quoting the teams approves the teams, never the ask", () => {
    const d = decideApproval({ pending: [TEAMS, ASK], quoted: { fromMatchTime: true, text: "📋 Proposed teams for Fri 16 Oct" }, log, now: at(30) });
    expect(d).toEqual({ kind: "approve", item: TEAMS, why: "quoted" });
  });

  it("a bare YES right after the ask's question, within the window: the ask", () => {
    expect(decideApproval({ pending: [TEAMS, ASK], quoted: null, log, now: at(6) })).toEqual({ kind: "approve", item: ASK, why: "next-message" });
  });

  it("a bare YES after somebody else spoke, or too late: MatchTime asks which", () => {
    const busy = [...log, row({ fromMatchTime: false, text: "who's free friday?", createdAt: at(6) })];
    expect(decideApproval({ pending: [TEAMS, ASK], quoted: null, log: busy, now: at(7) })).toEqual({ kind: "ask-which", items: [TEAMS, ASK] });
    expect(decideApproval({ pending: [ASK], quoted: null, log, now: new Date(at(5).getTime() + CONFIRM_WINDOW_MS + 1) })).toEqual({ kind: "ask", item: ASK });
  });

  it("the router is told what is waiting, in a line of its own", () => {
    const lines = organisersContext({
      pending: [{ ...ASK, day: "Fri 16 Oct", club: "FNF", askedAt: at(5) }],
      quoted: null,
      quotedIsMatchTime: false,
      recent: [],
    });
    expect(lines[0]).toMatch(/^WAITING: YES to post FNF's ask for a player in the players' group, for Fri 16 Oct, asked at \d\d:\d\d\.$/);
  });
});
