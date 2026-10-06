/**
 * Monthly squad, slice 3: the month opens and people sign up
 * (MDs/monthly-squad-plan-2026-10-05.md, sections 4.1 and 6.2). The pure
 * rules: when the list opens and when sign-up ends, who is carried over,
 * the fixed words of a sign-up message, what one person's choice writes,
 * and what a pasted sign-up list changes. No database, no model.
 */
import { describe, expect, it } from "vitest";
import { parseMonthlyList } from "@/lib/monthly-list";
import {
  WAITING_NOTE,
  buildSignupList,
  decideSignup,
  decideSignupListPost,
  firstKickoffOf,
  listOpenDue,
  listOpensAt,
  nextMonthStart,
  planCarryOver,
  readSignupMessage,
  reconcileSignupPaste,
  signupEndsAt,
  signupPasteShowsSameList,
  type SignupMember,
} from "@/lib/month-signup-rules";

const member = (o: Partial<SignupMember> & { userId: string }): SignupMember => ({
  name: o.userId,
  kind: "regular",
  slot: null,
  waiting: false,
  out: false,
  paid: "none",
  paygMatchIds: [],
  ...o,
});

describe("when the list opens", () => {
  it("November 2026 has five Mondays, and the first kicks off on the 2nd at 20:00 London", () => {
    expect(firstKickoffOf("2026-11-01", 1, "20:00")?.toISOString()).toBe("2026-11-02T20:00:00.000Z");
  });

  it("a month with no game on that weekday cannot happen, but a bad time gives null, not a throw", () => {
    expect(firstKickoffOf("2026-11-01", 1, "not a time")).toBeNull();
  });

  it("opens N days before the first game, at 10:00 London (BST the week before the clocks change)", () => {
    const first = firstKickoffOf("2026-11-01", 1, "20:00")!;
    // 7 days before Mon 2 Nov is Mon 26 Oct: GMT by then (clocks changed on the 25th).
    expect(listOpensAt(first, 7).toISOString()).toBe("2026-10-26T10:00:00.000Z");
    // 10 days before is Fri 23 Oct, still BST: 10:00 London is 09:00 UTC.
    expect(listOpensAt(first, 10).toISOString()).toBe("2026-10-23T09:00:00.000Z");
  });

  it("is due from 10:00 on that day, in waking hours, until the first game kicks off", () => {
    const first = firstKickoffOf("2026-11-01", 1, "20:00")!;
    const opensAt = listOpensAt(first, 7);
    const due = (iso: string) => listOpenDue({ now: new Date(iso), opensAt, firstKickoff: first });
    expect(due("2026-10-26T09:59:00.000Z")).toBe(false);
    expect(due("2026-10-26T10:00:00.000Z")).toBe(true);
    expect(due("2026-10-26T22:30:00.000Z")).toBe(false); // 22:30 London: tomorrow morning
    expect(due("2026-10-27T08:00:00.000Z")).toBe(true);
    expect(due("2026-11-02T20:00:00.000Z")).toBe(false); // the month has begun
  });

  it("the month after", () => {
    expect(nextMonthStart("2026-10-01")).toBe("2026-11-01");
    expect(nextMonthStart("2026-12-01")).toBe("2027-01-01");
  });
});

describe("when sign-up ends", () => {
  const first = new Date("2026-11-02T20:00:00.000Z");
  it("a day after the list opened", () => {
    expect(signupEndsAt(new Date("2026-10-26T10:00:00.000Z"), first).toISOString()).toBe("2026-10-27T10:00:00.000Z");
  });
  it("never later than a day before the first game", () => {
    expect(signupEndsAt(new Date("2026-11-01T10:00:00.000Z"), first).toISOString()).toBe("2026-11-01T20:00:00.000Z");
  });
  it("and never less than two hours after a list that opened late", () => {
    expect(signupEndsAt(new Date("2026-11-02T10:00:00.000Z"), first).toISOString()).toBe("2026-11-02T12:00:00.000Z");
  });
});

