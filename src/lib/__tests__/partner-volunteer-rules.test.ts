/**
 * Who may volunteer for a partner club's ask (slice S3, plan 3.6).
 */
import { describe, expect, it } from "vitest";
import { decideVolunteer, type VolunteerInput } from "../partner-volunteer-rules";

const base = (over: Partial<VolunteerInput> = {}): VolunteerInput => ({
  polarity: "in",
  askOpen: true,
  senderIsPartnerMember: true,
  inOverlappingOwnGame: false,
  ordinaryAskerMember: false,
  onAskerMatch: false,
  ...over,
});

describe("decideVolunteer", () => {
  it("a partner member replying IN to an open ask becomes a guest on the asking club's match", () => {
    expect(decideVolunteer(base())).toEqual({ kind: "register", asGuest: true });
  });
  it("already an ordinary member of the asking club: an ordinary IN, no guest mark", () => {
    expect(decideVolunteer(base({ ordinaryAskerMember: true }))).toEqual({ kind: "register", asGuest: false });
  });
  it("an unknown sender is never signed up through an ask", () => {
    expect(decideVolunteer(base({ senderIsPartnerMember: false }))).toEqual({ kind: "refuse", why: "unknown-sender" });
    expect(decideVolunteer(base({ senderIsPartnerMember: false, polarity: "out" }))).toEqual({ kind: "refuse", why: "unknown-sender" });
  });
  it("a closed ask takes nobody", () => {
    expect(decideVolunteer(base({ askOpen: false }))).toEqual({ kind: "refuse", why: "closed" });
  });
  it("in his own club's game at an overlapping time: refused", () => {
    expect(decideVolunteer(base({ inOverlappingOwnGame: true }))).toEqual({ kind: "refuse", why: "overlap" });
  });
  it("OUT takes him off if he is on, even after the ask closed (he may have been picked)", () => {
    expect(decideVolunteer(base({ polarity: "out", onAskerMatch: true, askOpen: false }))).toEqual({ kind: "withdraw" });
    expect(decideVolunteer(base({ polarity: "out" }))).toEqual({ kind: "refuse", why: "not-on-list" });
  });
});
