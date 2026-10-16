/**
 * Asking a partner club for a player, the pure rules (slice S2).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.4 and
 * 3.13, decisions D4, D8 and D12 (the 4-hour cut-off, Kemal 2026-10-16).
 */
import { describe, expect, it } from "vitest";
import {
  movedWindows,
  PARTNER_ASKS_PER_DAY,
  askWindows,
  canAsk,
  closeReason,
  closeTells,
  closedStatus,
  isOpenAskStatus,
  partnerReachable,
  type CanAskInput,
  type CloseInput,
  type PartnerGateInput,
} from "../partner-ask-rules";

const KICKOFF = new Date("2026-10-16T19:30:00Z"); // Fri 20:30 London (BST)
const H = 3600_000;
const { postBy, closesAt } = askWindows(KICKOFF, 4);

const base = (over: Partial<CanAskInput> = {}): CanAskInput => ({
  partnershipStatus: "active",
  askWhen: "on-request",
  via: "button",
  requesterRole: "ADMIN",
  isNextMatch: true,
  matchStatus: "UPCOMING",
  matchHistorical: false,
  placesOpen: 1,
  now: new Date(KICKOFF.getTime() - 6 * H),
  postBy,
  openAskForPair: false,
  partnerAsksToday: 0,
  ...over,
});

describe("the cut-off (Kemal, 2026-10-16)", () => {
  it("the last ask goes out 4 hours before kickoff by default; a posted ask closes at kickoff", () => {
    expect(postBy.toISOString()).toBe("2026-10-16T15:30:00.000Z");
    expect(closesAt.getTime()).toBe(KICKOFF.getTime());
  });
  it("the club's own number of hours", () => {
    expect(askWindows(KICKOFF, 1).postBy.getTime()).toBe(KICKOFF.getTime() - H);
    expect(askWindows(KICKOFF, 24).postBy.getTime()).toBe(KICKOFF.getTime() - 24 * H);
  });
  it("one minute before the cut-off may ask; at it, too late", () => {
    expect(canAsk(base({ now: new Date(postBy.getTime() - 60_000) }))).toEqual({ ok: true });
    expect(canAsk(base({ now: postBy }))).toEqual({ ok: false, refusal: "too-late" });
  });
});

describe("canAsk", () => {
  it("an organiser of an active pairing, the next game, a place open: yes", () => {
    expect(canAsk(base())).toEqual({ ok: true });
    expect(canAsk(base({ requesterRole: "OWNER", askWhen: "auto" }))).toEqual({ ok: true });
  });
  it("the pairing must be active", () => {
    for (const s of ["proposed", "paused", "ended"]) expect(canAsk(base({ partnershipStatus: s }))).toEqual({ ok: false, refusal: "partnership-inactive" });
  });
  it("the asking setting Off refuses everything; the automatic ask needs Automatically", () => {
    expect(canAsk(base({ askWhen: "off" }))).toEqual({ ok: false, refusal: "asking-off" });
    expect(canAsk(base({ via: "auto", requesterRole: null, askWhen: "on-request" }))).toEqual({ ok: false, refusal: "asking-off" });
    expect(canAsk(base({ via: "auto", requesterRole: null, askWhen: "auto" }))).toEqual({ ok: true });
  });
  it("a PLAYER cannot ask", () => {
    expect(canAsk(base({ requesterRole: "PLAYER" }))).toEqual({ ok: false, refusal: "not-admin" });
    expect(canAsk(base({ requesterRole: null }))).toEqual({ ok: false, refusal: "not-admin" });
  });
  it("only the club's next live match, with a place open", () => {
    expect(canAsk(base({ isNextMatch: false }))).toEqual({ ok: false, refusal: "not-next-match" });
    expect(canAsk(base({ matchStatus: "CANCELLED" }))).toEqual({ ok: false, refusal: "match-not-open" });
    expect(canAsk(base({ matchStatus: "COMPLETED" }))).toEqual({ ok: false, refusal: "match-not-open" });
    expect(canAsk(base({ matchHistorical: true }))).toEqual({ ok: false, refusal: "match-not-open" });
    expect(canAsk(base({ placesOpen: 0 }))).toEqual({ ok: false, refusal: "no-places" });
  });
  it("one open ask per match and partner, and two a day into one partner group", () => {
    expect(PARTNER_ASKS_PER_DAY).toBe(2);
    expect(canAsk(base({ openAskForPair: true }))).toEqual({ ok: false, refusal: "already-open" });
    expect(canAsk(base({ partnerAsksToday: 1 }))).toEqual({ ok: true });
    expect(canAsk(base({ partnerAsksToday: 2 }))).toEqual({ ok: false, refusal: "daily-cap" });
  });
});