describe("carrying this month's regulars over", () => {
  const prev = [
    { userId: "bilal", kind: "regular", tier: "standard", slot: 2, left: false, here: true },
    { userId: "alex", kind: "regular", tier: "standard", slot: 1, left: false, here: true },
    { userId: "carl", kind: "regular", tier: "concession", slot: 5, left: false, here: true },
    { userId: "omar", kind: "payg", tier: "standard", slot: 6, left: false, here: true },
    { userId: "gone", kind: "regular", tier: "standard", slot: 3, left: false, here: false },
    { userId: "off", kind: "regular", tier: "standard", slot: 4, left: true, here: true },
  ];
  it("regulars only, in slot order, renumbered from 1, the tier kept", () => {
    expect(planCarryOver({ previous: prev, maxRegulars: 14 })).toEqual([
      { userId: "alex", tier: "standard", slot: 1, waiting: false },
      { userId: "bilal", tier: "standard", slot: 2, waiting: false },
      { userId: "carl", tier: "concession", slot: 3, waiting: false },
    ]);
  });
  it("PAYG players, people who left the group or were taken off the month are not carried", () => {
    const ids = planCarryOver({ previous: prev, maxRegulars: 14 }).map((r) => r.userId);
    expect(ids).not.toContain("omar");
    expect(ids).not.toContain("gone");
    expect(ids).not.toContain("off");
  });
  it("more regulars than places: the rest wait", () => {
    expect(planCarryOver({ previous: prev, maxRegulars: 2 })[2]).toEqual({ userId: "carl", tier: "concession", slot: null, waiting: true });
  });
  it("no month before this one: nobody", () => {
    expect(planCarryOver({ previous: [], maxRegulars: 14 })).toEqual([]);
  });
});

describe("the words of a sign-up message", () => {
  const plain = (text: string) => readSignupMessage(text, { quoted: false });
  const quoted = (text: string) => readSignupMessage(text, { quoted: true });

  it("English, naming the month", () => {
    expect(plain("IN FOR NOVEMBER")).toEqual({ choice: "in", month: 11, days: [] });
    expect(plain("I'm in for November")).toEqual({ choice: "in", month: 11, days: [] });
    expect(plain("count me in for nov!")).toEqual({ choice: "in", month: 11, days: [] });
    expect(plain("Out for November")).toEqual({ choice: "out", month: 11, days: [] });
    expect(plain("not in for November")).toEqual({ choice: "out", month: 11, days: [] });
    expect(plain("PAYG for November")).toEqual({ choice: "payg", month: 11, days: [] });
    expect(plain("PAYG November 9th and 23rd only")).toEqual({ choice: "payg", month: 11, days: [9, 23] });
    expect(plain("PAYG 9th, 23rd November")).toEqual({ choice: "payg", month: 11, days: [9, 23] });
  });

  it("Turkish, naming the month", () => {
    expect(plain("Kasım varım")).toEqual({ choice: "in", month: 11, days: [] });
    expect(plain("Kasım için varım")).toEqual({ choice: "in", month: 11, days: [] });
    expect(plain("Kasım'da yokum")).toEqual({ choice: "out", month: 11, days: [] });
    expect(plain("KASIM YOKUM")).toEqual({ choice: "out", month: 11, days: [] });
    expect(plain("Kasım PAYG 9 ve 23")).toEqual({ choice: "payg", month: 11, days: [9, 23] });
  });

  it("a plain IN is this week's game, never the month", () => {
    for (const t of ["IN", "in", "I'm in", "out", "varım", "yokum", "PAYG", "in for Monday", "in for the next one"]) {
      expect(plain(t), t).toBeNull();
    }
  });

  it("a sentence that only mentions the month is not a sign-up", () => {
    for (const t of [
      "who is in for November?",
      "I'm in for November if my knee holds up",
      "see you in November",
      "are we out for November lads",
      "November list is up",
      "in for November and December",
    ]) {
      expect(plain(t), t).toBeNull();
    }
  });

  it("as a reply to the list, the bare word is enough", () => {
    expect(quoted("IN")).toEqual({ choice: "in", month: null, days: [] });
    expect(quoted("I'm in 👍")).toEqual({ choice: "in", month: null, days: [] });
    expect(quoted("varım")).toEqual({ choice: "in", month: null, days: [] });
    expect(quoted("out")).toEqual({ choice: "out", month: null, days: [] });
    expect(quoted("yokum")).toEqual({ choice: "out", month: null, days: [] });
    expect(quoted("PAYG")).toEqual({ choice: "payg", month: null, days: [] });
    expect(quoted("PAYG 9th only")).toEqual({ choice: "payg", month: null, days: [9] });
    expect(quoted("in for November")).toEqual({ choice: "in", month: 11, days: [] });
  });

  it("a reply that is not one of the words is nothing", () => {
    for (const t of ["ok", "nice one", "in if I can", "what's the price?", "👍", ""]) expect(quoted(t), t).toBeNull();
  });
});

