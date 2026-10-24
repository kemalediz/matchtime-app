import { describe, expect, it } from "vitest";
import {
  CLUB_INVITE_RULES,
  afterGameAskDue,
  invitationStep,
  invitationView,
  type InvitationFacts,
} from "../club-invitation-rules";

const T0 = new Date("2026-10-27T20:00:00Z");
const h = (n: number) => new Date(T0.getTime() + n * 3600_000);
const d = (n: number) => h(n * 24);

const open = (over: Partial<InvitationFacts> = {}): InvitationFacts => ({
  status: "open",
  origin: "after-game",
  clubYesAt: null,
  playerYesAt: null,
  declinedBy: null,
  closedAt: null,
  createdAt: T0,
  ...over,
});

describe("invitationStep: both yeses send the link, and only both", () => {
  it("after the game: his yes first asks the club; the club's yes then sends the link", () => {
    const a = invitationStep(open(), { kind: "player-yes", at: h(1) });
    expect(a).toEqual({ ok: true, patch: { playerYesAt: h(1) }, effects: ["tell-club-wants-join"] });
    const b = invitationStep(open({ playerYesAt: h(1) }), { kind: "club-yes", at: h(2), byUserId: "org1" });
    expect(b).toEqual({ ok: true, patch: { clubYesAt: h(2), clubYesById: "org1", status: "accepted", closedAt: h(2) }, effects: ["send-link"] });
  });

  it("the club first (Invite to club), then his yes sends the link", () => {
    const a = invitationStep(open(), { kind: "club-yes", at: h(1), byUserId: "org1" });
    expect(a).toEqual({ ok: true, patch: { clubYesAt: h(1), clubYesById: "org1" }, effects: [] });
    const b = invitationStep(open({ origin: "organiser", clubYesAt: h(1) }), { kind: "player-yes", at: h(3) });
    expect(b).toEqual({ ok: true, patch: { playerYesAt: h(3), status: "accepted", closedAt: h(3) }, effects: ["send-link"] });
  });

  it("his no closes it quietly; nobody is told", () => {
    expect(invitationStep(open(), { kind: "player-no", at: h(1) })).toEqual({
      ok: true,
      patch: { status: "declined", declinedBy: "player", closedAt: h(1) },
      effects: [],
    });
  });

  it("the club's no after his yes closes it and tells him kindly; before his yes, quietly", () => {
    expect(invitationStep(open({ playerYesAt: h(1) }), { kind: "club-no", at: h(2), byUserId: "org1" })).toEqual({
      ok: true,
      patch: { status: "declined", declinedBy: "club", closedAt: h(2), clubYesById: "org1" },
      effects: ["tell-guest-closed"],
    });
    expect(invitationStep(open(), { kind: "club-no", at: h(2), byUserId: "org1" })).toMatchObject({ ok: true, effects: [] });
  });

  it("the club silent: withdrawn after the days the club has to answer, he is told once", () => {
    const waiting = open({ playerYesAt: h(1) });
    expect(invitationStep(waiting, { kind: "club-silent", at: new Date(h(1).getTime() + CLUB_INVITE_RULES.clubAnswerDays * 86_400_000 - 1) })).toEqual({ ok: false, reason: "not-due" });
    const at = new Date(h(1).getTime() + CLUB_INVITE_RULES.clubAnswerDays * 86_400_000);
    expect(invitationStep(waiting, { kind: "club-silent", at })).toEqual({ ok: true, patch: { status: "withdrawn", closedAt: at }, effects: ["tell-guest-closed"] });
    // Nobody waiting on the club: an invitation he has not answered stays open.
    expect(invitationStep(open(), { kind: "club-silent", at: d(365) })).toEqual({ ok: false, reason: "not-due" });
    expect(invitationStep(open({ clubYesAt: h(1) }), { kind: "club-silent", at: d(365) })).toEqual({ ok: false, reason: "not-due" });
  });

  it("a closed invitation takes nothing; a repeated yes changes nothing", () => {
    for (const status of ["accepted", "declined", "withdrawn"] as const) {
      const closed = open({ status, closedAt: h(1), clubYesAt: h(1), playerYesAt: h(1), declinedBy: status === "declined" ? "player" : null });
      for (const kind of ["player-yes", "player-no", "club-yes", "club-no", "club-silent"] as const) {
        expect(invitationStep(closed, { kind, at: h(2), byUserId: "x" }), `${status} ${kind}`).toEqual({ ok: false, reason: "closed" });
      }
    }
    expect(invitationStep(open({ playerYesAt: h(1) }), { kind: "player-yes", at: h(2) })).toEqual({ ok: false, reason: "already-answered" });
    expect(invitationStep(open({ clubYesAt: h(1) }), { kind: "club-yes", at: h(2), byUserId: "x" })).toEqual({ ok: false, reason: "already-answered" });
  });
});

