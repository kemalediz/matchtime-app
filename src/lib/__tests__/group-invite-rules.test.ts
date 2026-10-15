/**
 * Who may have a WhatsApp group invite accepted by MatchTime (2026-10-15).
 *
 * WhatsApp refuses to let a stranger add MatchTime to a group and offers
 * "Invite to group" instead. MatchTime joins by itself ONLY for the
 * organiser of an open, DM-verified connect request on a draft club,
 * matched by phone or by the connect DM's LID, exactly the proof a group
 * add uses (group-add-rules.ts).
 */
import { describe, expect, it } from "vitest";
import { decideInviteAccept, inviteSenderFrom, type InviteCandidate } from "../group-invite-rules";

const NOW = new Date("2026-10-15T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function cand(over: Partial<InviteCandidate> = {}): InviteCandidate {
  return {
    id: "cc1",
    status: "dm_verified",
    phone: "447700900123",
    dmLid: "123456789012",
    issuedAt: new Date(NOW.getTime() - 2 * HOUR),
    expiresAt: new Date(NOW.getTime() - HOUR),
    addWindowEndsAt: new Date(NOW.getTime() + 20 * HOUR),
    orgApprovalStatus: "draft",
    ...over,
  };
}

describe("decideInviteAccept", () => {
  it("accepts the organiser matched by phone", () => {
    const d = decideInviteAccept({ phones: ["447700900123"], lid: null }, [cand()], NOW);
    expect(d).toEqual({ accept: true, connectId: "cc1", match: "phone" });
  });

  it("accepts the organiser matched by the connect DM's LID when the phone is hidden", () => {
    const d = decideInviteAccept({ phones: [], lid: "123456789012" }, [cand()], NOW);
    expect(d).toEqual({ accept: true, connectId: "cc1", match: "lid" });
  });

  it("matches the envelope's alternate phone too", () => {
    const d = decideInviteAccept({ phones: ["447700900999", "447700900123"], lid: null }, [cand()], NOW);
    expect(d).toMatchObject({ accept: true, match: "phone" });
  });

  it("refuses a stranger", () => {
    const d = decideInviteAccept({ phones: ["447700900999"], lid: "999999999999" }, [cand()], NOW);
    expect(d).toEqual({ accept: false, reason: "not-organiser" });
  });

  it("refuses a sender with no identity at all", () => {
    expect(decideInviteAccept({ phones: [], lid: null }, [cand()], NOW)).toEqual({
      accept: false,
      reason: "no-identity",
    });
  });

  it("refuses when no request is open", () => {
    expect(decideInviteAccept({ phones: ["447700900123"], lid: null }, [], NOW)).toEqual({
      accept: false,
      reason: "no-open-request",
    });
  });

  it("refuses once the add window has closed", () => {
    const d = decideInviteAccept(
      { phones: ["447700900123"], lid: null },
      [cand({ addWindowEndsAt: new Date(NOW.getTime() - 1) })],
      NOW,
    );
    expect(d).toEqual({ accept: false, reason: "no-open-request" });
  });

  it("refuses a request that is only issued (the connect DM never came)", () => {
    const d = decideInviteAccept(
      { phones: ["447700900123"], lid: null },
      [cand({ status: "issued", expiresAt: new Date(NOW.getTime() + HOUR), addWindowEndsAt: null })],
      NOW,
    );
    expect(d).toEqual({ accept: false, reason: "no-open-request" });
  });

  it("refuses when the club is no longer a draft", () => {
    for (const s of ["pending", "approved", "rejected", "suspended"]) {
      const d = decideInviteAccept({ phones: ["447700900123"], lid: null }, [cand({ orgApprovalStatus: s })], NOW);
      expect(d).toEqual({ accept: false, reason: "no-open-request" });
    }
  });

  it("refuses an already linked request", () => {
    const d = decideInviteAccept({ phones: ["447700900123"], lid: null }, [cand({ status: "group_linked" })], NOW);
    expect(d).toEqual({ accept: false, reason: "no-open-request" });
  });

  it("never treats a LID as a phone, or a request without a DM LID as LID-matched", () => {
    const d = decideInviteAccept({ phones: [], lid: "123456789012" }, [cand({ dmLid: null })], NOW);
    expect(d).toEqual({ accept: false, reason: "not-organiser" });
  });

  it("picks the newest matching request", () => {
    const older = cand({ id: "old", issuedAt: new Date(NOW.getTime() - 5 * HOUR) });
    const newer = cand({ id: "new", issuedAt: new Date(NOW.getTime() - HOUR) });
    const d = decideInviteAccept({ phones: ["447700900123"], lid: null }, [older, newer], NOW);
    expect(d).toMatchObject({ accept: true, connectId: "new" });
  });
});

describe("inviteSenderFrom", () => {
  it("reads phones and the LID defensively", () => {
    expect(
      inviteSenderFrom({ phone: "+44 7700 900123", senderAltPhone: "447700900123", senderLid: "123456789012@lid" }),
    ).toEqual({ phones: ["447700900123"], lid: "123456789012" });
  });

  it("drops junk", () => {
    expect(inviteSenderFrom({ phone: 12, senderAltPhone: "abc", senderLid: "447700900123@c.us" })).toEqual({
      phones: [],
      lid: null,
    });
  });
});