describe("what one person's choice writes", () => {
  const matches = [
    { matchId: "m2", day: 2 },
    { matchId: "m9", day: 9 },
    { matchId: "m16", day: 16 },
  ];
  const base = { maxRegulars: 3, matches };

  it("IN takes the lowest free number", () => {
    const others = [member({ userId: "a", slot: 1 }), member({ userId: "c", slot: 3 })];
    expect(decideSignup({ ...base, choice: "in", days: [], existing: null, others })).toEqual({
      kind: "write",
      outcome: "regular",
      row: { kind: "regular", slot: 2, waiting: false, out: false, paygMatchIds: [] },
      unknownDays: [],
    });
  });

  it("IN with every place taken waits, and is not a regular", () => {
    const others = [member({ userId: "a", slot: 1 }), member({ userId: "b", slot: 2 }), member({ userId: "c", slot: 3 })];
    expect(decideSignup({ ...base, choice: "in", days: [], existing: null, others })).toMatchObject({
      outcome: "waiting",
      row: { kind: "payg", slot: null, waiting: true },
    });
  });

  it("IN again changes nothing, for a regular and for somebody waiting", () => {
    expect(decideSignup({ ...base, choice: "in", days: [], existing: member({ userId: "a", slot: 1 }), others: [] })).toEqual({
      kind: "none",
      outcome: "regular",
    });
    const full = [member({ userId: "a", slot: 1 }), member({ userId: "b", slot: 2 }), member({ userId: "c", slot: 3 })];
    expect(
      decideSignup({ ...base, choice: "in", days: [], existing: member({ userId: "w", kind: "payg", waiting: true }), others: full }),
    ).toEqual({ kind: "none", outcome: "waiting" });
  });

  it("somebody who said OUT and comes back gets their old number while it is free", () => {
    const existing = member({ userId: "b", slot: 2, out: true });
    expect(decideSignup({ ...base, choice: "in", days: [], existing, others: [member({ userId: "a", slot: 1 })] })).toMatchObject({
      outcome: "regular",
      row: { kind: "regular", slot: 2, out: false },
    });
  });

  it("PAYG with dates names the games, and reports a date with no game", () => {
    expect(decideSignup({ ...base, choice: "payg", days: [9, 10], existing: null, others: [] })).toEqual({
      kind: "write",
      outcome: "payg",
      row: { kind: "payg", slot: null, waiting: false, out: false, paygMatchIds: ["m9"] },
      unknownDays: [10],
    });
  });

  it("a regular who switches to PAYG gives the number back", () => {
    expect(decideSignup({ ...base, choice: "payg", days: [], existing: member({ userId: "a", slot: 1 }), others: [] })).toMatchObject({
      outcome: "payg",
      row: { kind: "payg", slot: null },
    });
  });

  it("OUT takes a member off; OUT from somebody who was never on it writes nothing", () => {
    expect(decideSignup({ ...base, choice: "out", days: [], existing: member({ userId: "a", slot: 1 }), others: [] })).toMatchObject({
      outcome: "out",
      row: { out: true, slot: 1 },
    });
    expect(decideSignup({ ...base, choice: "out", days: [], existing: null, others: [] })).toEqual({ kind: "none", outcome: "out" });
  });

  it("somebody who says they have paid is not moved by a message: that is the organiser's", () => {
    for (const paid of ["claimed", "confirmed"] as const) {
      const existing = member({ userId: "a", slot: 1, paid });
      expect(decideSignup({ ...base, choice: "out", days: [], existing, others: [] })).toEqual({ kind: "locked", outcome: "regular" });
      expect(decideSignup({ ...base, choice: "payg", days: [], existing, others: [] })).toEqual({ kind: "locked", outcome: "regular" });
      // Saying IN again is still nothing.
      expect(decideSignup({ ...base, choice: "in", days: [], existing, others: [] })).toEqual({ kind: "none", outcome: "regular" });
    }
  });

  it("an organiser's own change may go past the cap and past a paid mark", () => {
    const full = [member({ userId: "a", slot: 1 }), member({ userId: "b", slot: 2 }), member({ userId: "c", slot: 3 })];
    expect(
      decideSignup({ ...base, choice: "in", days: [], existing: member({ userId: "w", kind: "payg", waiting: true }), others: full, byOrganiser: true }),
    ).toMatchObject({ outcome: "regular", row: { kind: "regular", slot: 4, waiting: false } });
    expect(
      decideSignup({ ...base, choice: "out", days: [], existing: member({ userId: "a", slot: 1, paid: "confirmed" }), others: [], byOrganiser: true }),
    ).toMatchObject({ outcome: "out" });
  });
});

