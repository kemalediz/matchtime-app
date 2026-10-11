/**
 * RELINK AFTER A RE-ADD (2026-10-11): the PURE rule.
 *
 * The organiser removed MatchTime from the group while the club waited for
 * approval, then added it straight back without sending a new code. The
 * rule decides whether that add links the SAME request again. No database,
 * no clock but the one passed in, no model.
 */
import { describe, expect, it } from "vitest";
import { ADD_WINDOW_MS } from "../connect-dm-rules";
import {
  RELINK_AFTER_REMOVAL_MS,
  decideGroupAddLink,
  decideRelinkAfterReAdd,
  relinkRefIds,
  type AddEvidence,
  type RelinkCandidate,
} from "../group-add-rules";

const NOW = new Date("2026-10-11T12:00:00Z");
const mins = (m: number) => new Date(NOW.getTime() + m * 60_000);

const GROUP = "120363400000000001@g.us";
const OTHER_GROUP = "120363400000000002@g.us";
const ALI = "447700900123";
const ALI_LID = "158055467598961";
const STRANGER = "447700900999";
const STRANGER_LID = "158055467598999";

function row(over: Partial<RelinkCandidate> = {}): RelinkCandidate {
  return {
    id: "cc-ali",
    groupId: GROUP,
    status: "group_linked",
    botRemovedAt: mins(-5),
    phone: ALI,
    dmLid: ALI_LID,
    orgApprovalStatus: "draft",
    newerRequestExists: false,
    ...over,
  };
}

const ev = (over: Partial<AddEvidence> = {}): AddEvidence => ({
  addedByPhone: ALI,
  addedByLid: null,
  participants: [{ phone: ALI, lid: null }],
  discovered: false,
  ...over,
});

const decide = (e: AddEvidence, rows: RelinkCandidate[], now: Date = NOW) => decideRelinkAfterReAdd(e, GROUP, rows, now);

