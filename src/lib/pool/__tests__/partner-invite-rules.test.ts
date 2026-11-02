import { describe, expect, it } from "vitest";
import { CLUB_INVITE_RULES } from "../club-invitation-rules";
import { partnerInviteDue, partnerInviteKey, partnerInvitePageState, partnerInviteSendAfter } from "../partner-invite-rules";

const H = 3600_000;
const KICKOFF = new Date("2026-11-03T19:00:00Z");
/** An hour's game: ends 20:00 UTC. */
const END = KICKOFF.getTime() + H;

const base = {
  match: { kickoff: KICKOFF, durationMins: 60, status: "COMPLETED" },
  picked: true,
  result: "played" as const,
  hasProfile: false,
  everInPool: false,
  hasPhone: true,
  sentBefore: false,
  now: new Date(END + 2 * H),
};

describe("who gets the partner pool invite, and when", () => {
  it("a partner player picked for the game, who played it: due", () => {
    expect(partnerInviteDue(base)).toEqual({ due: true });
  });

  it("a volunteer who was not picked gets nothing", () => {
    expect(partnerInviteDue({ ...base, picked: false })).toEqual({ due: false, why: "not-picked" });
  });

  it("only a COMPLETED game: not a cancelled one, nor one still to finish", () => {
    expect(partnerInviteDue({ ...base, match: { ...base.match, status: "CANCELLED" } })).toEqual({ due: false, why: "not-completed" });
    expect(partnerInviteDue({ ...base, match: { ...base.match, status: "TEAMS_PUBLISHED" } })).toEqual({ due: false, why: "not-completed" });
  });

  it("only one who PLAYED it (the settled guest result): not a no-show, a late cancel, a bench place, a result still due", () => {
    for (const result of ["no-show", "late-cancel", "withdrawn", "booked", null] as const) {
      expect(partnerInviteDue({ ...base, result })).toEqual({ due: false, why: "not-played" });
    }
  });

  it("anyone with a pool profile, in any state, is skipped; so is anyone who was in the pool and deleted it", () => {
    expect(partnerInviteDue({ ...base, hasProfile: true })).toEqual({ due: false, why: "in-pool" });
    expect(partnerInviteDue({ ...base, everInPool: true })).toEqual({ due: false, why: "was-in-pool" });
  });

  it("once per person ever: sent before (whatever he did with it) means never again", () => {
    expect(partnerInviteDue({ ...base, sentBefore: true })).toEqual({ due: false, why: "sent-before" });
  });

  it("no phone, no DM", () => {
    expect(partnerInviteDue({ ...base, hasPhone: false })).toEqual({ due: false, why: "no-phone" });
  });

  it("the after-game timing of the club invitation: from an hour after the game ends, never once it is stale", () => {
    const delay = CLUB_INVITE_RULES.afterGameDelayMins * 60_000;
    const window = CLUB_INVITE_RULES.afterGameWindowHours * H;
    expect(partnerInviteDue({ ...base, now: new Date(END + delay - 1) })).toEqual({ due: false, why: "too-soon" });
    expect(partnerInviteDue({ ...base, now: new Date(END + delay) })).toEqual({ due: true });
    expect(partnerInviteDue({ ...base, now: new Date(END + window) })).toEqual({ due: true });
    expect(partnerInviteDue({ ...base, now: new Date(END + window + 1) })).toEqual({ due: false, why: "too-late" });
  });

  it("the once-ever key names the person only, never the match", () => {
    expect(partnerInviteKey("cluser1")).toBe("pool-partner-invite:cluser1");
  });
});

describe("the DM waits for the end of his own club's quiet hours", () => {
  const on = { enabled: true, from: "23:00", to: "09:00" };
  it("outside them: at once", () => {
    expect(partnerInviteSendAfter(new Date("2026-11-04T14:00:00Z"), on)).toBeNull();
  });
  it("inside them: when they end (London)", () => {
    expect(partnerInviteSendAfter(new Date("2026-11-04T23:30:00Z"), on)).toEqual(new Date("2026-11-05T09:00:00Z"));
  });
  it("his club has them off: at once", () => {
    expect(partnerInviteSendAfter(new Date("2026-11-04T23:30:00Z"), { ...on, enabled: false })).toBeNull();
  });
});

describe("what the join page shows", () => {
  const ok = { token: "ok" as const, user: { hasPhone: true }, profile: null, signupsPaused: false };
  it("a good link, no profile: the form", () => {
    expect(partnerInvitePageState(ok)).toBe("join");
    expect(partnerInvitePageState({ ...ok, profile: { status: "pending-verify" } })).toBe("join");
  });
  it("a link that is not ours, or names nobody we know (or nobody with a number): invalid", () => {
    expect(partnerInvitePageState({ ...ok, token: "invalid" })).toBe("invalid");
    expect(partnerInvitePageState({ ...ok, user: null })).toBe("invalid");
    expect(partnerInvitePageState({ ...ok, user: { hasPhone: false } })).toBe("invalid");
  });
  it("a link that ran out: expired, before anything about him is read", () => {
    expect(partnerInvitePageState({ ...ok, token: "expired", user: null })).toBe("expired");
  });
  it("already in the pool (active or paused): the done state", () => {
    expect(partnerInvitePageState({ ...ok, profile: { status: "active" } })).toBe("member");
    expect(partnerInvitePageState({ ...ok, profile: { status: "paused" } })).toBe("member");
  });
  it("a stopped profile: start again in place", () => {
    expect(partnerInvitePageState({ ...ok, profile: { status: "stopped" } })).toBe("stopped");
  });
  it("sign-ups paused: no form, but a member still sees he is in", () => {
    expect(partnerInvitePageState({ ...ok, signupsPaused: true })).toBe("paused");
    expect(partnerInvitePageState({ ...ok, signupsPaused: true, profile: { status: "active" } })).toBe("member");
  });
});
