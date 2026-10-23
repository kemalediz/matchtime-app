/**
 * WHICH CANCELLED MATCH A SQUAD ANSWER LEADS WITH (FNF, 2026-10-23).
 *
 * FNF's Friday 23 Oct game was cancelled on the 22nd. On the morning of
 * the 23rd "What's the list @Match Time" in HQ got the 30 Oct squad (18/18,
 * seeded by the rolling squad) with nothing to say which match it was, and
 * everyone read it as that night's. The squad answer now names its match,
 * and when this week's game is off it says so first. This file pins the
 * one pure decision: which cancelled match, if any, is "this week's".
 */
import { describe, it, expect } from "vitest";
import { cancelledMatchToMention } from "../cancelled-match-notice";

const H = 60 * 60 * 1000;
const d = (iso: string) => new Date(iso);

// The real FNF rows (UTC). 16 Oct played, 23 Oct cancelled, 30 Oct next.
const PLAYED_16 = { id: "m16", date: d("2026-10-16T18:30:00Z"), status: "COMPLETED" };
const CANCELLED_23 = { id: "m23", date: d("2026-10-23T18:30:00Z"), status: "CANCELLED" };
const NEXT_30 = { id: "m30", date: d("2026-10-30T20:30:00Z"), status: "UPCOMING" };
const FNF = [PLAYED_16, CANCELLED_23, NEXT_30];
const SHOWN = { id: NEXT_30.id, date: NEXT_30.date };

describe("cancelledMatchToMention", () => {
  it("the incident: asked at 09:51 UTC on the cancelled day, the cancelled match is named", () => {
    expect(cancelledMatchToMention(FNF, SHOWN, d("2026-10-23T09:51:00Z"))?.id).toBe("m23");
  });

  it("asked the day before, when it was cancelled, it is named", () => {
    expect(cancelledMatchToMention(FNF, SHOWN, d("2026-10-22T12:00:00Z"))?.id).toBe("m23");
  });

  it("asked the morning after, still named", () => {
    expect(cancelledMatchToMention(FNF, SHOWN, d("2026-10-24T09:00:00Z"))?.id).toBe("m23");
  });

  it("more than 48 hours after its kickoff, it is not mentioned any more", () => {
    expect(cancelledMatchToMention(FNF, SHOWN, d("2026-10-25T18:31:00Z"))).toBeNull();
  });

  it("a cancelled match from weeks ago is never mentioned", () => {
    const old = { id: "m02", date: d("2026-10-02T18:30:00Z"), status: "CANCELLED" };
    const rows = [old, { ...CANCELLED_23, status: "COMPLETED" }, NEXT_30];
    expect(cancelledMatchToMention(rows, SHOWN, d("2026-10-27T10:00:00Z"))).toBeNull();
  });

  it("a match played after the cancelled one means it is not this week's", () => {
    const tue = { id: "tue", date: d("2026-10-21T19:00:00Z"), status: "CANCELLED" };
    const thu = { id: "thu", date: d("2026-10-22T19:00:00Z"), status: "COMPLETED" };
    expect(cancelledMatchToMention([tue, thu, NEXT_30], SHOWN, d("2026-10-22T21:00:00Z"))).toBeNull();
  });

  it("a cancelled copy of the same night (a format switch) is not a cancelled week", () => {
    const ghost = { id: "ghost", date: d("2026-10-30T19:30:00Z"), status: "CANCELLED" };
    expect(cancelledMatchToMention([PLAYED_16, ghost, NEXT_30], SHOWN, d("2026-10-29T10:00:00Z"))).toBeNull();
  });

  it("a cancelled copy next to a played one on the same night is not mentioned, whichever is later", () => {
    const played = { id: "p", date: d("2026-10-23T18:30:00Z"), status: "TEAMS_PUBLISHED" };
    const ghost = { id: "g", date: d("2026-10-23T19:30:00Z"), status: "CANCELLED" };
    expect(cancelledMatchToMention([played, ghost, NEXT_30], SHOWN, d("2026-10-23T22:00:00Z"))).toBeNull();
  });

  it("no match shown: nothing to lead into, nothing mentioned", () => {
    expect(cancelledMatchToMention(FNF, null, d("2026-10-23T09:51:00Z"))).toBeNull();
  });

  it("a normal week: nothing cancelled, nothing mentioned", () => {
    const rows = [PLAYED_16, { ...CANCELLED_23, status: "COMPLETED" }, NEXT_30];
    expect(cancelledMatchToMention(rows, SHOWN, d("2026-10-24T09:00:00Z"))).toBeNull();
  });

  it("two cancelled in the window: the latest is named", () => {
    const a = { id: "a", date: d("2026-10-22T18:30:00Z"), status: "CANCELLED" };
    expect(cancelledMatchToMention([a, CANCELLED_23, NEXT_30], SHOWN, d("2026-10-23T09:00:00Z"))?.id).toBe("m23");
  });

  it("the window is exactly 48 hours after kickoff", () => {
    const at = new Date(CANCELLED_23.date.getTime() + 48 * H);
    expect(cancelledMatchToMention(FNF, SHOWN, at)?.id).toBe("m23");
    expect(cancelledMatchToMention(FNF, SHOWN, new Date(at.getTime() + 1))).toBeNull();
  });
});
