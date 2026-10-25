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

  it("asked the morning after, it is not mentioned any more (Kemal, 2026-10-25)", () => {
    expect(cancelledMatchToMention(FNF, SHOWN, d("2026-10-24T09:00:00Z"))).toBeNull();
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

  it("two cancelled still to come or today: the latest is named", () => {
    const a = { id: "a", date: d("2026-10-23T08:00:00Z"), status: "CANCELLED" };
    expect(cancelledMatchToMention([a, CANCELLED_23, NEXT_30], SHOWN, d("2026-10-23T07:00:00Z"))?.id).toBe("m23");
  });
});

// END OF ITS OWN LONDON DAY (Kemal, 2026-10-25). On Sun 25 Oct 08:04 the
// FNF HQ squad post for Fri 30 Oct still led with "The match on Fri 23 Oct
// is cancelled", because the old window ran 48 hours past kickoff. Kemal:
// "we passed 23rd now, remove this irrelevant line". A cancelled match is
// now mentioned up to the end of its own day in London, and never after.
describe("cancelledMatchToMention: only until the end of the cancelled match's own London day", () => {
  // Fri 23 Oct 20:30 BST and Fri 30 Oct 20:30 GMT, as FNF's rows are.
  const C23 = { id: "c23", date: d("2026-10-23T19:30:00Z"), status: "CANCELLED" };
  const N30 = { id: "n30", date: d("2026-10-30T20:30:00Z"), status: "UPCOMING" };
  const rows = [PLAYED_16, C23, N30];
  const shown = { id: N30.id, date: N30.date };

  it("on the day, at 08:00 London, it is mentioned", () => {
    expect(cancelledMatchToMention(rows, shown, d("2026-10-23T07:00:00Z"))?.id).toBe("c23");
  });

  it("on the day, at 23:30 London (after kickoff), it is mentioned", () => {
    expect(cancelledMatchToMention(rows, shown, d("2026-10-23T22:30:00Z"))?.id).toBe("c23");
  });

  it("the last minute of the day in London is still the day", () => {
    expect(cancelledMatchToMention(rows, shown, d("2026-10-23T22:59:59Z"))?.id).toBe("c23");
  });

  it("at 00:05 London the next day, it is not mentioned", () => {
    expect(cancelledMatchToMention(rows, shown, d("2026-10-23T23:05:00Z"))).toBeNull();
  });

  it("the incident: Sun 25 Oct 08:04 London, it is not mentioned", () => {
    expect(cancelledMatchToMention(rows, shown, d("2026-10-25T08:04:00Z"))).toBeNull();
  });

  it("a cancellation for a match later this week, still to come, is mentioned", () => {
    expect(cancelledMatchToMention(rows, shown, d("2026-10-20T12:00:00Z"))?.id).toBe("c23");
  });

  it("the clock-change night: cancelled Sat 24 Oct evening BST, checked Sun 25 Oct 00:30 GMT, not mentioned", () => {
    const sat = { id: "sat", date: d("2026-10-24T19:00:00Z"), status: "CANCELLED" };
    expect(cancelledMatchToMention([sat, N30], shown, d("2026-10-25T00:30:00Z"))).toBeNull();
    // 23:30 BST on the Saturday is still the Saturday.
    expect(cancelledMatchToMention([sat, N30], shown, d("2026-10-24T22:30:00Z"))?.id).toBe("sat");
  });

  it("the spring clock-change night: cancelled Sat 27 Mar evening GMT, 23:30 GMT is still the Saturday, 00:01 GMT on the Sunday is not", () => {
    const sat = { id: "sat", date: d("2027-03-27T19:00:00Z"), status: "CANCELLED" };
    const next = { id: "nx", date: d("2027-04-03T19:00:00Z"), status: "UPCOMING" };
    const sh = { id: next.id, date: next.date };
    expect(cancelledMatchToMention([sat, next], sh, d("2027-03-27T23:30:00Z"))?.id).toBe("sat");
    expect(cancelledMatchToMention([sat, next], sh, d("2027-03-28T00:01:00Z"))).toBeNull();
  });
});