describe("a pasted sign-up list", () => {
  const roster = [
    { userId: "alex", name: "Alex Carter" },
    { userId: "bilal", name: "Bilal Aydin" },
    { userId: "chris", name: "Chris Bell" },
    { userId: "dan", name: "Dan Price", aliases: ["Danny"] },
    { userId: "omar", name: "Omar Khan" },
    { userId: "omar2", name: "Omar Aziz" },
  ];
  const members = [member({ userId: "alex", name: "Alex Carter", slot: 1 }), member({ userId: "bilal", name: "Bilal Aydin", slot: 2 })];
  const run = (body: string, o: Partial<Parameters<typeof reconcileSignupPaste>[0]> = {}) =>
    reconcileSignupPaste({
      list: parseMonthlyList(body)!,
      members,
      roster,
      monthNumber: 11,
      senderUserId: "dan",
      senderNames: ["Dan Price", "Dan"],
      ...o,
    });

  it("the sender adds themselves: a regular", () => {
    const out = run("List for November\n1. Alex\n2. Bilal\n3. Dan");
    expect(out.thisList).toBe(true);
    expect(out.self).toEqual({ choice: "in", days: [] });
    expect(out.notAdded).toEqual([]);
  });

  it("with (PAYG) and dates: PAYG on those dates", () => {
    expect(run("List for November\n1. Alex\n2. Bilal\n3. Dan (PAYG 9th only)").self).toEqual({ choice: "payg", days: [9] });
  });

  it("under a known alias", () => {
    expect(run("List for November\n1. Alex\n2. Bilal\n3. Danny").self).toEqual({ choice: "in", days: [] });
  });

  it("under a name we do not have, when it is the one unknown line and carries their first name", () => {
    expect(run("List for November\n1. Alex\n2. Bilal\n3. Big Dan").self).toEqual({ choice: "in", days: [] });
  });

  it("NEVER adds anybody else: a club player written in by somebody else is reported, not added", () => {
    const out = run("List for November\n1. Alex\n2. Bilal\n3. Chris\n4. Dan");
    expect(out.self).toEqual({ choice: "in", days: [] });
    expect(out.notAdded).toEqual([{ name: "Chris", reason: "not-the-sender" }]);
  });

  it("NEVER creates a player: a name nobody has, and a name two players have", () => {
    const out = run("List for November\n1. Alex\n2. Bilal\n3. Bibs\n4. Omar\n5. Two balls", { senderUserId: "alex", senderNames: ["Alex Carter"] });
    expect(out.self).toBeNull();
    expect(out.notAdded).toEqual([
      { name: "Bibs", reason: "unknown" },
      { name: "Omar", reason: "ambiguous" },
      { name: "Two balls", reason: "unknown" },
    ]);
  });

  it("a paste that only restates the list changes nothing", () => {
    const out = run("List for November\n1. Alex\n2. Bilal", { senderUserId: "alex", senderNames: ["Alex Carter"] });
    expect(out).toMatchObject({ thisList: true, self: null, notAdded: [], paidClaims: [] });
  });

  it("an old copy never takes anybody off: a missing name changes nothing", () => {
    const out = run("List for November\n1. Alex\n2. Dan");
    expect(out.self).toEqual({ choice: "in", days: [] });
    // Bilal is simply not on this copy.
    expect(out.notAdded).toEqual([]);
  });

  it("the sender blanking their own line, and being nowhere else on it, is OUT", () => {
    const out = run("List for November\n1. Alex\n2.\n3.", { senderUserId: "bilal", senderNames: ["Bilal Aydin"] });
    expect(out.self).toEqual({ choice: "out", days: [] });
  });

  it("somebody else's blanked line is left alone", () => {
    const out = run("List for November\n1. Alex\n2.\n3.", { senderUserId: "alex", senderNames: ["Alex Carter"] });
    expect(out.self).toBeNull();
  });

  it("another month's header is not this list", () => {
    expect(run("List for December\n1. Alex\n2. Bilal\n3. Dan").thisList).toBe(false);
  });

  it("no header: only with 60% of its names on the month's list", () => {
    expect(run("1. Alex\n2. Bilal\n3. Dan\n4.").thisList).toBe(true); // 2 of 3
    expect(run("Kit for Monday\n1. Bibs\n2. Two balls\n3. Pump\n4. Alex").thisList).toBe(false);
    // With `needHeader` (a week's list is live for this club) a headerless list is never the sign-up list.
    expect(run("1. Alex\n2. Bilal\n3. Dan\n4.", { needHeader: true }).thisList).toBe(false);
  });

  it("a paid mark is a claim on a regular's line, whoever wrote it, and never on a PAYG line", () => {
    const out = run("List for November\n1. Alex (paid £37.50)\n2. Bilal paid\n3. Dan (PAYG) paid");
    expect(out.paidClaims).toEqual([
      { userId: "alex", name: "Alex", self: false, amountPence: 3750 },
      { userId: "bilal", name: "Bilal", self: false, amountPence: null },
    ]);
  });

  it("a paid mark on a line that already says paid is not a new claim", () => {
    const paid = [member({ userId: "alex", name: "Alex Carter", slot: 1, paid: "claimed" }), members[1]];
    expect(run("List for November\n1. Alex (paid)\n2. Bilal", { members: paid }).paidClaims).toEqual([]);
  });
});

