/**
 * A FORMER MEMBER NAMED AGAIN (review of #574, round 3, B5).
 *
 * The engine's roster is the current members only, so who-is-who used to
 * be shown nobody else: "Oldham's back tonight" made a NEW Oldham beside
 * the old one. Now the engine paths show the club's former members too,
 * marked (former). A former member the model is SURE of, named in a claim
 * that brings someone in (IN or bench), is brought back: `returning`, which
 * the caller restores and adds to the roster before deciding. Named in any
 * other way ("Oldham's out"), he is still nobody in the club now: "none",
 * as before the change.
 */
import { describe, it, expect } from "vitest";
import { identifyFacts } from "@/lib/pipeline/identify-batch";
import type { PersonPicker, WhoRequest, PersonPick } from "@/lib/pipeline/who-is-who";
import { attendanceFacts, claim, member } from "./helpers";

const OLDHAM = { userId: "u-oldham", name: "Oldham Jones", isAdmin: false, hasPhone: true };

function picker(answer: Record<string, PersonPick>): { fn: PersonPicker; calls: WhoRequest[] } {
  const calls: WhoRequest[] = [];
  const fn: PersonPicker = async (req) => {
    calls.push(req);
    const picks = new Map<string, Map<string, PersonPick>>();
    for (const m of req.messages) picks.set(m.id, new Map(m.refs.map((r) => [r, answer[r] ?? { kind: "none" }])));
    return { picks, usage: null, degradations: [] };
  };
  return { fn, calls };
}

const named = (ref: string, polarity: "in" | "out" | "bench") =>
  claim({ subject: "other", personRef: ref, personNamed: true, personKind: "named", polarity });

describe("identifyFacts with former members", () => {
  it("shows the former members to the model, marked former", async () => {
    const p = picker({ Oldham: { kind: "member", userId: OLDHAM.userId } });
    await identifyFacts({
      picker: p.fn,
      roster: [member("tom")],
      former: [OLDHAM],
      items: [{ id: "m1", body: "Oldham's back tonight", author: "Tom", senderUserId: null, facts: attendanceFacts([named("Oldham", "in")]), mayBringBack: true }],
    });
    const shown = p.calls[0].roster.find((m) => m.userId === OLDHAM.userId);
    expect(shown).toMatchObject({ name: "Oldham Jones", former: true });
  });

  it("a SURE pick in an IN claim: he is returning, and the pick stands", async () => {
    const p = picker({ Oldham: { kind: "member", userId: OLDHAM.userId } });
    const res = await identifyFacts({
      picker: p.fn,
      roster: [member("tom")],
      former: [OLDHAM],
      items: [{ id: "m1", body: "Oldham's back tonight", author: "Tom", senderUserId: null, facts: attendanceFacts([named("Oldham", "in")]), mayBringBack: true }],
    });
    expect(res.returning.map((m) => m.userId)).toEqual([OLDHAM.userId]);
    expect(res.people.get("m1")?.get("Oldham")).toEqual({ kind: "member", userId: OLDHAM.userId });
  });

  it("named in by somebody who is no organiser: he is nobody in the club now (the friend link applies, as before)", async () => {
    const p = picker({ Oldham: { kind: "member", userId: OLDHAM.userId } });
    const res = await identifyFacts({
      picker: p.fn,
      roster: [],
      former: [OLDHAM],
      items: [{ id: "m1", body: "my friend Oldham is in", author: "Tom", senderUserId: null, facts: attendanceFacts([named("Oldham", "in")]) }],
    });
    expect(res.returning).toEqual([]);
    expect(res.people.get("m1")?.get("Oldham")).toEqual({ kind: "none" });
  });

  it("a hypothetical, future-tense or contingent claim brings nobody back", async () => {
    for (const over of [{ tense: "hypothetical" as const }, { tense: "future" as const }, { contingent: true, conditionOn: "squad" as const }]) {
      const p = picker({ Oldham: { kind: "member", userId: OLDHAM.userId } });
      const c = { ...named("Oldham", "in"), ...over };
      const res = await identifyFacts({
        picker: p.fn,
        roster: [],
        former: [OLDHAM],
        items: [{ id: "m1", body: "Oldham might come", author: "Tom", senderUserId: null, facts: attendanceFacts([c]), mayBringBack: true }],
      });
      expect(res.returning).toEqual([]);
    }
  });

  it("a bench claim brings him back too", async () => {
    const p = picker({ Oldham: { kind: "member", userId: OLDHAM.userId } });
    const res = await identifyFacts({
      picker: p.fn,
      roster: [],
      former: [OLDHAM],
      items: [{ id: "m1", body: "put Oldham on the bench", author: "Tom", senderUserId: null, facts: attendanceFacts([named("Oldham", "bench")]), mayBringBack: true }],
    });
    expect(res.returning.map((m) => m.userId)).toEqual([OLDHAM.userId]);
  });

  it("an OUT claim does not bring him back: he is nobody in the club now", async () => {
    const p = picker({ Oldham: { kind: "member", userId: OLDHAM.userId } });
    const res = await identifyFacts({
      picker: p.fn,
      roster: [],
      former: [OLDHAM],
      items: [{ id: "m1", body: "Oldham's out", author: "Tom", senderUserId: null, facts: attendanceFacts([named("Oldham", "out")]), mayBringBack: true }],
    });
    expect(res.returning).toEqual([]);
    expect(res.people.get("m1")?.get("Oldham")).toEqual({ kind: "none" });
  });

  it("an ambiguous pick naming a former member is left ambiguous, nobody brought back", async () => {
    const p = picker({ Oldham: { kind: "ambiguous", userIds: [OLDHAM.userId, "u-o2"] } });
    const res = await identifyFacts({
      picker: p.fn,
      roster: [],
      former: [OLDHAM],
      items: [{ id: "m1", body: "Oldham in", author: "Tom", senderUserId: null, facts: attendanceFacts([named("Oldham", "in")]), mayBringBack: true }],
    });
    expect(res.returning).toEqual([]);
    expect(res.people.get("m1")?.get("Oldham")?.kind).toBe("ambiguous");
  });

  it("no former list: nothing changes (returning is empty)", async () => {
    const p = picker({ Tom: { kind: "member", userId: "u-tom" } });
    const res = await identifyFacts({
      picker: p.fn,
      roster: [member("tom")],
      items: [{ id: "m1", body: "Tom in", author: "Ali", senderUserId: null, facts: attendanceFacts([named("Tom", "in")]) }],
    });
    expect(res.returning).toEqual([]);
    expect(p.calls[0].roster.some((m) => (m as { former?: boolean }).former)).toBe(false);
  });
});