describe("partnerReachable", () => {
  const gate = (over: Partial<PartnerGateInput> = {}): PartnerGateInput => ({
    whatsappGroupId: "sutton@g.us",
    whatsappBotEnabled: true,
    dormantAt: null,
    approved: true,
    billingPaused: false,
    settingUp: false,
    groupPostable: true,
    ...over,
  });
  it("a live, approved, postable club: reachable", () => {
    expect(partnerReachable(gate())).toBeNull();
  });
  it("each gate refuses with its own reason", () => {
    expect(partnerReachable(gate({ approved: false }))).toBe("partner-not-approved");
    expect(partnerReachable(gate({ dormantAt: new Date() }))).toBe("partner-dormant");
    expect(partnerReachable(gate({ billingPaused: true }))).toBe("partner-paused");
    expect(partnerReachable(gate({ settingUp: true }))).toBe("partner-setting-up");
    expect(partnerReachable(gate({ whatsappGroupId: null }))).toBe("partner-no-group");
    expect(partnerReachable(gate({ whatsappBotEnabled: false }))).toBe("partner-muted");
    expect(partnerReachable(gate({ groupPostable: false }))).toBe("partner-not-postable");
  });
});

describe("closing an ask", () => {
  const c = (over: Partial<CloseInput> = {}): CloseInput => ({
    status: "posted",
    now: new Date(KICKOFF.getTime() - 2 * H),
    postBy,
    closesAt,
    matchDate: KICKOFF,
    matchStatus: "UPCOMING",
    partnershipStatus: "active",
    placesOpen: 1,
    ...over,
  });

  it("an open posted ask with a place still open stays open until kickoff", () => {
    expect(closeReason(c())).toBeNull();
    expect(closeReason(c({ now: KICKOFF }))).toBe("kickoff");
  });
  it("a closed ask is never closed again", () => {
    for (const s of ["filled", "expired", "cancelled", "declined", "refused"]) expect(closeReason(c({ status: s, placesOpen: 0 }))).toBeNull();
    expect(isOpenAskStatus("posted")).toBe(true);
    expect(isOpenAskStatus("filled")).toBe(false);
  });
  it("filled by any route, the club's own player included", () => {
    expect(closeReason(c({ placesOpen: 0 }))).toBe("filled");
    expect(closedStatus("filled", "posted")).toBe("filled");
    expect(closedStatus("filled", "awaiting-approval")).toBe("cancelled");
  });
  it("an approval still waiting at the cut-off expires", () => {
    expect(closeReason(c({ status: "awaiting-approval", now: postBy }))).toBe("approval-expired");
    expect(closeReason(c({ status: "awaiting-approval", now: new Date(postBy.getTime() - 1) }))).toBeNull();
    // A posted ask is not touched by the cut-off.
    expect(closeReason(c({ status: "posted", now: postBy }))).toBeNull();
    expect(closedStatus("approval-expired", "awaiting-approval")).toBe("expired");
  });
  it("cancelled, moved, or the pairing paused: cancelled", () => {
    expect(closeReason(c({ matchStatus: "CANCELLED" }))).toBe("match-cancelled");
    // H3 (review): a MOVED game does not close the ask; its windows follow
    // the new kickoff (`movedWindows`), so nobody is told the game is off.
    expect(closeReason(c({ matchDate: new Date(KICKOFF.getTime() + H) }))).toBeNull();
    expect(closeReason(c({ partnershipStatus: "paused" }))).toBe("partnership-inactive");
    expect(closedStatus("match-cancelled", "posted")).toBe("cancelled");
    expect(closedStatus("partnership-inactive", "posted")).toBe("cancelled");
  });
  it("who is told (D8): the partner group only about a post it saw, once", () => {
    expect(closeTells("filled", "posted", 1)).toEqual({ partnerGroup: "filled", asker: null });
    expect(closeTells("filled", "awaiting-approval", 0)).toEqual({ partnerGroup: null, asker: null });
    expect(closeTells("match-cancelled", "posted", 0)).toEqual({ partnerGroup: "off", asker: null });
    expect(closeTells("kickoff", "posted", 0)).toEqual({ partnerGroup: null, asker: "nobody" });
    expect(closeTells("kickoff", "posted", 2)).toEqual({ partnerGroup: null, asker: null });
    expect(closeTells("approval-expired", "awaiting-approval", 0)).toEqual({ partnerGroup: null, asker: "expired-approval" });
  });
});

describe("H3 (review): a moved game", () => {
  it("the ask follows the new kickoff: new cut-off and close, same hours", () => {
    const moved = new Date(KICKOFF.getTime() + 2 * H);
    expect(movedWindows({ closesAt: KICKOFF, matchDate: moved, cutoffHours: 4 })).toEqual({
      postBy: new Date(moved.getTime() - 4 * H),
      closesAt: moved,
    });
  });
  it("not moved: nothing to change", () => {
    expect(movedWindows({ closesAt: KICKOFF, matchDate: KICKOFF, cutoffHours: 4 })).toBeNull();
  });
});