describe("the sign-up list", () => {
  const members = [
    member({ userId: "alex", name: "Alex Carter", slot: 1, paid: "claimed" }),
    member({ userId: "chris", name: "Chris Bell", slot: 3 }),
    member({ userId: "omar", name: "Omar Khan", kind: "payg", paygMatchIds: ["m9"] }),
    member({ userId: "eve", name: "Eve Stone", kind: "payg", waiting: true }),
    member({ userId: "gone", name: "Gone Away", slot: 2, out: true }),
  ];
  const matches = [
    { matchId: "m2", day: 2 },
    { matchId: "m9", day: 9 },
  ];

  it("numbered places up to the cap, blanks kept, then PAYG, then who is waiting", () => {
    const list = buildSignupList({ members, maxRegulars: 4, matches });
    expect(list.slots).toEqual([
      { slot: 1, userId: "alex", name: "Alex Carter", paid: true },
      { slot: 2, userId: null, name: "", paid: false },
      { slot: 3, userId: "chris", name: "Chris Bell", paid: false },
      { slot: 4, userId: null, name: "", paid: false },
    ]);
    expect(list.payg).toEqual([{ slot: 5, userId: "omar", name: "Omar Khan", days: [9] }]);
    expect(list.waiting).toEqual([{ userId: "eve", name: "Eve Stone" }]);
    expect(list.regulars).toBe(2);
  });

  it("a regular with no number, or a number somebody else holds, is still on the list", () => {
    const list = buildSignupList({
      members: [
        member({ userId: "alex", name: "Alex Carter", slot: 1 }),
        member({ userId: "back", name: "Back Again", slot: null }),
        member({ userId: "twin", name: "Twin Number", slot: 1 }),
      ],
      maxRegulars: 4,
      matches,
    });
    expect(list.slots.map((s) => s.userId)).toEqual(["alex", "back", "twin", null]);
    expect(list.regulars).toBe(3);
  });

  it("the waiting note is one constant", () => {
    expect(WAITING_NOTE).toBe("waiting for a regular place");
  });

  it("a paste that shows the same people in the same places is the same list", () => {
    const roster = members.map((m) => ({ userId: m.userId, name: m.name }));
    const list = buildSignupList({ members, maxRegulars: 4, matches });
    const same = parseMonthlyList("List for November\n1. Alex\n2.\n3. Chris\n4.\n5. Omar (PAYG 9th)")!;
    const moved = parseMonthlyList("List for November\n1. Alex\n2. Chris\n3.\n4.\n5. Omar (PAYG 9th)")!;
    const fewer = parseMonthlyList("List for November\n1. Alex\n2.\n3. Chris")!;
    expect(signupPasteShowsSameList({ list: same, ours: list, roster })).toBe(true);
    expect(signupPasteShowsSameList({ list: moved, ours: list, roster })).toBe(false);
    expect(signupPasteShowsSameList({ list: fewer, ours: list, roster })).toBe(false);
  });
});