describe("the window", () => {
  it("is 24 hours from the removal, the same length as the add window after the connect DM", () => {
    expect(RELINK_AFTER_REMOVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(RELINK_AFTER_REMOVAL_MS).toBe(ADD_WINDOW_MS);
  });
});

describe("the organiser adds MatchTime back to the same group", () => {
  it("matched by phone: the same request is linked again", () => {
    const removedAt = mins(-5);
    expect(decide(ev(), [row({ botRemovedAt: removedAt })])).toEqual({
      relink: true,
      connectId: "cc-ali",
      adderMatch: "phone",
      removedAt,
    });
  });

  it("matched by the LID the connect DM came from, when the add carried no phone", () => {
    expect(decide(ev({ addedByPhone: null, addedByLid: ALI_LID }), [row()])).toMatchObject({
      relink: true,
      adderMatch: "lid",
    });
  });

  it("the phone wins over the LID when both match", () => {
    expect(decide(ev({ addedByLid: ALI_LID }), [row()])).toMatchObject({ relink: true, adderMatch: "phone" });
  });

  it("just inside the window relinks; exactly at the limit and after it do not", () => {
    const removedAt = mins(-60);
    const at = (ms: number) => new Date(removedAt.getTime() + ms);
    expect(decide(ev(), [row({ botRemovedAt: removedAt })], at(RELINK_AFTER_REMOVAL_MS - 1))).toMatchObject({ relink: true });
    expect(decide(ev(), [row({ botRemovedAt: removedAt })], at(RELINK_AFTER_REMOVAL_MS))).toEqual({
      relink: false,
      reason: "outside-window",
    });
    expect(decide(ev(), [row({ botRemovedAt: removedAt })], at(RELINK_AFTER_REMOVAL_MS + 60_000))).toEqual({
      relink: false,
      reason: "outside-window",
    });
  });
});

describe("the adder must be the organiser, proven as a matched add proves it", () => {
  it("someone else's phone: no relink, even with the organiser in the group", () => {
    expect(decide(ev({ addedByPhone: STRANGER }), [row()])).toEqual({ relink: false, reason: "adder-not-organiser" });
  });

  it("someone else's LID: no relink", () => {
    expect(decide(ev({ addedByPhone: null, addedByLid: STRANGER_LID }), [row()])).toEqual({
      relink: false,
      reason: "adder-not-organiser",
    });
  });

  it("the organiser's LID was never recorded (no connect DM bound one): a LID-only add proves nothing", () => {
    expect(decide(ev({ addedByPhone: null, addedByLid: ALI_LID }), [row({ dmLid: null })])).toEqual({
      relink: false,
      reason: "adder-not-organiser",
    });
  });

  it("no adder at all (WhatsApp did not say): no relink, organiser present or not", () => {
    expect(decide(ev({ addedByPhone: null, addedByLid: null }), [row()])).toEqual({
      relink: false,
      reason: "adder-not-organiser",
    });
  });

  it("found by the reconnect sweep: it carries no adder, so it never relinks", () => {
    expect(decide(ev({ discovered: true }), [row()])).toEqual({ relink: false, reason: "adder-not-organiser" });
  });
});

describe("only a link that was removed from THIS group", () => {
  it("a different group: no relink", () => {
    expect(decide(ev(), [row({ groupId: OTHER_GROUP })])).toEqual({ relink: false, reason: "no-removed-link" });
  });

  it("no rows at all: no relink", () => {
    expect(decide(ev(), [])).toEqual({ relink: false, reason: "no-removed-link" });
  });

  it("not removed (already linked again, or a duplicate of the add that relinked it): no relink", () => {
    expect(decide(ev(), [row({ botRemovedAt: null })])).toEqual({ relink: false, reason: "no-removed-link" });
  });

  it.each(["issued", "dm_verified", "expired", "superseded", "closed"])("a request that is %s: no relink", (status) => {
    expect(decide(ev(), [row({ status })])).toEqual({ relink: false, reason: "no-removed-link" });
  });
});

describe("only while the club is still a draft", () => {
  it.each(["pending", "approved", "rejected", "suspended"])("a %s club: no relink", (orgApprovalStatus) => {
    expect(decide(ev(), [row({ orgApprovalStatus })])).toEqual({ relink: false, reason: "club-not-draft" });
  });
});

describe("a newer connect request owns the club", () => {
  it("the organiser started a new request since: the code flow decides, never the relink", () => {
    expect(decide(ev(), [row({ newerRequestExists: true })])).toEqual({ relink: false, reason: "newer-request" });
  });

  it("an open request that matches the add is linked by the normal rule (which runs first)", () => {
    const open = {
      id: "cc-new",
      status: "dm_verified",
      phone: ALI,
      dmLid: ALI_LID,
      issuedAt: mins(-2),
      expiresAt: mins(58),
      addWindowEndsAt: mins(24 * 60 - 1),
    };
    expect(decideGroupAddLink(ev(), [open], NOW)).toMatchObject({ link: true, connectId: "cc-new", adderMatch: "phone" });
  });
});

describe("several removed links name this group", () => {
  it("only the one removed most recently is considered", () => {
    const older = row({ id: "cc-old", botRemovedAt: mins(-120) });
    const newer = row({ id: "cc-new", botRemovedAt: mins(-10) });
    expect(decide(ev(), [older, newer])).toMatchObject({ relink: true, connectId: "cc-new" });
  });

  it("the most recent belongs to another organiser: the older one is NOT revived", () => {
    const mine = row({ id: "cc-ali", botRemovedAt: mins(-120) });
    const theirs = row({ id: "cc-other", botRemovedAt: mins(-10), phone: STRANGER, dmLid: STRANGER_LID });
    expect(decide(ev(), [mine, theirs])).toEqual({ relink: false, reason: "adder-not-organiser" });
  });
});

describe("the dedupe keys of a relink", () => {
  it("differ from the first link's, and from one removal to the next", () => {
    const a = relinkRefIds("cc-ali", new Date("2026-10-11T11:55:00.000Z"));
    const b = relinkRefIds("cc-ali", new Date("2026-10-11T13:10:00.000Z"));
    expect(a).toEqual({
      ownerDm: "cc-ali:relink:2026-10-11T11:55:00.000Z",
      organiserAck: "cc-ali:in-group:relink:2026-10-11T11:55:00.000Z",
    });
    expect(a.ownerDm).not.toBe("cc-ali");
    expect(a.organiserAck).not.toBe("cc-ali:in-group");
    expect(b.ownerDm).not.toBe(a.ownerDm);
    expect(b.organiserAck).not.toBe(a.organiserAck);
  });

  it("are the same for the same removal, so one add delivered twice cannot DM twice", () => {
    const removedAt = new Date("2026-10-11T11:55:00.000Z");
    expect(relinkRefIds("cc-ali", removedAt)).toEqual(relinkRefIds("cc-ali", new Date(removedAt.getTime())));
  });
});