describe("afterGameAskDue: who is asked after a game, and when", () => {
  const base = {
    match: { kickoff: T0, durationMins: 60, status: "COMPLETED" as const },
    result: "played" as const,
    member: false,
    pool: "active" as const,
    hasPhone: true,
    askedBefore: false,
  };
  const end = h(1);
  const due = new Date(end.getTime() + CLUB_INVITE_RULES.afterGameDelayMins * 60_000);

  it("an hour after the game ends, a guest who played", () => {
    expect(afterGameAskDue({ ...base, now: new Date(due.getTime() - 1) })).toEqual({ due: false, why: "too-soon" });
    expect(afterGameAskDue({ ...base, now: due })).toEqual({ due: true });
    expect(afterGameAskDue({ ...base, match: { ...base.match, status: "UPCOMING" }, now: due })).toEqual({ due: true });
  });

  it("never late: a sweep that was down does not send a stale question", () => {
    const late = new Date(end.getTime() + CLUB_INVITE_RULES.afterGameWindowHours * 3600_000 + 1);
    expect(afterGameAskDue({ ...base, now: late })).toEqual({ due: false, why: "too-late" });
  });

  it("not for someone who did not play, is a member, stopped, deleted, has no number, or was asked before", () => {
    const now = due;
    expect(afterGameAskDue({ ...base, now, result: "no-show" })).toEqual({ due: false, why: "not-played" });
    expect(afterGameAskDue({ ...base, now, result: "withdrawn" })).toEqual({ due: false, why: "not-played" });
    expect(afterGameAskDue({ ...base, now, result: null })).toEqual({ due: false, why: "not-played" });
    expect(afterGameAskDue({ ...base, now, member: true })).toEqual({ due: false, why: "member" });
    expect(afterGameAskDue({ ...base, now, pool: "stopped" })).toEqual({ due: false, why: "stopped" });
    expect(afterGameAskDue({ ...base, now, pool: "deleted" })).toEqual({ due: false, why: "stopped" });
    expect(afterGameAskDue({ ...base, now, hasPhone: false })).toEqual({ due: false, why: "no-phone" });
    expect(afterGameAskDue({ ...base, now, askedBefore: true })).toEqual({ due: false, why: "asked-before" });
  });

  it("a partner club's guest (no pool profile) is asked too", () => {
    expect(afterGameAskDue({ ...base, pool: "none", now: due })).toEqual({ due: true });
  });
});

describe("invitationView: what the guest card shows", () => {
  it("an open invitation by who has said yes", () => {
    expect(invitationView([open()], T0)).toBe("asked");
    expect(invitationView([open({ clubYesAt: h(1) })], T0)).toBe("club-yes");
    expect(invitationView([open({ playerYesAt: h(1) })], T0)).toBe("player-yes");
  });

  it("his no thanks greys the button for a while, then it is back", () => {
    const declined = open({ status: "declined", declinedBy: "player", closedAt: T0 });
    expect(invitationView([declined], d(CLUB_INVITE_RULES.playerDeclineCooldownDays - 1))).toBe("declined");
    expect(invitationView([declined], d(CLUB_INVITE_RULES.playerDeclineCooldownDays))).toBe("none");
    expect(invitationView([open({ status: "declined", declinedBy: "club", closedAt: T0 })], d(1))).toBe("none");
    expect(invitationView([], T0)).toBe("none");
  });

  it("both said yes: the link went, waiting for him to join (for a while)", () => {
    const accepted = open({ status: "accepted", clubYesAt: T0, playerYesAt: T0, closedAt: T0 });
    expect(invitationView([accepted], d(CLUB_INVITE_RULES.linkSentShownDays - 1))).toBe("accepted");
    expect(invitationView([accepted], d(CLUB_INVITE_RULES.linkSentShownDays))).toBe("none");
    // An open one wins over an older accepted one.
    expect(invitationView([accepted, open({ clubYesAt: d(1) })], d(2))).toBe("club-yes");
  });
});