describe("when the sign-up list is posted", () => {
  const endsAt = new Date("2026-10-27T10:00:00.000Z");
  const base = { open: true, endsAt, hash: "b", lastShownHash: "a", lastPostAt: null };
  const at = (iso: string) => new Date(iso);

  it("the first post: the group has seen none", () => {
    expect(decideSignupListPost({ ...base, now: at("2026-10-26T10:01:00.000Z"), lastShownHash: null })).toBe(true);
  });
  it("nothing changed: nothing is posted", () => {
    expect(decideSignupListPost({ ...base, now: at("2026-10-26T12:00:00.000Z"), lastShownHash: "b" })).toBe(false);
  });
  it("a change is posted, but never within 30 minutes of the last list post", () => {
    const last = at("2026-10-26T12:00:00.000Z");
    expect(decideSignupListPost({ ...base, now: at("2026-10-26T12:29:00.000Z"), lastPostAt: last })).toBe(false);
    expect(decideSignupListPost({ ...base, now: at("2026-10-26T12:30:00.000Z"), lastPostAt: last })).toBe(true);
  });
  it("never between 22:00 and 07:59 London", () => {
    expect(decideSignupListPost({ ...base, now: at("2026-10-26T22:00:00.000Z") })).toBe(false);
    expect(decideSignupListPost({ ...base, now: at("2026-10-27T07:59:00.000Z") })).toBe(false);
    expect(decideSignupListPost({ ...base, now: at("2026-10-27T08:00:00.000Z") })).toBe(true);
  });
  it("never once sign-up has ended, or for a month that is not in sign-up", () => {
    expect(decideSignupListPost({ ...base, now: at("2026-10-27T10:00:00.000Z") })).toBe(false);
    expect(decideSignupListPost({ ...base, open: false, now: at("2026-10-26T12:00:00.000Z") })).toBe(false);
  });
});
