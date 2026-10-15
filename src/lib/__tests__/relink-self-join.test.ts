/**
 * The one-off correction for FNF's request (2026-10-15): the PLAN, pure.
 * It moves a request only when the live rule would (`decideWeakLinkUpgrade`)
 * and MatchTime is known to be in the target group. The move itself is the
 * live path's `relinkToOrganiserGroup`, covered by group-add.test.ts and
 * e2e/api/self-join-community.spec.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { describeRelinkPlan, planRelinkSelfJoin, type RelinkArgs, type RelinkFacts } from "../relink-self-join";

const NOW = new Date("2026-10-15T20:00:00Z");
const mins = (m: number) => new Date(NOW.getTime() + m * 60_000);
const MAIN = "447700900001-1596025435@g.us";
const PARENT = "120363700000000101@g.us";
const ORGANISER = "447700900970";

const args = (over: Partial<RelinkArgs> = {}): RelinkArgs => ({
  connectId: "cc-fnf",
  groupId: MAIN,
  subject: "Friday Night Football 🏟",
  memberCount: 49,
  adderPhone: ORGANISER,
  adderLid: null,
  allowLate: false,
  ...over,
});

const facts = (over: Partial<RelinkFacts> = {}, req: Partial<NonNullable<RelinkFacts["request"]>> = {}): RelinkFacts => ({
  now: NOW,
  request: {
    id: "cc-fnf",
    code: "UYS5",
    status: "group_linked",
    groupId: PARENT,
    groupSubject: "FNF ⚽️",
    memberCount: 8,
    adderMatch: "other-organiser-present",
    botRemovedAt: null,
    phone: ORGANISER,
    dmLid: "156345466617992",
    issuedAt: mins(-120),
    linkedAt: mins(-90),
    org: { name: "FNF", approvalStatus: "pending" },
    ...req,
  },
  postStateObservedAt: mins(-90),
  unsolicitedAddedAt: null,
  owningClub: null,
  otherLinkedRequest: null,
  ...over,
});

describe("planRelinkSelfJoin", () => {
  it("THE FNF CORRECTION: parent group -> main chat, with the evidence named", () => {
    const plan = planRelinkSelfJoin(args(), facts());
    expect(plan).toMatchObject({
      ok: true,
      from: { groupId: PARENT, subject: "FNF ⚽️", memberCount: 8, adderMatch: "other-organiser-present" },
      to: { groupId: MAIN, subject: "Friday Night Football 🏟", memberCount: 49, adderMatch: "phone" },
      club: "FNF",
      code: "UYS5",
    });
    if (!plan.ok) throw new Error("refused");
    expect(plan.evidence).toContain("postability reading");
    expect(plan.ev).toEqual({ addedByPhone: ORGANISER, addedByLid: null, participants: [], discovered: false });
    const lines = describeRelinkPlan(plan, false);
    expect(lines[0]).toBe('DRY RUN (pass --apply to write): club "FNF" (ref UYS5)');
    expect(lines.join("\n")).toContain(`from: ${PARENT} "FNF ⚽️", 8 member(s), adderMatch=other-organiser-present`);
    expect(lines.join("\n")).toContain(`to:   ${MAIN} "Friday Night Football 🏟", 49 member(s), adderMatch=phone`);
  });

  it("refuses when nothing shows MatchTime is in the target group since the request was issued", () => {
    const stale = planRelinkSelfJoin(args(), facts({ postStateObservedAt: mins(-500) }));
    expect(stale).toMatchObject({ ok: false });
    expect(!stale.ok && stale.refusal).toContain("nothing shows MatchTime is in");
    expect(planRelinkSelfJoin(args(), facts({ postStateObservedAt: null })).ok).toBe(false);
    // A recorded add counts.
    expect(planRelinkSelfJoin(args(), facts({ postStateObservedAt: null, unsolicitedAddedAt: mins(-60) })).ok).toBe(true);
  });

  it("refuses for a club that is not pending", () => {
    for (const s of ["approved", "draft", "rejected"]) {
      const p = planRelinkSelfJoin(args(), facts({}, { org: { name: "FNF", approvalStatus: s } }));
      expect(p.ok).toBe(false);
    }
  });

  it("refuses a link the organiser made themselves, or a request not linked", () => {
    expect(planRelinkSelfJoin(args(), facts({}, { adderMatch: "phone" })).ok).toBe(false);
    expect(planRelinkSelfJoin(args(), facts({}, { status: "dm_verified", groupId: null })).ok).toBe(false);
    expect(planRelinkSelfJoin(args(), facts({}, { groupId: MAIN })).ok).toBe(false);
    expect(planRelinkSelfJoin(args(), facts({ request: null })).ok).toBe(false);
  });

  it("refuses an adder who is not the organiser", () => {
    const p = planRelinkSelfJoin(args({ adderPhone: "447700900999" }), facts());
    expect(!p.ok && p.refusal).toContain("not this request's organiser");
  });

  it("refuses a group a club owns, or one another request is linked to", () => {
    expect(planRelinkSelfJoin(args(), facts({ owningClub: "Sutton FC" })).ok).toBe(false);
    expect(planRelinkSelfJoin(args(), facts({ otherLinkedRequest: "cc-other" })).ok).toBe(false);
  });

  it("outside the window only with --allow-late", () => {
    const old = facts({ postStateObservedAt: mins(-26 * 60) }, { issuedAt: mins(-27 * 60), linkedAt: mins(-26 * 60) });
    const p = planRelinkSelfJoin(args(), old);
    expect(!p.ok && p.refusal).toContain("--allow-late");
    expect(planRelinkSelfJoin(args({ allowLate: true }), old).ok).toBe(true);
  });

  it("a refusal says nothing was written", () => {
    expect(describeRelinkPlan({ ok: false, refusal: "x" }, true)).toEqual(["REFUSED: x", "Nothing was written."]);
  });
});
